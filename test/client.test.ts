import { describe, expect, it, vi } from 'vitest';
import { HarnyAPIError, HarnyClient, HarnyConfigError, createHarny, resolveBaseURL } from '../src/index.js';
import { fakeApi, json } from './helpers.js';

describe('base URL', () => {
  it('defaults to the public API and adds /v1', () => {
    expect(resolveBaseURL(undefined)).toBe('https://api.harny.ai/v1');
  });
  it('keeps an existing /v1 and trims slashes', () => {
    expect(resolveBaseURL('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(resolveBaseURL('https://api.example.com')).toBe('https://api.example.com/v1');
  });
  it('refuses plain http outside localhost', () => {
    expect(() => resolveBaseURL('http://api.example.com')).toThrow(HarnyConfigError);
  });
  it('allows plain http for localhost and loopback', () => {
    expect(resolveBaseURL('http://localhost:8000')).toBe('http://localhost:8000/v1');
    expect(resolveBaseURL('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/v1');
    expect(resolveBaseURL('http://[::1]:8000')).toBe('http://[::1]:8000/v1');
  });
  it('refuses a value that is not a URL', () => {
    expect(() => resolveBaseURL('not a url')).toThrow(HarnyConfigError);
  });
  it('reads HARNY_API_URL when no baseURL is given', () => {
    vi.stubEnv('HARNY_API_URL', 'https://staging.example.com');
    try {
      expect(resolveBaseURL(undefined)).toBe('https://staging.example.com/v1');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('auth and headers', () => {
  it('sends the app key as a bearer token with X-Harny-User', async () => {
    const api = fakeApi();
    await new HarnyClient({ apiKey: 'fsa_app', user: 'nadia', fetch: api.fetch }).ingest({ content: 'hello' });
    expect(api.calls[0]?.headers.authorization).toBe('Bearer fsa_app');
    expect(api.calls[0]?.headers['x-harny-user']).toBe('nadia');
    expect(api.calls[0]?.headers['content-type']).toBe('application/json');
  });
  it('sends no X-Harny-User for a person key (fsk_)', async () => {
    const api = fakeApi();
    await new HarnyClient({ apiKey: 'fsk_person', user: 'nadia', fetch: api.fetch }).ingest({ content: 'hello' });
    expect(api.calls[0]?.headers['x-harny-user']).toBeUndefined();
    expect(api.calls[0]?.headers.authorization).toBe('Bearer fsk_person');
  });
  it('lets a call name a different user than createHarny', async () => {
    const api = fakeApi();
    const harny = createHarny({ apiKey: 'fsa_app', user: 'nadia', fetch: api.fetch });
    await harny.ingest({ content: 'hello', user: 'ben' });
    expect(api.calls[0]?.headers['x-harny-user']).toBe('ben');
  });
  it('reads the key from HARNY_API_KEY at the first call', async () => {
    const api = fakeApi();
    vi.stubEnv('HARNY_API_KEY', 'fsa_from_env');
    try {
      await createHarny({ user: 'nadia', fetch: api.fetch }).ingest({ content: 'hello' });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(api.calls[0]?.headers.authorization).toBe('Bearer fsa_from_env');
  });
  it('tells you how to get a key, without sending anything, when none is set', async () => {
    const api = fakeApi();
    vi.stubEnv('HARNY_API_KEY', '');
    try {
      await expect(createHarny({ user: 'nadia', fetch: api.fetch }).ingest({ content: 'x' })).rejects.toThrow(/harny init/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(api.calls).toHaveLength(0);
  });
  it('names the missing end user and sends nothing', async () => {
    const api = fakeApi();
    await expect(new HarnyClient({ apiKey: 'fsa_app', fetch: api.fetch }).ingest({ content: 'x' })).rejects.toThrow(
      /Name the end user/,
    );
    expect(api.calls).toHaveLength(0);
  });
  it('builds the URL under /v1/memory', async () => {
    const api = fakeApi();
    await new HarnyClient({ apiKey: 'fsa_app', user: 'n', baseURL: 'https://x.example.com', fetch: api.fetch }).ingest({
      content: 'x',
    });
    expect(api.calls[0]?.url).toBe('https://x.example.com/v1/memory/ingest');
  });
});

describe('request shapes (api/app/models/memory_api_v1.py)', () => {
  const make = () => {
    const api = fakeApi();
    return { api, client: new HarnyClient({ apiKey: 'fsa_app', user: 'nadia', fetch: api.fetch }) };
  };

  it('ingest sends the data point fields and nothing else', async () => {
    const { api, client } = make();
    const receipt = await client.ingest({
      content: 'Nadia confirmed the Acme pilot ships March 14. Budget is 32k.',
      id: 'call-8820',
      label: 'Account review call',
      timestamp: new Date('2026-02-03T09:00:00Z'),
      metadata: { channel: 'call' },
      idempotencyKey: 'k1',
    });
    expect(api.calls[0]?.body).toEqual({
      content: 'Nadia confirmed the Acme pilot ships March 14. Budget is 32k.',
      id: 'call-8820',
      label: 'Account review call',
      timestamp: '2026-02-03T09:00:00.000Z',
      metadata: { channel: 'call' },
      idempotencyKey: 'k1',
    });
    expect(receipt.sourceId).toBe('call-8820');
  });
  it('ingest refuses blank content and a slash in the id before any call', async () => {
    const { api, client } = make();
    await expect(client.ingest({ content: '   ' })).rejects.toThrow(HarnyConfigError);
    await expect(client.ingest({ content: 'x', id: 'a/b' })).rejects.toThrow(HarnyConfigError);
    expect(api.calls).toHaveLength(0);
  });
  it('ingestBatch sends items and checks ids and size', async () => {
    const { api, client } = make();
    const receipt = await client.ingestBatch([{ content: 'a', id: 'one' }, { content: 'b' }], { idempotencyKey: 'b1' });
    expect(api.calls[0]?.path).toBe('/v1/memory/ingest/batch');
    expect(api.calls[0]?.body).toEqual({ items: [{ content: 'a', id: 'one' }, { content: 'b' }], idempotencyKey: 'b1' });
    expect(receipt.items).toHaveLength(2);
    await expect(client.ingestBatch([])).rejects.toThrow(HarnyConfigError);
    await expect(client.ingestBatch([{ content: 'a', id: 'x' }, { content: 'b', id: 'x' }])).rejects.toThrow(/repeats the id/);
  });
  it('recall sends query, identity and level', async () => {
    const { api, client } = make();
    const answer = await client.recall({ query: 'What is the Acme pilot budget?', level: 'medium' });
    expect(api.calls[0]?.path).toBe('/v1/memory/recall');
    expect(api.calls[0]?.body).toEqual({ query: 'What is the Acme pilot budget?', identity: 'nadia', level: 'medium' });
    expect(answer.results[0]?.content).toMatch(/40k/);
  });
  it('recall sends the window and sort fields in the API spelling', async () => {
    const { api, client } = make();
    await client.recall({
      query: 'q',
      maxTokens: 512,
      limit: 5,
      sort: 'chronological',
      queryTimestamp: '2026-03-02T00:00:00Z',
      occurredFrom: new Date('2026-01-01T00:00:00Z'),
      occurredTo: '2026-02-01T00:00:00Z',
    });
    expect(api.calls[0]?.body).toEqual({
      query: 'q',
      identity: 'nadia',
      maxTokens: 512,
      limit: 5,
      sort: 'chronological',
      queryTimestamp: '2026-03-02T00:00:00Z',
      occurredFrom: '2026-01-01T00:00:00.000Z',
      occurredTo: '2026-02-01T00:00:00Z',
    });
  });
  it('recall refuses level with maxTokens, a bad limit and a tiny budget', async () => {
    const { client } = make();
    await expect(client.recall({ query: 'q', level: 'low', maxTokens: 512 })).rejects.toThrow(/not both/);
    await expect(client.recall({ query: 'q', limit: 201 })).rejects.toThrow(/1 to 200/);
    await expect(client.recall({ query: 'q', maxTokens: 100 })).rejects.toThrow(/at least 256/);
    await expect(client.recall({ query: 'q', level: 'huge' as never })).rejects.toThrow(/level must be one of/);
  });
  it('getIngestion encodes the id in the path', async () => {
    const { api, client } = make();
    const status = await client.getIngestion('a/b c');
    expect(api.calls[0]?.path).toBe('/v1/memory/ingest/a%2Fb%20c');
    expect(status.settled).toBe(true);
  });
  it('deleteDataPoints posts unique ids; deleteIngestion handles 204', async () => {
    const { api, client } = make();
    const receipt = await client.deleteDataPoints(['a', 'a', 'b']);
    expect(api.calls[0]?.body).toEqual({ ids: ['a', 'b'] });
    expect(receipt.operationId).toBe('op-1');
    await expect(client.deleteIngestion('ing-1')).resolves.toBeUndefined();
    expect(api.calls[1]?.method).toBe('DELETE');
    await expect(client.deleteDataPoints([])).rejects.toThrow(HarnyConfigError);
  });
  it('usage is a plain GET with no user header', async () => {
    const { api, client } = make();
    const usage = await client.usage();
    expect(api.calls[0]?.path).toBe('/v1/memory/usage');
    expect(api.calls[0]?.headers['x-harny-user']).toBeUndefined();
    expect(usage.balance.included).toBe(500);
  });
});

describe('waitForIngestion', () => {
  it('polls until completed', async () => {
    const api = fakeApi();
    let n = 0;
    api.reply('GET /v1/memory/ingest/ing-1', () =>
      json({
        status: ++n < 3 ? 'processing' : 'completed',
        settled: n >= 3,
        blocked: false,
        readiness: { raw: 1, comprehension: 0, consolidation: 0, failed: 0 },
      }),
    );
    const client = new HarnyClient({ apiKey: 'fsa_app', user: 'nadia', fetch: api.fetch });
    const sleeps: number[] = [];
    const status = await client.waitForIngestion('ing-1', { sleep: async (ms) => void sleeps.push(ms) });
    expect(status.status).toBe('completed');
    expect(sleeps).toEqual([2000, 2000]);
  });
  it('times out with a timeout error', async () => {
    const api = fakeApi();
    api.reply('GET /v1/memory/ingest/ing-1', () =>
      json({ status: 'processing', settled: false, blocked: false, readiness: { raw: 1, comprehension: 0, consolidation: 0, failed: 0 } }),
    );
    const client = new HarnyClient({ apiKey: 'fsa_app', user: 'nadia', fetch: api.fetch });
    await expect(client.waitForIngestion('ing-1', { timeoutMs: 0, sleep: async () => {} })).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});

describe('errors', () => {
  const client = (api: ReturnType<typeof fakeApi>) => new HarnyClient({ apiKey: 'fsa_app', user: 'nadia', fetch: api.fetch });

  it("maps the API's error body", async () => {
    const api = fakeApi();
    api.reply(
      'POST /v1/memory/recall',
      json({ code: 'recall-range-invalid', status: 400, debugMessage: 'from is after to', data: null }, 400, {
        'x-request-id': 'req-9',
      }),
    );
    const error = await client(api).recall({ query: 'q' }).catch((e) => e);
    expect(error).toBeInstanceOf(HarnyAPIError);
    expect(error).toMatchObject({ code: 'recall-range-invalid', status: 400, debugMessage: 'from is after to', requestId: 'req-9' });
  });
  it('maps a bodyless per-minute 429 with Retry-After', async () => {
    const api = fakeApi();
    api.reply('POST /v1/memory/ingest', new Response(null, { status: 429, headers: { 'retry-after': '17' } }));
    const error = await client(api).ingest({ content: 'x' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'rate-limited', status: 429, retryAfter: 17 });
  });
  it('keeps the data a refusal carries (the missing ids of a delete)', async () => {
    const api = fakeApi();
    api.reply(
      'POST /v1/memory/data-points/delete',
      json({ code: 'data-point-not-found', status: 404, debugMessage: 'unknown ids', data: { ids: ['zz'] } }, 404),
    );
    const error = await client(api).deleteDataPoints(['zz']).catch((e) => e);
    expect(error.data).toEqual({ ids: ['zz'] });
  });
  it('maps a project cap refusal', async () => {
    const api = fakeApi();
    api.reply('POST /v1/memory/ingest', json({ code: 'project-cap-reached', status: 429, debugMessage: 'cap', data: null }, 429));
    await expect(client(api).ingest({ content: 'x' })).rejects.toMatchObject({ code: 'project-cap-reached', status: 429 });
  });
  it('reports a network failure as network-error with status 0', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const error = await new HarnyClient({ apiKey: 'fsa_app', user: 'n', fetch: failing }).ingest({ content: 'x' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'network-error', status: 0 });
  });
  it('copes with a non-JSON error page', async () => {
    const api = fakeApi();
    api.reply('POST /v1/memory/ingest', new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(client(api).ingest({ content: 'x' })).rejects.toMatchObject({ code: 'http-error', status: 502 });
  });
});
