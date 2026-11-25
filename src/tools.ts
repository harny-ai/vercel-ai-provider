import { jsonSchema, tool } from 'ai';
import type { HarnyClient } from './client.js';
import type { RecallLevel } from './types.js';

export interface ToolSettings {
  /** The end user the tools act for. Defaults to the `user` given to createHarny. */
  user?: string;
  /** Evidence size for harny_recall. Default 'low'. */
  level?: RecallLevel;
  /** Most results harny_recall returns. Default 10. */
  limit?: number;
}

/**
 * Two tools to put in a tool set: `harny_remember` stores a fact or preference, `harny_recall` looks something up.
 * The person is fixed by you (settings or createHarny), never chosen by the model.
 */
export function createTools(client: HarnyClient, settings: ToolSettings = {}) {
  return {
    harny_remember: tool({
      description:
        'Remember a fact or preference about the person for later conversations. Use it when they tell you something worth keeping, such as a preference, a decision, a date or a number. Write one self-contained sentence.',
      inputSchema: jsonSchema<{ content: string; label?: string; id?: string; timestamp?: string }>({
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact, as one self-contained sentence.' },
          label: { type: 'string', description: 'A short name for it, for example "Budget change".' },
          id: {
            type: 'string',
            description: 'Your id for this fact. Sending the same id again replaces the earlier text. Omit it for a new fact.',
          },
          timestamp: {
            type: 'string',
            description: 'When it happened, ISO 8601 with a zone, for example 2026-03-01T09:00:00Z. Omit it for now.',
          },
        },
        required: ['content'],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const receipt = await client.ingest({
          content: input.content,
          ...(input.label ? { label: input.label } : {}),
          ...(input.id ? { id: input.id } : {}),
          ...(input.timestamp ? { timestamp: input.timestamp } : {}),
          ...(settings.user ? { user: settings.user } : {}),
        });
        return { status: receipt.status, ingestionId: receipt.ingestionId, sourceId: receipt.sourceId };
      },
    }),

    harny_recall: tool({
      description:
        'Recall what you know about the person: facts, preferences and past events, newest evidence first when it conflicts. Use it before you answer a question about them or their work.',
      inputSchema: jsonSchema<{ query: string }>({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, as a question or a few keywords.' },
        },
        required: ['query'],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const answer = await client.recall({
          query: input.query,
          level: settings.level ?? 'low',
          limit: settings.limit ?? 10,
          ...(settings.user ? { user: settings.user } : {}),
        });
        return {
          results: answer.results.map((result) => ({
            content: result.content,
            occurredAt: result.occurredAt ?? null,
            sourceIds: (result.sources ?? []).map((source) => source.sourceId),
          })),
          ...(answer.pending ? { pending: answer.pending.message } : {}),
        };
      },
    }),
  };
}
