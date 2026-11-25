import { describe, expect, it } from 'vitest';
import { addMemories, getMemories, retrieveMemories } from '../src/index.js';
import { fakeApi, json } from './helpers.js';

const opts = () => {
  const api = fakeApi();
  return { api, options: { apiKey: 'fsa_app', user: 'nadia', fetch: api.fetch } };
};

describe('addMemories', () => {
  it('stores user messages only', async () => {
    const { api, options } = opts();
    const receipts = await addMemories(
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'The pilot ships March 14.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Noted, thanks.' }] },
        { role: 'user', content: 'Budget is 32k.' },
      ],
      { ...options, conversationId: 'c1', metadata: { src: 'test' } },
    );
    expect(receipts).toHaveLength(2);
    expect(api.calls.map((c) => c.body.content)).toEqual(['The pilot ships March 14.', 'Budget is 32k.']);
    expect(api.calls[0]!.body.metadata).toEqual({ src: 'test' });
    expect(api.calls[0]!.body.id).toMatch(/^turn-/);
  });
  it('stores nothing for an empty list', async () => {
    const { api, options } = opts();
    expect(await addMemories([], options)).toEqual([]);
    expect(api.calls).toHaveLength(0);
  });
});

describe('getMemories and retrieveMemories', () => {
  it('getMemories recalls for the last user message of a prompt', async () => {
    const { api, options } = opts();
    const results = await getMemories(
      [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: [{ type: 'text', text: 'What is the Acme pilot budget?' }] },
      ],
      { ...options, level: 'medium' },
    );
    expect(api.calls[0]!.body).toEqual({ query: 'What is the Acme pilot budget?', identity: 'nadia', level: 'medium', limit: 20 });
    expect(results).toHaveLength(2);
  });
  it('getMemories accepts a plain string and returns [] with no user text', async () => {
    const { api, options } = opts();
    expect(await getMemories('hello', options)).toHaveLength(2);
    expect(await getMemories([{ role: 'assistant', content: 'x' }], options)).toEqual([]);
    expect(api.calls).toHaveLength(1);
  });
  it('retrieveMemories returns a system-prompt block, or an empty string', async () => {
    const { api, options } = opts();
    const block = await retrieveMemories('What is the Acme pilot budget?', { ...options, heading: 'Facts:' });
    expect(block).toBe('Facts:\n- Acme pilot budget: currently 40k. (2026-03-01)\n- The Acme pilot ships March 14.');
    api.reply('POST /v1/memory/recall', json({ asOf: 'x', usedEvidenceTokens: 0, results: [] }));
    expect(await retrieveMemories('anything', options)).toBe('');
  });
  it('passes maxTokens instead of level when given', async () => {
    const { api, options } = opts();
    await getMemories('q', { ...options, maxTokens: 2048, limit: 4 });
    expect(api.calls[0]!.body).toEqual({ query: 'q', identity: 'nadia', maxTokens: 2048, limit: 4 });
  });
});
