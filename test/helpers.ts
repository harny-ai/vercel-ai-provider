import { MockLanguageModelV4 } from 'ai/test';

export interface Recorded {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

export interface FakeApi {
  fetch: typeof globalThis.fetch;
  calls: Recorded[];
  /** Replace the answer for a route key like "POST /v1/memory/recall". */
  reply(route: string, answer: Response | ((req: Recorded) => Response)): void;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export const RECALL_OK = {
  asOf: '2026-03-02T00:00:00Z',
  usedEvidenceTokens: 18,
  results: [
    {
      id: 'm-1',
      rank: 1,
      occurredAt: '2026-03-01T09:00:00Z',
      content: 'Acme pilot budget: currently 40k.',
      artifact: { id: 'm-1', kind: 'observation', occurredAt: '2026-03-01T09:00:00Z' },
      sources: [{ sourceId: 'call-8821', occurredAt: '2026-03-01T09:00:00Z', label: 'Budget change', excerpts: [] }],
    },
    { id: 'm-2', rank: 2, content: 'The Acme pilot ships March 14.', sources: [{ sourceId: 'call-8820' }] },
  ],
};

export function fakeApi(): FakeApi {
  const overrides = new Map<string, Response | ((req: Recorded) => Response)>();
  const calls: Recorded[] = [];
  const fetchFn = (async (input: any, init: any = {}) => {
    const url = String(input);
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const recorded: Recorded = {
      method: init.method ?? 'GET',
      url,
      path: parsed.pathname,
      headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(recorded);
    const key = `${recorded.method} ${recorded.path}`;
    const override = overrides.get(key);
    if (override) return typeof override === 'function' ? override(recorded) : override.clone();
    if (key === 'POST /v1/memory/recall') return json(RECALL_OK);
    if (key === 'POST /v1/memory/ingest') {
      return json(
        { projectId: 'app-1', ingestionId: 'ing-1', sourceId: recorded.body?.id ?? 'sha', status: 'queued' },
        202,
      );
    }
    if (key === 'POST /v1/memory/ingest/batch') {
      return json(
        {
          projectId: 'app-1',
          ingestionId: 'ing-2',
          status: 'queued',
          items: recorded.body.items.map((item: any, ordinal: number) => ({
            ordinal,
            sourceId: item.id ?? `sha-${ordinal}`,
            status: 'queued',
          })),
        },
        202,
      );
    }
    if (key.startsWith('GET /v1/memory/ingest/')) {
      return json({
        status: 'completed',
        settled: true,
        blocked: false,
        readiness: { raw: 0, comprehension: 0, consolidation: 0, failed: 0 },
      });
    }
    if (key === 'POST /v1/memory/data-points/delete') {
      return json({ operationId: 'op-1', ids: recorded.body.ids }, 202);
    }
    if (key === 'GET /v1/memory/usage') {
      return json({
        month: { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', resetsAt: '2026-11-01T00:00:00Z' },
        balance: { left: 480, included: 500, bought: 0, rolledOver: 0, spent: 20 },
        project: { slug: 'app_key' },
        metered: false,
      });
    }
    if (recorded.method === 'DELETE' && recorded.path.startsWith('/v1/memory/ingest/')) {
      return new Response(null, { status: 204 });
    }
    return json({ code: 'not-found', status: 404, debugMessage: `no fake for ${key}`, data: null }, 404);
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchFn, calls, reply: (route, answer) => void overrides.set(route, answer) };
}

export const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
} as any;

export function mockModel() {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'It is 40k.' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: USAGE,
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '1' });
          controller.enqueue({ type: 'text-delta', id: '1', delta: 'It is 40k.' });
          controller.enqueue({ type: 'text-end', id: '1' });
          controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE });
          controller.close();
        },
      }),
    }),
  });
}

export const NADIA_PROMPT = 'What is the Acme pilot budget?';
