/** Search only main conversation prose; opaque model fields never leave this projection. */
import { isKickoffEnvelope } from '@dorkos/shared/kickoff';
import type { Projection } from '../types.js';

export interface DoeMessageRow {
  seq: number;
  payload: string;
}

/** Pure projection supporting string, Anthropic/Pi text, and Responses text content. */
export function projectDoeMessages(originKey: string, rows: readonly DoeMessageRow[]): Projection {
  const result: Projection = { messages: [], skipped: 0 };
  for (const row of rows) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(row.payload);
    } catch {
      result.skipped++;
      continue;
    }
    if (!message || typeof message !== 'object') {
      result.skipped++;
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content = message.content;
    const body =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((part) =>
                part &&
                typeof part === 'object' &&
                ['text', 'input_text', 'output_text'].includes(part.type) &&
                typeof part.text === 'string'
                  ? [part.text]
                  : []
              )
              .join('\n')
          : '';
    if (!body.trim() || isKickoffEnvelope(body)) continue;
    const timestamp = message.timestamp;
    const date =
      typeof timestamp === 'number' || typeof timestamp === 'string' ? new Date(timestamp) : null;
    result.messages.push({
      originKey,
      ordinal: row.seq,
      role: message.role,
      body,
      messageId: typeof message.id === 'string' ? message.id : null,
      createdAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
    });
  }
  return result;
}
