import { generateText, streamText, wrapLanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createHarny, createMemoryMiddleware, HarnyClient } from '../src/index.js';
import { fakeApi, json, mockModel, NADIA_PROMPT, RECALL_OK, USAGE } from './helpers.js';

// Saving the person's messages is off by default. `setup()` switches it on for the tests that check what is saved;
// `setupDefault()` is the package as shipped.
const setupDefault = (extra: Record<string, unknown> = {}) => {
  const api = fakeApi();
  const harny = createHarny({ apiKey: 'fsa_app', user: 'nadia', fetch: api.fetch, ...extra });
  return { api, harny, model: mockModel() };
};
const setup = (extra: Record<string, unknown> = {}) => {
  const base = setupDefault(extra);
  const raw = base.harny;
  type Settings = NonNullable<Parameters<typeof raw>[1]>;
  const withSave = (settings: Settings = {}): Settings => ({ saveUserMessages: true, ...settings });
  const harny = Object.assign((model: Parameters<typeof raw>[0], settings?: Settings) => raw(model, withSave(settings)), raw, {
    middleware: (settings?: Parameters<typeof raw.middleware>[0]) => raw.middleware(withSave(settings as Settings)),
  });
  return { ...base, harny };
};
const paths = (api: ReturnType<typeof fakeApi>) => api.calls.map((c) => `${c.method} ${c.path}`);

describe('recall before the call', () => {
  it('injects recalled memories as a system message and leaves the user message alone', async () => {
    const { api, harny, model } = setup();
    const result = await generateText({ model: harny(model), prompt: NADIA_PROMPT });
    expect(result.text).toBe('It is 40k.');
    const prompt = model.doGenerateCalls[0]!.prompt;
    expect(prompt[0]).toMatchObject({ role: 'system' });
    expect(String((prompt[0] as { content: string }).content)).toContain('Acme pilot budget: currently 40k. (2026-03-01)');
    expect(String((prompt[0] as { content: string }).content)).toContain('- The Acme pilot ships March 14.');
    expect(prompt[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: NADIA_PROMPT }] });
    const recall = api.calls.find((c) => c.path === '/v1/memory/recall')!;
    expect(recall.body).toEqual({ query: NADIA_PROMPT, identity: 'nadia', level: 'low', limit: 20 });
    expect(recall.headers['x-harny-user']).toBe('nadia');
  });

  it('appends to an existing system prompt instead of adding a second one', async () => {
    const { harny, model } = setup();
    await generateText({ model: harny(model), system: 'You are a sales assistant.', prompt: NADIA_PROMPT });
    const prompt = model.doGenerateCalls[0]!.prompt;
    expect(prompt.filter((m) => m.role === 'system')).toHaveLength(1);
    const content = String((prompt[0] as { content: string }).content);
    expect(content.startsWith('You are a sales assistant.')).toBe(true);
    expect(content).toContain('40k');
  });

  it('changes nothing when memory has nothing to say', async () => {
    const { api, harny, model } = setup();
    api.reply('POST /v1/memory/recall', json({ asOf: 'x', usedEvidenceTokens: 0, results: [] }));
    await generateText({ model: harny(model), prompt: NADIA_PROMPT });
    expect(model.doGenerateCalls[0]!.prompt).toHaveLength(1);
    expect(model.doGenerateCalls[0]!.prompt[0]).toMatchObject({ role: 'user' });
  });

  it('honours level, maxTokens, limit and the heading', async () => {
    const { api, harny, model } = setup();
    await generateText({
      model: harny(model, { level: 'high', limit: 3, heading: 'Known facts:' }),
      prompt: NADIA_PROMPT,
    });
    expect(api.calls[0]!.body).toMatchObject({ level: 'high', limit: 3 });
    expect(String((model.doGenerateCalls[0]!.prompt[0] as { content: string }).content).startsWith('Known facts:')).toBe(true);
    const second = setup();
    await generateText({ model: second.harny(second.model, { maxTokens: 1024 }), prompt: NADIA_PROMPT });
    expect(second.api.calls[0]!.body).toMatchObject({ maxTokens: 1024 });
    expect(second.api.calls[0]!.body.level).toBeUndefined();
  });

  it('skips recall with recall: false and still stores', async () => {
    const { api, harny, model } = setup();
    await generateText({ model: harny(model, { recall: false }), prompt: NADIA_PROMPT });
    expect(paths(api)).toEqual(['POST /v1/memory/ingest']);
  });

  it('reports sends that are still being processed through onPending', async () => {
    const { api, harny, model } = setup();
    const pending = { ingestions: 1, dataPoints: 2, since: '2026-03-02T00:00:00Z', message: 'Two facts are still being processed.' };
    api.reply('POST /v1/memory/recall', json({ ...RECALL_OK, pending }));
    const onPending = vi.fn();
    await generateText({ model: harny(model, { onPending }), prompt: NADIA_PROMPT });
    expect(onPending).toHaveBeenCalledWith(pending);
  });

  it('lets you replace the injected text', async () => {
    const { harny, model } = setup();
    await generateText({
      model: harny(model, { formatMemories: (results) => `FACTS=${results.length}` }),
      prompt: NADIA_PROMPT,
    });
    expect((model.doGenerateCalls[0]!.prompt[0] as { content: string }).content).toBe('FACTS=2');
  });

  it('works through streamText', async () => {
    const { api, harny, model } = setup();
    const result = streamText({ model: harny(model), prompt: NADIA_PROMPT });
    expect(await result.text).toBe('It is 40k.');
    expect(paths(api)).toEqual(['POST /v1/memory/recall', 'POST /v1/memory/ingest']);
    expect(model.doStreamCalls[0]!.prompt[0]).toMatchObject({ role: 'system' });
  });
});

describe('storing the person’s message', () => {
  it('stores the user message, with a hashed id, a label and a timestamp', async () => {
    const { api, harny, model } = setup();
    await generateText({ model: harny(model), prompt: NADIA_PROMPT });
    const ingest = api.calls.find((c) => c.path === '/v1/memory/ingest')!;
    expect(ingest.body.content).toBe(NADIA_PROMPT);
    expect(ingest.body.id).toMatch(/^turn-[0-9a-f]{64}$/);
    expect(ingest.body.label).toBe('User message');
    expect(Number.isNaN(Date.parse(ingest.body.timestamp))).toBe(false);
    expect(ingest.headers['x-harny-user']).toBe('nadia');
  });

  it('gives the same id to the same text in the same conversation', async () => {
    const { api, harny, model } = setup();
    await generateText({ model: harny(model, { conversationId: 'c1' }), prompt: NADIA_PROMPT });
    await generateText({ model: harny(model, { conversationId: 'c1' }), prompt: NADIA_PROMPT });
    await generateText({ model: harny(model, { conversationId: 'c2' }), prompt: NADIA_PROMPT });
    const ids = api.calls.filter((c) => c.path === '/v1/memory/ingest').map((c) => c.body.id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('never stores assistant text, system text or tool results', async () => {
    const { api, harny, model } = setup();
    await generateText({
      model: harny(model),
      system: 'SECRET-SYSTEM',
      messages: [
        { role: 'user', content: 'My name is Nadia.' },
        { role: 'assistant', content: 'ASSISTANT-LINE Nice to meet you.' },
        { role: 'user', content: 'Remember the pilot ships March 14.' },
      ],
    });
    const stored = api.calls.filter((c) => c.path === '/v1/memory/ingest').map((c) => c.body.content);
    expect(stored).toEqual(['Remember the pilot ships March 14.']);
    expect(JSON.stringify(api.calls.map((c) => c.body)).includes('ASSISTANT-LINE')).toBe(false);
    expect(JSON.stringify(api.calls.filter((c) => c.path === '/v1/memory/ingest')).includes('SECRET-SYSTEM')).toBe(false);
  });

  it('stores each trailing user message once, text parts only', async () => {
    const { api, harny, model } = setup();
    await generateText({
      model: harny(model),
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'First part.' }, { type: 'text', text: 'Second part.' }] },
      ],
    });
    const stored = api.calls.filter((c) => c.path === '/v1/memory/ingest').map((c) => c.body.content);
    expect(stored).toEqual(['First part.\nSecond part.']);
  });

  it('is off by default: the person\u2019s message is not stored unless saveUserMessages is true', async () => {
    const { api, harny, model } = setupDefault();
    await generateText({ model: harny(model), prompt: NADIA_PROMPT });
    expect(paths(api)).toEqual(['POST /v1/memory/recall']);
    const on = setupDefault();
    await generateText({ model: on.harny(on.model, { saveUserMessages: true }), prompt: NADIA_PROMPT });
    expect(paths(on.api)).toEqual(['POST /v1/memory/recall', 'POST /v1/memory/ingest']);
  });

  it('stays off with saveUserMessages: false', async () => {
    const { api, harny, model } = setup();
    await generateText({ model: harny(model, { saveUserMessages: false }), prompt: NADIA_PROMPT });
    expect(paths(api)).toEqual(['POST /v1/memory/recall']);
  });

  it('does not store when the model call fails', async () => {
    const { api, harny } = setup();
    const broken = mockModel();
    broken.doGenerate = async () => {
      throw new Error('model down');
    };
    await expect(generateText({ model: harny(broken), prompt: NADIA_PROMPT, maxRetries: 0 })).rejects.toThrow('model down');
    expect(paths(api)).toEqual(['POST /v1/memory/recall']);
  });

  it('hands the store to waitUntil when given, and returns without waiting for it', async () => {
    const { api, harny, model } = setup();
    const handed: Promise<unknown>[] = [];
    await generateText({ model: harny(model, { waitUntil: (p) => void handed.push(p) }), prompt: NADIA_PROMPT });
    expect(handed).toHaveLength(1);
    await Promise.all(handed);
    expect(paths(api)).toContain('POST /v1/memory/ingest');
  });

  it('does not store a stream that ended in an error chunk', async () => {
    const { api, harny } = setup();
    const broken = mockModel();
    broken.doStream = async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'error', error: new Error('boom') });
          controller.enqueue({ type: 'finish', finishReason: { unified: 'error', raw: 'error' }, usage: USAGE });
          controller.close();
        },
      }),
    });
    const result = streamText({ model: harny(broken), prompt: NADIA_PROMPT, onError: () => {} });
    await result.consumeStream({ onError: () => {} });
    expect(paths(api)).toEqual(['POST /v1/memory/recall']);
  });
});

describe('memory trouble never fails the call', () => {
  it('survives a recall failure and reports it', async () => {
    const { api, harny, model } = setup();
    api.reply('POST /v1/memory/recall', json({ code: 'pipeline-disabled', status: 503, debugMessage: 'off', data: null }, 503));
    const onError = vi.fn();
    const result = await generateText({ model: harny(model, { onError }), prompt: NADIA_PROMPT });
    expect(result.text).toBe('It is 40k.');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'pipeline-disabled' }), { stage: 'recall' });
    expect(model.doGenerateCalls[0]!.prompt).toHaveLength(1);
  });

  it('survives a store failure and reports it', async () => {
    const { api, harny, model } = setup();
    api.reply('POST /v1/memory/ingest', json({ code: 'project-cap-reached', status: 429, debugMessage: 'cap', data: null }, 429));
    const onError = vi.fn();
    const result = await generateText({ model: harny(model, { onError }), prompt: NADIA_PROMPT });
    expect(result.text).toBe('It is 40k.');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'project-cap-reached' }), { stage: 'ingest' });
  });

  it('survives a missing key and a missing user', async () => {
    const api = fakeApi();
    vi.stubEnv('HARNY_API_KEY', '');
    const errors: unknown[] = [];
    try {
      const harny = createHarny({ fetch: api.fetch });
      const model = mockModel();
      const result = await generateText({ model: harny(model, { user: 'nadia', saveUserMessages: true, onError: (e) => errors.push(e) }), prompt: 'hi' });
      expect(result.text).toBe('It is 40k.');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(errors.length).toBe(2);
    expect(api.calls).toHaveLength(0);
  });

  it('survives a throwing onError', async () => {
    const { api, harny, model } = setup();
    api.reply('POST /v1/memory/recall', json({ code: 'x', status: 500, debugMessage: 'x', data: null }, 500));
    const result = await generateText({
      model: harny(model, {
        onError: () => {
          throw new Error('handler bug');
        },
      }),
      prompt: NADIA_PROMPT,
    });
    expect(result.text).toBe('It is 40k.');
  });
});

describe('tool loops and reuse', () => {
  it('asks recall once for the same question and stores a repeated message once', async () => {
    const { api, model } = setup();
    const client = new HarnyClient({ apiKey: 'fsa_app', user: 'nadia', fetch: api.fetch });
    const wrapped = wrapLanguageModel({ model, middleware: createMemoryMiddleware(client, { conversationId: 'c', saveUserMessages: true }) });
    await generateText({ model: wrapped, prompt: NADIA_PROMPT });
    await generateText({ model: wrapped, prompt: NADIA_PROMPT });
    expect(paths(api).filter((p) => p === 'POST /v1/memory/recall')).toHaveLength(1);
    expect(paths(api).filter((p) => p === 'POST /v1/memory/ingest')).toHaveLength(1);
  });

  it('does not store a tool-continuation step as a new turn', async () => {
    const { api, harny, model } = setup();
    await generateText({
      model: harny(model),
      messages: [
        { role: 'user', content: 'Look up the budget.' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'lookup', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'lookup', output: { type: 'text', value: '40k' } }] },
      ],
    });
    expect(paths(api).filter((p) => p === 'POST /v1/memory/ingest')).toHaveLength(0);
    expect(paths(api).filter((p) => p === 'POST /v1/memory/recall')).toHaveLength(1);
  });

  it('exposes the middleware for wrapLanguageModel', async () => {
    const { api, harny, model } = setup();
    const wrapped = wrapLanguageModel({ model, middleware: harny.middleware() });
    await generateText({ model: wrapped, prompt: NADIA_PROMPT });
    expect(paths(api)).toEqual(['POST /v1/memory/recall', 'POST /v1/memory/ingest']);
  });

  it('accepts a conversationId function', async () => {
    const { api, harny, model } = setup();
    await generateText({ model: harny(model, { conversationId: () => 'from-fn' }), prompt: NADIA_PROMPT });
    expect(api.calls.some((c) => c.path === '/v1/memory/ingest')).toBe(true);
  });
});
