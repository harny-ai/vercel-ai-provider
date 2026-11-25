import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import { createHarny, HarnyAPIError } from '../src/index.js';
import { fakeApi, json, mockModel, NADIA_PROMPT } from './helpers.js';

const REFUSAL = { code: 'user-not-found-in-app', status: 404, debugMessage: 'No such user in this app.', data: null };

/** A fake service where a person must be created with POST /v1/users before any memory call works. */
function strictApi(options: { createFails?: boolean } = {}) {
  const api = fakeApi();
  const created = new Set<string>();
  const guard = (fallback: (req: any) => Response) => (req: any) => {
    const who = req.headers['x-harny-user'];
    return who && !created.has(who) ? json(REFUSAL, 404) : fallback(req);
  };
  const okIngest = (req: any) =>
    json({ projectId: 'app-1', ingestionId: 'ing-1', sourceId: req.body?.id ?? 'sha', status: 'queued' }, 202);
  const okRecall = () =>
    json({ asOf: 'x', usedEvidenceTokens: 1, results: [{ id: 'm-1', rank: 1, content: 'Acme budget is 40k.', sources: [] }] });
  api.reply('POST /v1/memory/ingest', guard(okIngest));
  api.reply('POST /v1/memory/recall', guard(okRecall));
  api.reply('POST /v1/users', (req) => {
    if (options.createFails) return json({ code: 'forbidden', status: 403, debugMessage: 'no', data: null }, 403);
    created.add(req.body.identifier);
    return json({ identifier: req.body.identifier }, 201);
  });
  return api;
}
const usersCalls = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.path === '/v1/users');

describe('a new person needs no setup', () => {
  it('recall for a new user creates the user once and returns results', async () => {
    const api = strictApi();
    const harny = createHarny({ apiKey: 'fsa_app', fetch: api.fetch });
    const answer = await harny.recall({ query: 'budget?', user: 'new-1' });
    expect(answer.results[0]?.content).toBe('Acme budget is 40k.');
    const made = usersCalls(api);
    expect(made).toHaveLength(1);
    expect(made[0]!.body).toEqual({ identifier: 'new-1', identifier_type: 'app_id' });
    expect(made[0]!.headers.authorization).toBe('Bearer fsa_app');
    expect(made[0]!.headers['x-harny-user']).toBeUndefined();
  });

  it('ingest for a new user creates the user and stores', async () => {
    const api = strictApi();
    const harny = createHarny({ apiKey: 'fsa_app', fetch: api.fetch });
    const receipt = await harny.ingest({ content: 'Dana likes tea.', user: 'new-2' });
    expect(receipt.status).toBe('queued');
    expect(usersCalls(api)).toHaveLength(1);
    expect(api.calls.filter((c) => c.path === '/v1/memory/ingest')).toHaveLength(2);
  });

  it('creates the user once however many calls follow, including parallel ones', async () => {
    const api = strictApi();
    const harny = createHarny({ apiKey: 'fsa_app', user: 'new-3', fetch: api.fetch });
    await Promise.all([harny.recall({ query: 'a' }), harny.recall({ query: 'b' }), harny.ingest({ content: 'c' })]);
    await harny.recall({ query: 'd' });
    await harny.ingest({ content: 'e' });
    expect(usersCalls(api)).toHaveLength(1);
  });

  it('works through the tools', async () => {
    const api = strictApi();
    const harny = createHarny({ apiKey: 'fsa_app', user: 'new-4', fetch: api.fetch });
    const tools = harny.tools();
    const ctx = { toolCallId: 't', messages: [] } as never;
    await tools.harny_remember.execute!({ content: 'Likes tea.' }, ctx);
    const out = (await tools.harny_recall.execute!({ query: 'tea?' }, ctx)) as any;
    expect(JSON.stringify(out)).toContain('40k');
    expect(usersCalls(api)).toHaveLength(1);
  });

  it('the middleware recalls and saves for a new user with one create', async () => {
    const api = strictApi();
    const harny = createHarny({ apiKey: 'fsa_app', fetch: api.fetch });
    const errors: unknown[] = [];
    const model = mockModel();
    await generateText({
      model: harny(model, { user: 'new-5', saveUserMessages: true, onError: (e) => errors.push(e) }),
      prompt: NADIA_PROMPT,
    });
    expect(errors).toEqual([]);
    expect(usersCalls(api)).toHaveLength(1);
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain('Acme budget is 40k.');
    expect(api.calls.some((c) => c.path === '/v1/memory/ingest' && c.body.label === 'User message')).toBe(true);
  });

  it("a person's own key (fsk_) never calls /v1/users", async () => {
    const api = strictApi();
    api.reply('POST /v1/memory/recall', json(REFUSAL, 404));
    const harny = createHarny({ apiKey: 'fsk_person', user: 'new-6', fetch: api.fetch });
    await expect(harny.recall({ query: 'x' })).rejects.toMatchObject({ code: 'user-not-found-in-app' });
    expect(usersCalls(api)).toHaveLength(0);
  });

  it('other refusals do not create anyone', async () => {
    const api = strictApi();
    api.reply('POST /v1/memory/recall', json({ code: 'rate-limited', status: 429, debugMessage: 'slow', data: null }, 429));
    const harny = createHarny({ apiKey: 'fsa_app', user: 'new-7', fetch: api.fetch });
    await expect(harny.recall({ query: 'x' })).rejects.toBeInstanceOf(HarnyAPIError);
    expect(usersCalls(api)).toHaveLength(0);
  });

  it('a failing create surfaces the original error to onError with its stage, and the model call still runs', async () => {
    const api = strictApi({ createFails: true });
    const harny = createHarny({ apiKey: 'fsa_app', fetch: api.fetch });
    const seen: { code: string; stage: string }[] = [];
    const model = mockModel();
    const result = await generateText({
      model: harny(model, {
        user: 'new-8',
        saveUserMessages: true,
        onError: (e, { stage }) => seen.push({ code: (e as HarnyAPIError).code, stage }),
      }),
      prompt: NADIA_PROMPT,
    });
    expect(result.text).toBe('It is 40k.');
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(seen).toEqual([
      { code: 'user-not-found-in-app', stage: 'recall' },
      { code: 'user-not-found-in-app', stage: 'ingest' },
    ]);
  });

  it('a failing create throws the original error from a direct call', async () => {
    const api = strictApi({ createFails: true });
    const harny = createHarny({ apiKey: 'fsa_app', user: 'new-9', fetch: api.fetch });
    await expect(harny.ingest({ content: 'x' })).rejects.toMatchObject({ code: 'user-not-found-in-app', status: 404 });
  });
});
