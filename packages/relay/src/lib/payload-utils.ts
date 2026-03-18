/**
 * Payload extraction utilities for Relay adapters.
 *
 * Provides a single, shared implementation for extracting text content from
 * unknown Relay envelope payloads. Used by both the Telegram and Claude Code
 * adapters to avoid duplicated extraction logic.
 *
 * Also provides StreamEvent detection helpers for adapters that need to
 * aggregate streaming events (e.g. TelegramAdapter buffers text_delta chunks),
 * and envelope field extractors shared across outbound delivery modules.
 *
 * @module relay/lib/payload-utils
 */
import { slackifyMarkdown } from 'slackify-markdown';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

/**
 * Extract text content from an unknown Relay envelope payload.
 *
 * Checks for `content` and `text` string fields on object payloads,
 * falls back to JSON serialization for other shapes.
 *
 * @param payload - The unknown payload from a RelayEnvelope
 */
export function extractPayloadContent(payload: unknown): string {
  if (typeof payload === 'string') return payload;

  if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.text === 'string') return obj.text;
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return '[unserializable payload]';
  }
}

/**
 * Truncate a string to a maximum length, appending an ellipsis if cut.
 *
 * @param text - The text to truncate
 * @param maxLen - Maximum character length
 */
export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

// === StreamEvent helpers ===

/**
 * Check whether a payload looks like a StreamEvent from the agent SDK pipeline.
 *
 * A StreamEvent has a `type` string and a `data` field.
 *
 * @param payload - The unknown payload to inspect
 * @returns The event type string if it's a StreamEvent, otherwise null
 */
export function detectStreamEventType(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.type !== 'string' || !('data' in obj)) return null;
  return obj.type;
}

/**
 * Extract text from a text_delta StreamEvent payload.
 *
 * @param payload - The unknown payload to inspect
 * @returns The text string, or null if the payload is not a text_delta
 */
export function extractTextDelta(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (obj.type !== 'text_delta') return null;
  const data = obj.data as Record<string, unknown> | undefined;
  if (!data || typeof data.text !== 'string') return null;
  return data.text;
}

/**
 * Extract error message from an error StreamEvent payload.
 *
 * @param payload - The unknown payload to inspect
 * @returns The error message, or null if the payload is not an error event
 */
export function extractErrorMessage(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (obj.type !== 'error') return null;
  const data = obj.data as Record<string, unknown> | undefined;
  return typeof data?.message === 'string' ? data.message : null;
}

// === Tool approval helpers ===

/** Parsed tool approval data from an approval_required StreamEvent. */
export interface ApprovalData {
  toolCallId: string;
  toolName: string;
  input: string;
  timeoutMs: number;
}

/**
 * Extract tool approval data from an approval_required StreamEvent payload.
 *
 * @param payload - The unknown payload to inspect
 * @returns Parsed approval data, or null if the payload is not a valid approval_required event
 */
export function extractApprovalData(payload: unknown): ApprovalData | null {
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (obj.type !== 'approval_required') return null;
  const data = obj.data as Record<string, unknown> | undefined;
  if (!data?.toolCallId || !data?.toolName) return null;
  return {
    toolCallId: data.toolCallId as string,
    toolName: data.toolName as string,
    input: (data.input as string) ?? '',
    timeoutMs: (data.timeoutMs as number) ?? 600_000,
  };
}

/**
 * Format a human-readable description of a tool action.
 *
 * Extracts context from common tool input patterns (e.g., file paths for Write,
 * commands for Bash) to produce a concise summary.
 *
 * @param toolName - The tool name (e.g., 'Write', 'Bash', 'Edit')
 * @param input - The raw tool input string (often JSON)
 */
export function formatToolDescription(toolName: string, input: string): string {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (toolName === 'Write' && typeof parsed.path === 'string') {
      return `wants to write to \`${parsed.path}\``;
    }
    if (toolName === 'Edit' && typeof parsed.file_path === 'string') {
      return `wants to edit \`${parsed.file_path}\``;
    }
    if (toolName === 'Bash' && typeof parsed.command === 'string') {
      const cmd = parsed.command as string;
      const preview = cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
      return `wants to run \`${preview}\``;
    }
  } catch {
    // input is not JSON — fall through to default
  }
  return `wants to use tool \`${toolName}\``;
}

// === Envelope field extraction ===

/**
 * Extract the agent ID from a RelayEnvelope's nested payload data.
 *
 * Used by outbound delivery to correlate messages with agent sessions.
 *
 * @param envelope - The relay envelope to inspect
 * @returns The agent ID, or undefined if not present
 */
export function extractAgentIdFromEnvelope(envelope: RelayEnvelope): string | undefined {
  const payload = envelope.payload;
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const data = (payload as Record<string, unknown>).data;
    if (data && typeof data === 'object' && 'agentId' in data) {
      return (data as Record<string, unknown>).agentId as string | undefined;
    }
  }
  return undefined;
}

/**
 * Extract the CCA session key from a RelayEnvelope's nested payload data.
 *
 * Used by outbound delivery to route approval responses to the correct session.
 *
 * @param envelope - The relay envelope to inspect
 * @returns The session key, or undefined if not present
 */
export function extractSessionIdFromEnvelope(envelope: RelayEnvelope): string | undefined {
  const payload = envelope.payload;
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const data = (payload as Record<string, unknown>).data;
    if (data && typeof data === 'object' && 'ccaSessionKey' in data) {
      return (data as Record<string, unknown>).ccaSessionKey as string | undefined;
    }
  }
  return undefined;
}

// === Format conversion ===

/**
 * Convert standard Markdown to Telegram's supported HTML subset.
 *
 * Telegram supports: `<b>`, `<i>`, `<s>`, `<code>`, `<pre>`, `<a href="">`.
 * HTML parse mode avoids MarkdownV2's painful escaping requirements.
 *
 * @param md - Standard Markdown text
 * @returns HTML suitable for Telegram's `parse_mode: 'HTML'`
 */
function markdownToTelegramHtml(md: string): string {
  let html = md;

  // Escape HTML entities first (before adding our own tags)
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks (```lang\n...\n```) -> <pre><code class="language-lang">...</code></pre>
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const cls = (lang as string) ? ` class="language-${lang as string}"` : '';
    return `<pre><code${cls}>${(code as string).trimEnd()}</code></pre>`;
  });

  // Inline code (`...`) -> <code>...</code>
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold (**...**) -> <b>...</b>
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Italic (*...*) -> <i>...</i>
  html = html.replace(/\*(.+?)\*/g, '<i>$1</i>');

  // Strikethrough (~~...~~) -> <s>...</s>
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links [text](url) -> <a href="url">text</a>
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');

  // Headings (# ...) -> bold (Telegram has no heading tag)
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  return html;
}

/**
 * Convert standard Markdown to a platform-specific format.
 *
 * @param content - Standard Markdown text (as produced by agents)
 * @param platform - Target platform identifier
 * @returns Content formatted for the target platform
 */
export function formatForPlatform(
  content: string,
  platform: 'slack' | 'telegram' | 'plain',
): string {
  switch (platform) {
    case 'slack':
      return slackifyMarkdown(content);
    case 'telegram':
      return markdownToTelegramHtml(content);
    case 'plain':
      // Strip Markdown formatting for webhook adapter and similar
      return content
        .replace(/\*\*(.+?)\*\*/g, '$1') // bold
        .replace(/\*(.+?)\*/g, '$1') // italic
        .replace(/__(.+?)__/g, '$1') // bold (underscore)
        .replace(/_(.+?)_/g, '$1') // italic (underscore)
        .replace(/~~(.+?)~~/g, '$1') // strikethrough
        .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/`{3}\w*\n?/g, '').trim()) // code blocks
        .replace(/`(.+?)`/g, '$1') // inline code
        .replace(/^#{1,6}\s+/gm, '') // headings
        .replace(/^[*-]\s+/gm, '- ') // list items
        .replace(/^>\s+/gm, '') // blockquotes
        .replace(/\[(.+?)\]\(.+?\)/g, '$1'); // links
  }
}
