import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createHarny } from '../src/index.js';
import { fakeApi, USAGE } from './helpers.js';

const setup = () => {
  const api = fakeApi();
  const harny = createHarny({ apiKey: 'fsa_app', user: 'nadia', fetch: api.fetch });
  return { api, harny, tools: harny.tools() };
};

describe('harny.tools()', () => {
  it('exposes harny_remember and harny_recall with plain schemas', () => {
    const { tools } = setup();
    expect(Object.keys(tools).sort()).toEqual(['harny_recall', 'harny_remember']);
    expect(tools.harny_remember.description).toMatch(/Remember a fact/);
    expect(tools.harny_recall.description).toMatch(/Recall what you know/);
  });

  it('harny_remember stores the fact for the fixed user and answers with the receipt', async () => {
    const { api, tools } = setup();
    const out = await tools.harny_remember.execute!(
      { content: 'Nadia prefers async standups.', label: 'Preference', id: 'pref-1' },
      { toolCallId: 't', messages: [] } as never,
    );
    expect(out).toEqual({ status: 'queued', ingestionId: 'ing-1', sourceId: 'pref-1' });
    expect(api.calls[0]!.body).toEqual({ content: 'Nadia prefers async standups.', label: 'Preference', id: 'pref-1' });
    expect(api.calls[0]!.headers['x-harny-user']).toBe('nadia');
  });

  it('harny_recall returns content, dates and source ids', async () => {
    const { api, tools } = setup();
    const out = (await tools.harny_recall.execute!({ query: 'budget?' }, { toolCallId: 't', messages: [] } as never)) as any;
    expect(api.calls[0]!.body).toEqual({ query: 'budget?', identity: 'nadia', level: 'low', limit: 10 });
    expect(out.results[0]).toEqual({
      content: 'Acme pilot budget: currently 40k.',
      occurredAt: '2026-03-01T09:00:00Z',
      sourceIds: ['call-8821'],
    });
    expect(out.results[1].occurredAt).toBeNull();
  });

  it('the person is fixed by you: settings.user overrides, the model cannot choose', async () => {
    const { api, harny } = setup();
    const tools = harny.tools({ user: 'ben' });
    await tools.harny_recall.execute!({ query: 'q', user: 'someone-else' } as never, { toolCallId: 't', messages: [] } as never);
    expect(api.calls[0]!.headers['x-harny-user']).toBe('ben');
    expect(api.calls[0]!.body.identity).toBe('ben');
  });

  it('runs inside generateText when the model calls the tool', async () => {
    const { api, tools } = setup();
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        ++step === 1
          ? {
              content: [
                { type: 'tool-call', toolCallId: 'c1', toolName: 'harny_recall', input: JSON.stringify({ query: 'Acme budget' }) },
              ],
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: USAGE,
              warnings: [],
            }
          : { content: [{ type: 'text', text: 'It is 40k.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE, warnings: [] },
    });
    const result = await generateText({ model, tools, prompt: 'What is the budget?', stopWhen: stepCountIs(3) });
    expect(result.text).toBe('It is 40k.');
    expect(api.calls.map((c) => c.path)).toEqual(['/v1/memory/recall']);
  });
});
