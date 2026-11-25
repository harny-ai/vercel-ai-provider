import { HarnyAPIError, HarnyConfigError } from './errors.js';
import type {
  BatchIngestReceipt,
  DataPointInput,
  DeleteReceipt,
  HarnyClientOptions,
  IngestReceipt,
  IngestionStatus,
  RecallOptions,
  RecallResponse,
  UsageResponse,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://api.harny.ai';
const LEVELS = ['low', 'medium', 'high', 'extra-high'] as const;
const SORTS = ['relevance', 'chronological'] as const;
const MIN_MAX_TOKENS = 256;
const MAX_BATCH_ITEMS = 1000;
const USER_NOT_FOUND = 'user-not-found-in-app';

function env(name: string): string | undefined {
  const value = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return value && value.trim() ? value.trim() : undefined;
}

/** Add `/v1` when missing; refuse plain http unless the host is localhost or a loopback address. */
export function resolveBaseURL(baseURL?: string): string {
  const raw = (baseURL ?? env('HARNY_API_URL') ?? DEFAULT_BASE_URL).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HarnyConfigError(`baseURL must be an absolute https URL, got ${JSON.stringify(raw)}`);
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new HarnyConfigError('baseURL must use https unless the host is localhost or a loopback address');
  }
  const path = url.pathname.replace(/\/+$/, '');
  const full = path.endsWith('/v1') ? path : `${path}/v1`;
  return `${url.origin}${full}`;
}

function iso(value: string | Date, name: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new HarnyConfigError(`${name} is not a valid date`);
    return value.toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new HarnyConfigError(`${name} must be an ISO 8601 string with a zone, or a Date`);
  }
  return value.trim();
}

function dataPointBody(input: DataPointInput): Record<string, unknown> {
  if (typeof input.content !== 'string' || !input.content.trim()) {
    throw new HarnyConfigError('content must be a non-blank string');
  }
  const body: Record<string, unknown> = { content: input.content };
  if (input.id !== undefined) {
    if (!input.id || input.id.includes('/')) throw new HarnyConfigError("id must be a non-empty string without '/'");
    body.id = input.id;
  }
  if (input.label !== undefined) body.label = input.label;
  if (input.timestamp !== undefined) body.timestamp = iso(input.timestamp, 'timestamp');
  if (input.metadata !== undefined) body.metadata = input.metadata;
  return body;
}

function recallBody(options: RecallOptions, identity: string): Record<string, unknown> {
  if (typeof options.query !== 'string' || !options.query.trim()) {
    throw new HarnyConfigError('query must be a non-blank string');
  }
  if (options.level !== undefined && options.maxTokens !== undefined) {
    throw new HarnyConfigError('pass level or maxTokens, not both');
  }
  const body: Record<string, unknown> = { query: options.query, identity };
  if (options.level !== undefined) {
    if (!LEVELS.includes(options.level)) throw new HarnyConfigError(`level must be one of ${LEVELS.join(', ')}`);
    body.level = options.level;
  }
  if (options.maxTokens !== undefined) {
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < MIN_MAX_TOKENS) {
      throw new HarnyConfigError(`maxTokens must be an integer of at least ${MIN_MAX_TOKENS}`);
    }
    body.maxTokens = options.maxTokens;
  }
  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
      throw new HarnyConfigError('limit must be an integer from 1 to 200');
    }
    body.limit = options.limit;
  }
  if (options.sort !== undefined) {
    if (!SORTS.includes(options.sort)) throw new HarnyConfigError(`sort must be one of ${SORTS.join(', ')}`);
    body.sort = options.sort;
  }
  if (options.queryTimestamp !== undefined) body.queryTimestamp = iso(options.queryTimestamp, 'queryTimestamp');
  if (options.occurredFrom !== undefined) body.occurredFrom = iso(options.occurredFrom, 'occurredFrom');
  if (options.occurredTo !== undefined) body.occurredTo = iso(options.occurredTo, 'occurredTo');
  return body;
}

/** A thin client over the eight `/v1/memory` routes. It holds no state besides its options. */
export class HarnyClient {
  constructor(private readonly options: HarnyClientOptions = {}) {}

  private key(): string {
    const key = this.options.apiKey?.trim() || env('HARNY_API_KEY');
    if (!key) {
      throw new HarnyConfigError(
        'No Harny key. Pass apiKey to createHarny or set HARNY_API_KEY. ' +
          'To get one: pip install harny, then harny init --name "<business>" (it saves the key to .env without printing it).',
      );
    }
    return key;
  }

  /** The end user for a call: the call's own, else the one given to createHarny. */
  actingUser(user?: string): string | undefined {
    const named = (user ?? this.options.user)?.trim();
    return named || undefined;
  }

  private needUser(user?: string): string {
    const named = this.actingUser(user);
    if (!named) {
      throw new HarnyConfigError(
        "Name the end user: pass user: '<your id for the person>' to createHarny or to the call.",
      );
    }
    return named;
  }

  /** Users this instance has seen answered or has created, so the create call happens at most once per user. */
  private readonly knownUsers = new Set<string>();
  private readonly creating = new Map<string, Promise<void>>();

  /**
   * Run a call as a person. With an app key, a refusal "no such user in this app" makes the package create that
   * person once (`POST /v1/users`) and repeat the call once. A person's own key never does this.
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    init: { body?: unknown; user?: string; actingUser?: boolean } = {},
  ): Promise<T> {
    if (!init.actingUser) return this.send<T>(method, path, init);
    const user = this.needUser(init.user);
    try {
      const answer = await this.send<T>(method, path, init);
      this.knownUsers.add(user);
      return answer;
    } catch (error) {
      if (
        !(error instanceof HarnyAPIError) ||
        error.code !== USER_NOT_FOUND ||
        this.key().startsWith('fsk_') ||
        this.knownUsers.has(user)
      ) {
        throw error;
      }
      try {
        await this.createUser(user);
      } catch {
        throw error; // the original refusal, unchanged
      }
      const answer = await this.send<T>(method, path, init);
      this.knownUsers.add(user);
      return answer;
    }
  }

  private createUser(user: string): Promise<void> {
    let pending = this.creating.get(user);
    if (!pending) {
      pending = this.send<unknown>('POST', '/users', {
        body: { identifier: user, identifier_type: 'app_id' },
      })
        .then(() => void this.knownUsers.add(user))
        .catch((error) => {
          // The person already exists (a parallel call made them): fine. Anything else fails the create.
          if (error instanceof HarnyAPIError && error.status === 409) {
            this.knownUsers.add(user);
            return;
          }
          throw error;
        })
        .finally(() => void this.creating.delete(user));
      this.creating.set(user, pending);
    }
    return pending;
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    init: { body?: unknown; user?: string; actingUser?: boolean } = {},
  ): Promise<T> {
    const key = this.key();
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.actingUser) {
      const user = this.needUser(init.user);
      // A person's own key (fsk_) already names the person; only an app key sends the header.
      if (!key.startsWith('fsk_')) headers['X-Harny-User'] = user;
    }
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const url = `${resolveBaseURL(this.options.baseURL)}${path}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (cause) {
      throw new HarnyAPIError({
        code: 'network-error',
        status: 0,
        debugMessage: cause instanceof Error ? cause.message : 'The request did not reach Harny.',
        cause,
      });
    }
    const requestId = response.headers.get('x-request-id') ?? undefined;
    if (response.ok) {
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    const retryHeader = response.headers.get('retry-after');
    const retryAfter = retryHeader && /^\d+$/.test(retryHeader.trim()) ? Number(retryHeader) : undefined;
    const text = await response.text().catch(() => '');
    let parsed: { code?: unknown; debugMessage?: unknown; data?: unknown } = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    const code = typeof parsed.code === 'string' ? parsed.code : response.status === 429 ? 'rate-limited' : 'http-error';
    const debugMessage =
      typeof parsed.debugMessage === 'string'
        ? parsed.debugMessage
        : response.status === 429
          ? 'Too many requests this minute. Retry after the wait in retryAfter.'
          : `Harny answered ${response.status}.`;
    throw new HarnyAPIError({ code, status: response.status, debugMessage, data: parsed.data, retryAfter, requestId });
  }

  /** Send one data point. The same `id` with changed text replaces the old; the same text again is `unchanged`. */
  async ingest(input: DataPointInput & { idempotencyKey?: string; user?: string }): Promise<IngestReceipt> {
    const body = dataPointBody(input);
    if (input.idempotencyKey !== undefined) body.idempotencyKey = input.idempotencyKey;
    return this.request('POST', '/memory/ingest', { body, user: input.user, actingUser: true });
  }

  /** Send 1 to 1,000 data points. Retry with the same `idempotencyKey` to resume where it stopped. */
  async ingestBatch(
    items: DataPointInput[],
    options: { idempotencyKey?: string; user?: string } = {},
  ): Promise<BatchIngestReceipt> {
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH_ITEMS) {
      throw new HarnyConfigError(`a batch holds 1 to ${MAX_BATCH_ITEMS} items`);
    }
    const seen = new Set<string>();
    const bodies = items.map((item, ordinal) => {
      const body = dataPointBody(item);
      if (typeof body.id === 'string') {
        if (seen.has(body.id)) throw new HarnyConfigError(`item ${ordinal} repeats the id ${JSON.stringify(body.id)}`);
        seen.add(body.id);
      }
      return body;
    });
    const body: Record<string, unknown> = { items: bodies };
    if (options.idempotencyKey !== undefined) body.idempotencyKey = options.idempotencyKey;
    return this.request('POST', '/memory/ingest/batch', { body, user: options.user, actingUser: true });
  }

  async getIngestion(ingestionId: string, options: { user?: string } = {}): Promise<IngestionStatus> {
    if (!ingestionId) throw new HarnyConfigError('ingestionId is required');
    return this.request('GET', `/memory/ingest/${encodeURIComponent(ingestionId)}`, {
      user: options.user,
      actingUser: true,
    });
  }

  /** Poll until the send is `completed` or `failed`. Throws a `timeout` HarnyAPIError after `timeoutMs`. */
  async waitForIngestion(
    ingestionId: string,
    options: { user?: string; timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<IngestionStatus> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollMs = options.pollMs ?? 2_000;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const started = Date.now();
    for (;;) {
      const status = await this.getIngestion(ingestionId, { user: options.user });
      if (status.status === 'completed' || status.status === 'failed') return status;
      if (Date.now() - started >= timeoutMs) {
        throw new HarnyAPIError({
          code: 'timeout',
          status: 0,
          debugMessage: `ingestion ${ingestionId} was still ${status.status} after ${timeoutMs / 1000}s`,
        });
      }
      await sleep(pollMs);
    }
  }

  /** Forget every data point of one send. Repeating the call is safe. */
  async deleteIngestion(ingestionId: string, options: { user?: string } = {}): Promise<void> {
    if (!ingestionId) throw new HarnyConfigError('ingestionId is required');
    await this.request('DELETE', `/memory/ingest/${encodeURIComponent(ingestionId)}`, {
      user: options.user,
      actingUser: true,
    });
  }

  /** Forget 1 to 1,000 data points by `sourceId`. If one id is unknown, none is deleted and the error names it. */
  async deleteDataPoints(ids: string[], options: { user?: string } = {}): Promise<DeleteReceipt> {
    const unique = [...new Set(ids)];
    if (unique.length < 1 || unique.length > 1000 || unique.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new HarnyConfigError('delete 1 to 1000 data points at a time, each id a non-blank string');
    }
    return this.request('POST', '/memory/data-points/delete', {
      body: { ids: unique },
      user: options.user,
      actingUser: true,
    });
  }

  /** Ranked, dated evidence for a question, as the named person. */
  async recall(options: RecallOptions): Promise<RecallResponse> {
    const identity = this.needUser(options.user);
    return this.request('POST', '/memory/recall', {
      body: recallBody(options, identity),
      user: options.user,
      actingUser: true,
    });
  }

  /** This month's use of the app. Needs the app key. */
  async usage(): Promise<UsageResponse> {
    return this.request('GET', '/memory/usage');
  }
}
