/** A prompt message in the AI SDK's shape (`LanguageModelV4Prompt` entries and `ModelMessage` both fit). */
export interface PromptMessage {
  role: string;
  content: unknown;
}

/** The text of one message: its text parts joined by a newline. Files, tool calls and reasoning are left out. */
export function textOf(message: PromptMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => !!part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** The text of the last user message, which is what the person just asked. */
export function lastUserQuery(prompt: readonly PromptMessage[]): string | undefined {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message?.role === 'user') {
      const text = textOf(message);
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * The user turns that are new in this call: the user messages after the last assistant or tool message.
 * Assistant text is never returned (user turns only).
 */
export function newUserTurns(prompt: readonly PromptMessage[]): string[] {
  let start = 0;
  for (let i = prompt.length - 1; i >= 0; i--) {
    const role = prompt[i]?.role;
    if (role === 'assistant' || role === 'tool') {
      start = i + 1;
      break;
    }
  }
  return prompt
    .slice(start)
    .filter((message) => message.role === 'user')
    .map(textOf)
    .filter((text) => text.length > 0);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The id of a stored user turn: a hash of the conversation key and the text, so a repeat replaces itself. */
export async function turnId(conversationKey: string, text: string): Promise<string> {
  return `turn-${await sha256Hex(`${conversationKey}\n${text}`)}`;
}

/** The conversation key when none is set: a hash of the first user message, which stays fixed as the chat grows. */
export async function defaultConversationKey(prompt: readonly PromptMessage[]): Promise<string> {
  const first = prompt.find((message) => message.role === 'user');
  return sha256Hex(first ? textOf(first) : '');
}
