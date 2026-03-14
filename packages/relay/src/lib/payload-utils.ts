/**
 * Payload extraction utilities for Relay adapters.
 *
 * Provides a single, shared implementation for extracting text content from
 * unknown Relay envelope payloads. Used by both the Telegram and Claude Code
 * adapters to avoid duplicated extraction logic.
 *
 * Also provides StreamEvent detection helpers for adapters that need to
 * aggregate streaming events (e.g. TelegramAdapter buffers text_delta chunks).
 *
 * @module relay/lib/payload-utils
 */
import { slackifyMarkdown } from 'slackify-markdown';

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

// === StreamEvent helpers ===

/** Known StreamEvent types that carry no user-visible text. */
export const SILENT_EVENT_TYPES = new Set([
  'session_status',
  'tool_call_start',
  'tool_call_delta',
  'tool_call_end',
  'tool_result',
  'approval_required',
  'question_prompt',
  'task_update',
  'relay_receipt',
  'message_delivered',
  'relay_message',
]);

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

// === Format conversion ===

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
      // Telegram accepts standard Markdown via parse_mode: 'MarkdownV2'
      // but our current implementation sends plain text. Pass through for now.
      return content;
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
