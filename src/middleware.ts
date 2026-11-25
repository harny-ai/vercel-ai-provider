import type { LanguageModelMiddleware } from 'ai';
import type { HarnyClient } from './client.js';
import { DEFAULT_HEADING, formatMemories } from './format.js';
import { defaultConversationKey, lastUserQuery, newUserTurns, turnId, type PromptMessage } from './messages.js';
import type { RecallLevel, RecallPending, RecallResult } from './types.js';

export interface MemorySettings {
  /** The end user. Defaults to the `user` given to createHarny. */
  user?: string;
  /** Recall before each turn. Default true. */
  recall?: boolean;
  /** Evidence size for recall. Default 'low'. Not with `maxTokens`. */
  level?: RecallLevel;
  /** Evidence budget in tokens. Not with `level`. */
  maxTokens?: number;
  /** Most memories to inject. Default 20. */
  limit?: number;
  /** Store the person's messages after a successful call. User turns only: assistant text is never stored. Default false: saving conversation messages is opt-in (`saveUserMessages: true`). */
  saveUserMessages?: boolean;
  /** Names the conversation for the ids of stored messages. Default: a hash of the first user message. */
  conversationId?: string | ((prompt: readonly PromptMessage[]) => string | Promise<string>);
  /** The line above the injected memories. */
  heading?: string;
  /** Replace the whole injected block. Return '' to inject nothing. */
  formatMemories?: (results: readonly RecallResult[]) => string;
  /** Extra metadata on every stored message. */
  metadata?: Record<string, unknown>;
  /** Memory trouble never fails the model call; it comes here. */
  onError?: (error: unknown, context: { stage: 'recall' | 'ingest' }) => void;
  /** Called when recall reports sends still being processed, so the answer may miss the newest facts. */
  onPending?: (pending: RecallPending) => void;
  /**
   * Hand the store to the host so the response is not held back (for example Vercel's waitUntil).
   * Without it the call waits for the store to finish.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** How long a recall answer is reused for the same person and question (tool loops ask again). Default 30000 ms. */
  cacheTtlMs?: number;
}

const DEFAULT_LIMIT = 20;

/** The memory middleware: recall into the system prompt before the call, store the person's message after it. */
export function createMemoryMiddleware(client: HarnyClient, settings: MemorySettings = {}): LanguageModelMiddleware {
  const cache = new Map<string, { block: string; expires: number }>();
  const stored = new Set<string>();
  const ttl = settings.cacheTtlMs ?? 30_000;

  const report = (error: unknown, stage: 'recall' | 'ingest') => {
    try {
      settings.onError?.(error, { stage });
    } catch {
      // A failing error handler must not fail the call either.
    }
  };

  async function recallBlock(prompt: readonly PromptMessage[]): Promise<string> {
    if (settings.recall === false) return '';
    const query = lastUserQuery(prompt);
    if (!query) return '';
    const user = client.actingUser(settings.user);
    if (!user) throw new Error("Name the end user: pass user to createHarny or to the call's settings.");
    const cacheKey = `${user}\n${query}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.block;
    const answer = await client.recall({
      query,
      user,
      limit: settings.limit ?? DEFAULT_LIMIT,
      ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : { level: settings.level ?? 'low' }),
    });
    if (answer.pending) {
      try {
        settings.onPending?.(answer.pending);
      } catch {
        // see report()
      }
    }
    const block = settings.formatMemories
      ? settings.formatMemories(answer.results)
      : formatMemories(answer.results, settings.heading ?? DEFAULT_HEADING);
    cache.set(cacheKey, { block, expires: Date.now() + ttl });
    return block;
  }

  async function saveTurns(prompt: readonly PromptMessage[]): Promise<void> {
    if (settings.saveUserMessages !== true) return;
    const turns = newUserTurns(prompt);
    if (!turns.length) return;
    const user = client.actingUser(settings.user);
    if (!user) throw new Error("Name the end user: pass user to createHarny or to the call's settings.");
    const conversation =
      typeof settings.conversationId === 'function'
        ? await settings.conversationId(prompt)
        : (settings.conversationId ?? (await defaultConversationKey(prompt)));
    for (const text of turns) {
      const id = await turnId(conversation, text);
      const memoKey = `${user}\n${id}`;
      if (stored.has(memoKey)) continue;
      await client.ingest({
        content: text,
        id,
        label: 'User message',
        timestamp: new Date(),
        user,
        ...(settings.metadata ? { metadata: settings.metadata } : {}),
      });
      stored.add(memoKey);
    }
  }

  function store(prompt: readonly PromptMessage[]): Promise<void> | undefined {
    const work = saveTurns(prompt).catch((error) => report(error, 'ingest'));
    if (settings.waitUntil) {
      try {
        settings.waitUntil(work);
      } catch (error) {
        report(error, 'ingest');
      }
      return undefined;
    }
    return work;
  }

  return {
    transformParams: async ({ params }) => {
      const prompt = params.prompt as unknown as PromptMessage[];
      let block = '';
      try {
        block = await recallBlock(prompt);
      } catch (error) {
        report(error, 'recall');
      }
      if (!block) return params;
      const messages = [...params.prompt];
      const first = messages[0];
      if (first && first.role === 'system') {
        messages[0] = { ...first, content: `${first.content}\n\n${block}` };
      } else {
        messages.unshift({ role: 'system', content: block });
      }
      return { ...params, prompt: messages };
    },

    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      await store(params.prompt as unknown as PromptMessage[]);
      return result;
    },

    wrapStream: async ({ doStream, params }) => {
      const result = await doStream();
      let failed = false;
      const prompt = params.prompt as unknown as PromptMessage[];
      const stream = result.stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if ((chunk as { type?: string }).type === 'error') failed = true;
            controller.enqueue(chunk);
          },
          async flush() {
            if (!failed) await store(prompt);
          },
        }),
      );
      return { ...result, stream };
    },
  };
}
