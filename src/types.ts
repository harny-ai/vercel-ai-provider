export type RecallLevel = 'low' | 'medium' | 'high' | 'extra-high';

/** One data point you send: text plus the time it happened. */
export interface DataPointInput {
  /** The text. Required, not blank. */
  content: string;
  /** A short name, at most 200 characters. */
  label?: string;
  /** Your id for the data point (no `/`). Sending the same id again replaces it. Defaults to a hash of the text. */
  id?: string;
  /** When it happened, ISO 8601 with a zone (or a Date). Defaults to now. */
  timestamp?: string | Date;
  /** Any JSON object, at most 64 KiB. */
  metadata?: Record<string, unknown>;
}

export interface IngestReceipt {
  projectId?: string;
  ingestionId: string;
  sourceId: string;
  status: 'queued' | 'completed';
  unchanged?: boolean | null;
}

export interface BatchItemReceipt {
  ordinal: number;
  sourceId: string;
  status: 'queued' | 'completed';
  unchanged?: boolean | null;
}

export interface BatchIngestReceipt {
  projectId?: string;
  ingestionId: string;
  status: 'queued' | 'completed';
  unchanged?: boolean | null;
  items: BatchItemReceipt[];
}

export interface IngestionStatus {
  status: 'processing' | 'completed' | 'failed';
  settled: boolean;
  blocked: boolean;
  readiness: { raw: number; comprehension: number; consolidation: number; failed: number };
  failure?: { code: string; message: string } | null;
}

export interface DeleteReceipt {
  operationId: string;
  ids: string[];
}

export interface RecallSource {
  sourceId: string;
  occurredAt?: string | null;
  label?: string | null;
  metadata?: Record<string, unknown> | null;
  excerpts?: string[];
}

export interface RecallResult {
  id: string;
  rank: number;
  occurredAt?: string | null;
  content: string;
  artifact?: { id: string; kind: string; occurredAt?: string | null; supersededAt?: string | null };
  sources?: RecallSource[];
}

export interface RecallPending {
  ingestions: number;
  dataPoints: number;
  since: string;
  message: string;
}

export interface RecallResponse {
  asOf: string;
  usedEvidenceTokens: number;
  results: RecallResult[];
  pending?: RecallPending | null;
}

export interface RecallOptions {
  /** What to look for. */
  query: string;
  /** The person asking. Defaults to the `user` of the call or of `createHarny`. */
  user?: string;
  /** Most results, 1 to 200. */
  limit?: number;
  /** Evidence size: low 8,000 tokens (default), medium 16,000, high 24,000, extra-high 32,000. Not with `maxTokens`. */
  level?: RecallLevel;
  /** An explicit evidence budget, at least 256 tokens. Not with `level`. */
  maxTokens?: number;
  /** Recall as of this moment: later evidence is left out. */
  queryTimestamp?: string | Date;
  /** Start of an occurrence-time window, inclusive. */
  occurredFrom?: string | Date;
  /** End of an occurrence-time window, inclusive. */
  occurredTo?: string | Date;
  sort?: 'relevance' | 'chronological';
}

export interface UsageResponse {
  month: { from: string; to: string; resetsAt: string };
  balance: { left: number | null; included: number | null; bought: number; rolledOver: number; spent: number };
  project: Record<string, unknown>;
  metered: boolean;
}

/** Options shared by `createHarny` and the standalone functions. */
export interface HarnyClientOptions {
  /** An app key (`fsa_...`) with `user`, or a person's own key (`fsk_...`). Defaults to the HARNY_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to HARNY_API_URL, else https://api.harny.ai. `/v1` is added when missing. Plain http is allowed for localhost only. */
  baseURL?: string;
  /** Your id for the end user. Needed with an app key. */
  user?: string;
  /** A custom fetch, for tests or a proxy. */
  fetch?: typeof globalThis.fetch;
}
