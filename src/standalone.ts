import { HarnyClient } from './client.js';
import { DEFAULT_HEADING, formatMemories } from './format.js';
import { lastUserQuery, textOf, turnId, type PromptMessage } from './messages.js';
import type { HarnyClientOptions, IngestReceipt, RecallLevel, RecallResult } from './types.js';

export interface MemoryCallOptions extends HarnyClientOptions {
  level?: RecallLevel;
  maxTokens?: number;
  limit?: number;
  /** For `addMemories`: names the conversation for the ids. Default 'default'. */
  conversationId?: string;
  /** For `addMemories`: extra metadata on every stored message. */
  metadata?: Record<string, unknown>;
  /** For `retrieveMemories`: the line above the memories. */
  heading?: string;
}

function asPrompt(prompt: string | readonly PromptMessage[]): PromptMessage[] {
  return typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : [...prompt];
}

/**
 * Store the user messages of a prompt-shaped array. Assistant and system messages are skipped: only what the
 * person said is kept. Returns one receipt per stored message.
 */
export async function addMemories(
  messages: readonly PromptMessage[],
  options: MemoryCallOptions = {},
): Promise<IngestReceipt[]> {
  const client = new HarnyClient(options);
  const conversation = options.conversationId ?? 'default';
  const receipts: IngestReceipt[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = textOf(message);
    if (!text) continue;
    receipts.push(
      await client.ingest({
        content: text,
        id: await turnId(conversation, text),
        label: 'User message',
        timestamp: new Date(),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      }),
    );
  }
  return receipts;
}

/** The raw recalled results for the last user message of a prompt (or for a plain string). */
export async function getMemories(
  prompt: string | readonly PromptMessage[],
  options: MemoryCallOptions = {},
): Promise<RecallResult[]> {
  const query = lastUserQuery(asPrompt(prompt));
  if (!query) return [];
  const client = new HarnyClient(options);
  const answer = await client.recall({
    query,
    limit: options.limit ?? 20,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : { level: options.level ?? 'low' }),
  });
  return answer.results;
}

/** A system-prompt block with the recalled memories, or '' when there are none. */
export async function retrieveMemories(
  prompt: string | readonly PromptMessage[],
  options: MemoryCallOptions = {},
): Promise<string> {
  return formatMemories(await getMemories(prompt, options), options.heading ?? DEFAULT_HEADING);
}
