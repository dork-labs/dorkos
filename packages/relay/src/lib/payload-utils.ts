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

// === Sender identity extraction ===

/** Maximum length of a sanitized sender name or chat title, in characters. */
const MAX_IDENTITY_LENGTH = 80;

/** Sentinel value channel adapters fall back to when no display name is available. */
const UNKNOWN_SENDER = 'unknown';

/**
 * Sanitize a raw identity string (sender name or chat title) for safe
 * inclusion in a structured prompt header.
 *
 * Strips the C0 and C1 control ranges plus DEL — including CR/LF and NEL
 * (U+0085), any of which could otherwise forge additional header lines —
 * collapses whitespace runs to a single space (which also neutralizes the
 * U+2028/U+2029 line separators via `\s`), trims, and caps the result at
 * {@link MAX_IDENTITY_LENGTH} characters.
 *
 * @param value - The raw string to sanitize
 * @returns The sanitized string, or `undefined` if it is empty after sanitization
 */
function sanitizeIdentity(value: string): string | undefined {
  const collapsed = value
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.slice(0, MAX_IDENTITY_LENGTH);
}

/**
 * Extract the human sender's display name and chat/channel title from an
 * unknown Relay envelope payload, for forwarding into the agent's prompt.
 *
 * Safe-parses `senderName`/`channelName` off object payloads — non-object
 * payloads and non-string fields yield an absent value. Each present value is
 * sanitized via {@link sanitizeIdentity}, and a sanitized sender name equal to
 * `"unknown"` (case-insensitive — the channel adapters' own fallback
 * constant) is treated as absent: a label like "Telegram · unknown" is worse
 * than the plain "Telegram" it would replace.
 *
 * @param payload - The unknown payload from a RelayEnvelope
 * @returns The sanitized sender name and/or chat title, each omitted when absent
 */
export function extractSenderIdentity(payload: unknown): { sender?: string; chat?: string } {
  if (payload === null || typeof payload !== 'object') return {};
  const obj = payload as Record<string, unknown>;
  const result: { sender?: string; chat?: string } = {};

  if (typeof obj.senderName === 'string') {
    const sender = sanitizeIdentity(obj.senderName);
    if (sender !== undefined && sender.toLowerCase() !== UNKNOWN_SENDER) {
      result.sender = sender;
    }
  }

  if (typeof obj.channelName === 'string') {
    const chat = sanitizeIdentity(obj.channelName);
    if (chat !== undefined) {
      result.chat = chat;
    }
  }

  return result;
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

/** Maximum characters of a Bash command shown in a tool description. */
const COMMAND_PREVIEW_MAX_LENGTH = 60;

/**
 * Extract the verb phrase and detail text for a tool action.
 *
 * Pulls context from common tool input patterns (e.g., file paths for Write,
 * commands for Bash). The detail is raw — callers wrap it in the code styling
 * appropriate for their output format.
 */
function summarizeToolAction(toolName: string, input: string): { prefix: string; detail: string } {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (toolName === 'Write' && typeof parsed.path === 'string') {
      return { prefix: 'wants to write to', detail: parsed.path };
    }
    if (toolName === 'Edit' && typeof parsed.file_path === 'string') {
      return { prefix: 'wants to edit', detail: parsed.file_path };
    }
    if (toolName === 'Bash' && typeof parsed.command === 'string') {
      const cmd = parsed.command;
      const preview =
        cmd.length > COMMAND_PREVIEW_MAX_LENGTH
          ? `${cmd.slice(0, COMMAND_PREVIEW_MAX_LENGTH - 3)}...`
          : cmd;
      return { prefix: 'wants to run', detail: preview };
    }
  } catch {
    // input is not JSON — fall through to default
  }
  return { prefix: 'wants to use tool', detail: toolName };
}

/**
 * Format a human-readable description of a tool action in Markdown.
 *
 * Extracts context from common tool input patterns (e.g., file paths for Write,
 * commands for Bash) to produce a concise summary.
 *
 * @param toolName - The tool name (e.g., 'Write', 'Bash', 'Edit')
 * @param input - The raw tool input string (often JSON)
 */
export function formatToolDescription(toolName: string, input: string): string {
  const { prefix, detail } = summarizeToolAction(toolName, input);
  return `${prefix} \`${detail}\``;
}

/**
 * Format a tool action description as Telegram-safe HTML.
 *
 * HTML-escapes the extracted detail so adversarial tool input (backticks,
 * underscores, angle brackets) cannot break Telegram's HTML parser — a
 * malformed approval card would otherwise fail with a 400 and the tool call
 * would hang until timeout.
 *
 * @param toolName - The tool name (e.g., 'Write', 'Bash', 'Edit')
 * @param input - The raw tool input string (often JSON)
 */
export function formatToolDescriptionHtml(toolName: string, input: string): string {
  const { prefix, detail } = summarizeToolAction(toolName, input);
  return `${prefix} <code>${escapeHtml(detail)}</code>`;
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

// === Message splitting ===

/** Maximum message length for Telegram (4096 minus safety margin). */
export const TELEGRAM_MAX_LENGTH = 4000;

/** Telegram's hard per-message character limit. */
export const TELEGRAM_HARD_LIMIT = 4096;

/** Maximum message length for Slack (4000 minus safety margin). */
export const SLACK_MAX_LENGTH = 3500;

/** Fence close appended to a chunk that splits inside a code block. */
const FENCE_CLOSE = '\n```';

/** Fence re-open prepended to the remainder after a mid-fence split. */
const FENCE_REOPEN = '```\n';

/**
 * Find the best split point in `text` at or before `budget`.
 *
 * Prefers a paragraph break, then a line break, then a word boundary,
 * falling back to a hard cut at the budget.
 */
function findSplitPoint(text: string, budget: number): number {
  const paraBreak = text.lastIndexOf('\n\n', budget);
  if (paraBreak > 0) return paraBreak + 2;
  const lineBreak = text.lastIndexOf('\n', budget);
  if (lineBreak > 0) return lineBreak + 1;
  const space = text.lastIndexOf(' ', budget);
  if (space > 0) return space + 1;
  return budget;
}

/**
 * Cut one chunk off `remaining`, closing and re-opening code fences at the
 * split point so both sides stay renderable.
 */
function takeChunk(remaining: string, budget: number): { chunk: string; rest: string } {
  let splitAt = findSplitPoint(remaining, budget);
  let chunk = remaining.slice(0, splitAt);
  let rest = remaining.slice(splitAt);

  if (countUnmatchedFences(chunk) % 2 !== 0) {
    // A boundary right after an opening fence would consume no more
    // characters than the fence re-open adds back — hard-cut at the budget
    // instead so the loop always makes forward progress.
    if (splitAt <= FENCE_REOPEN.length) {
      splitAt = budget;
      chunk = remaining.slice(0, splitAt);
      rest = remaining.slice(splitAt);
    }
    if (countUnmatchedFences(chunk) % 2 !== 0) {
      chunk += FENCE_CLOSE;
      rest = FENCE_REOPEN + rest;
    }
  }

  return { chunk, rest };
}

/**
 * Split a message string into chunks that respect a platform's character limit.
 *
 * Prefers splitting at natural boundaries (paragraph breaks, line breaks, word
 * boundaries) to avoid breaking mid-sentence. Handles code fence awareness so
 * split chunks close and re-open fenced code blocks correctly — every chunk,
 * including one that gains a fence close, stays within `maxLen`.
 *
 * For nonsensically small limits (`maxLen` <= 8, below the space a fence
 * close/re-open pair needs) chunks may slightly exceed `maxLen`: guaranteed
 * termination wins over honoring a limit no real platform has.
 *
 * @param text - The full message text
 * @param maxLen - Maximum characters per chunk (defaults to {@link TELEGRAM_MAX_LENGTH})
 */
export function splitMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  // Reserve room for the fence close so a chunk split inside a code block
  // never exceeds maxLen after '\n```' is appended. The lower clamp keeps the
  // budget strictly larger than the fence re-open prefix, so every iteration
  // consumes more characters than a mid-fence split adds back — without it,
  // maxLen <= 8 made the remainder grow each pass and the loop never ended.
  const budget = Math.max(FENCE_REOPEN.length + 1, maxLen - FENCE_CLOSE.length);

  while (remaining.length > budget) {
    const { chunk, rest } = takeChunk(remaining, budget);
    chunks.push(chunk);
    remaining = rest;
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/** Smallest raw-Markdown budget {@link splitTelegramHtml} retries with before giving up. */
const MIN_TELEGRAM_SPLIT_BUDGET = 512;

/**
 * Split raw Markdown into Telegram-ready HTML chunks.
 *
 * Splits the raw Markdown first (code-fence aware), then converts each chunk
 * to HTML — splitting after conversion would cut inside `<pre>`/`<b>` tags and
 * produce chunks Telegram's parser rejects with a 400, failing the entire
 * delivery. Each converted chunk is verified against Telegram's 4096 hard
 * limit; chunks that overshoot due to HTML expansion (entity escaping, tags)
 * are re-split with a halved budget until they fit.
 *
 * @param markdown - The full message text in standard Markdown
 * @param budget - Maximum raw-Markdown characters per chunk before conversion
 */
export function splitTelegramHtml(markdown: string, budget = TELEGRAM_MAX_LENGTH): string[] {
  const chunks: string[] = [];
  for (const raw of splitMessage(markdown, budget)) {
    const html = formatForPlatform(raw, 'telegram');
    if (html.length <= TELEGRAM_HARD_LIMIT || budget <= MIN_TELEGRAM_SPLIT_BUDGET) {
      chunks.push(html);
    } else {
      chunks.push(...splitTelegramHtml(raw, Math.floor(budget / 2)));
    }
  }
  return chunks;
}

/**
 * Count triple-backtick fences in a text fragment.
 *
 * An odd count means a code block was opened but not closed within the fragment.
 *
 * @param text - The text to scan for fences
 */
function countUnmatchedFences(text: string): number {
  let count = 0;
  let idx = 0;
  while (idx < text.length) {
    const pos = text.indexOf('```', idx);
    if (pos === -1) break;
    count++;
    idx = pos + 3;
  }
  return count;
}

// === Format conversion ===

/**
 * Escape HTML entities for safe inclusion in Telegram HTML parse mode.
 *
 * Use for any user- or agent-controlled text interpolated into a message sent
 * with `parse_mode: 'HTML'` — unescaped `<`, `>`, or `&` makes Telegram reject
 * the whole message with a 400.
 *
 * @param text - Raw text to escape
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
  // Escape HTML entities first (before adding our own tags)
  let html = escapeHtml(md);

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
  platform: 'slack' | 'telegram' | 'plain'
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
