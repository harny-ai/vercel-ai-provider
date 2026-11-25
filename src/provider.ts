import { gateway, wrapLanguageModel, type LanguageModel } from 'ai';
import { HarnyClient } from './client.js';
import { createMemoryMiddleware, type MemorySettings } from './middleware.js';
import { createTools, type ToolSettings } from './tools.js';
import type { HarnyClientOptions } from './types.js';

type WrappableModel = Exclude<LanguageModel, string>;

export interface HarnyProvider {
  /** Wrap a model so it remembers the person. Accepts a model object, or a gateway model id such as 'openai/gpt-5'. */
  <M extends LanguageModel>(model: M, settings?: MemorySettings): ReturnType<typeof wrapLanguageModel>;
  /** The same as calling the provider. */
  languageModel(model: LanguageModel, settings?: MemorySettings): ReturnType<typeof wrapLanguageModel>;
  /** The memory middleware alone, for `wrapLanguageModel({ model, middleware })`. */
  middleware(settings?: MemorySettings): ReturnType<typeof createMemoryMiddleware>;
  /** `{ harny_remember, harny_recall }` for a tool set. */
  tools(settings?: ToolSettings): ReturnType<typeof createTools>;
  /** The memory API client behind it. */
  client: HarnyClient;
  ingest: HarnyClient['ingest'];
  ingestBatch: HarnyClient['ingestBatch'];
  getIngestion: HarnyClient['getIngestion'];
  waitForIngestion: HarnyClient['waitForIngestion'];
  deleteIngestion: HarnyClient['deleteIngestion'];
  deleteDataPoints: HarnyClient['deleteDataPoints'];
  recall: HarnyClient['recall'];
  usage: HarnyClient['usage'];
}

/**
 * Create the provider. Nothing is read or sent until the first call, so it is safe to create at import time.
 * `apiKey` defaults to HARNY_API_KEY, `baseURL` to HARNY_API_URL, else https://api.harny.ai.
 */
export function createHarny(options: HarnyClientOptions = {}): HarnyProvider {
  const client = new HarnyClient(options);

  const wrap = (model: LanguageModel, settings: MemorySettings = {}) => {
    const resolved: WrappableModel = typeof model === 'string' ? gateway(model) : model;
    return wrapLanguageModel({
      model: resolved,
      middleware: createMemoryMiddleware(client, settings),
    });
  };

  const provider = ((model: LanguageModel, settings?: MemorySettings) => wrap(model, settings)) as HarnyProvider;
  provider.languageModel = wrap;
  provider.middleware = (settings) => createMemoryMiddleware(client, settings);
  provider.tools = (settings) => createTools(client, { user: options.user, ...settings });
  provider.client = client;
  provider.ingest = client.ingest.bind(client);
  provider.ingestBatch = client.ingestBatch.bind(client);
  provider.getIngestion = client.getIngestion.bind(client);
  provider.waitForIngestion = client.waitForIngestion.bind(client);
  provider.deleteIngestion = client.deleteIngestion.bind(client);
  provider.deleteDataPoints = client.deleteDataPoints.bind(client);
  provider.recall = client.recall.bind(client);
  provider.usage = client.usage.bind(client);
  return provider;
}

/** A ready provider that reads HARNY_API_KEY and HARNY_API_URL. Name the person per call: harny(model, { user }). */
export const harny: HarnyProvider = createHarny();
