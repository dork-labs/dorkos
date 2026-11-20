import type { Buffer } from 'node:buffer';

type Direction = 'guardian-to-anchor' | 'anchor-to-guardian';

export function createControlWriter(
  secret: string,
  channel: string,
  direction: Direction
): (kind: string, payload: unknown) => Buffer;

export function createControlReader(
  secret: string,
  channel: string,
  direction: Direction,
  receive: (kind: string, payload: unknown) => void
): { push(chunk: Uint8Array): void; end(): void };
