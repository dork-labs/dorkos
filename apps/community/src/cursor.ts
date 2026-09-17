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
