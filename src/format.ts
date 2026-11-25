import type { RecallResult } from './types.js';

export const DEFAULT_HEADING =
  'What you remember about this person from earlier conversations, most relevant first. Use it when it helps; do not mention it unless asked:';

/** The recalled evidence as a short block for a system prompt. Empty string when there is none. */
export function formatMemories(results: readonly RecallResult[], heading: string = DEFAULT_HEADING): string {
  const lines = results
    .filter((result) => result.content && result.content.trim())
    .map((result) => {
      const when = result.occurredAt ? ` (${result.occurredAt.slice(0, 10)})` : '';
      return `- ${result.content.trim()}${when}`;
    });
  return lines.length ? `${heading}\n${lines.join('\n')}` : '';
}
