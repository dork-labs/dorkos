import type { CommunityConfig } from './config.js';
import { ApiError } from './http.js';
import { signValue, verifyValue } from './security.js';

interface Position {
  version: 1;
  communityId: string;
  channelId: string;
  thread: string | null;
  epoch: number;
  seq: number;
}

/** Create a signed channel and thread scoped cursor. */
export function encodeCursor(position: Position, config: CommunityConfig): string {
  return signValue(Buffer.from(JSON.stringify(position)).toString('base64url'), config.authSecret);
}

/** Reject tampered, foreign or stale cursor scopes before reading rows. */
export function decodeCursor(
  value: string,
  scope: Omit<Position, 'seq' | 'version'>,
  config: CommunityConfig
): number {
  const raw = verifyValue(value, config.authSecret);
  if (!raw) throw new ApiError(410, 'CURSOR_STALE', 'This cursor is no longer valid.');
  let parsed: Position;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Position;
  } catch {
    throw new ApiError(410, 'CURSOR_STALE', 'This cursor is no longer valid.');
  }
  if (
    parsed.version !== 1 ||
    parsed.communityId !== scope.communityId ||
    parsed.channelId !== scope.channelId ||
    parsed.thread !== scope.thread ||
    parsed.epoch !== scope.epoch ||
    !Number.isSafeInteger(parsed.seq) ||
    parsed.seq < 0
  ) {
    throw new ApiError(
      410,
      'CURSOR_STALE',
      'This cursor belongs to another channel or an older state.'
    );
  }
  return parsed.seq;
}

/**
 * Where a reader of one channel's redaction feed stands: after `id` in `entry_redactions`,
 * under the community's current redaction epoch. The epoch is a random 64-bit value, carried
 * as its decimal string so no digit is lost; `erasure:reapply` replaces it after a restore.
 */
interface RedactionPosition {
  version: 1;
  kind: 'redaction';
  communityId: string;
  channelId: string;
  epoch: string;
  id: number;
}

/** Create a signed redaction feed cursor for one channel. */
export function encodeRedactionCursor(
  position: Omit<RedactionPosition, 'version' | 'kind'>,
  config: CommunityConfig
): string {
  const value: RedactionPosition = { version: 1, kind: 'redaction', ...position };
  return signValue(Buffer.from(JSON.stringify(value)).toString('base64url'), config.authSecret);
}

/**
 * Read the redaction id a feed cursor resumes after. A tampered cursor, a history page cursor,
 * another channel's or community's cursor, or one from before the epoch changed answers `410`,
 * and the reader starts the feed again from the beginning.
 */
export function decodeRedactionCursor(
  value: string,
  scope: Omit<RedactionPosition, 'version' | 'kind' | 'id'>,
  config: CommunityConfig
): number {
  const raw = verifyValue(value, config.authSecret);
  let parsed: Partial<RedactionPosition> | null = null;
  if (raw) {
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as RedactionPosition;
    } catch {
      parsed = null;
    }
  }
  if (
    !parsed ||
    parsed.version !== 1 ||
    parsed.kind !== 'redaction' ||
    parsed.communityId !== scope.communityId ||
    parsed.channelId !== scope.channelId ||
    parsed.epoch !== scope.epoch ||
    !Number.isSafeInteger(parsed.id) ||
    (parsed.id as number) < 0
  ) {
    throw new ApiError(
      410,
      'CURSOR_STALE',
      'This cursor belongs to another channel or an older state. Read the changes again from the start.'
    );
  }
  return parsed.id as number;
}
