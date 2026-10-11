/** Closed temporary writer DATA encoding; no file write or authority issuer. */
import { createHash } from 'node:crypto';
import type { CanvasChannelEventReceipt } from '@dorkos/shared/canvas-channel-schemas';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type WriteRequest =
  | { operationId: string; kind: 'comment'; text: string }
  | { operationId: string; kind: 'toggle'; checked: boolean }
  | { operationId: string; kind: 'undo'; originalOperationId: string };
export interface WriterReceipt {
  operationId: string;
  requestHash: string;
  beforeHash: string;
  afterHash: string;
  file: 'notes/task.md';
  savedAt: string;
  mutationOrdinal: number;
}
export interface WriterOperation {
  request: WriteRequest;
  requestHash: string;
  envelopeHash: string;
  beforeHash: string;
  afterHash: string;
  after: string;
  createdAt: number;
  phase: 'intent' | 'saved' | 'in_doubt';
  writerReceipt?: WriterReceipt;
  handoff: 'pending' | 'sending' | 'recorded' | 'in_doubt';
  event: {
    v: 1;
    id: string;
    type: 'task.comment' | 'task.toggle';
    payload: Record<string, string | boolean>;
    coalesceKey?: string;
  };
  channelReceipt?: CanvasChannelEventReceipt;
}
export type FaultStage = 'intent-durable' | 'file-replaced' | 'receipt-durable';
/** Require a truthy writer DATA condition, preserving the supplied refusal reason. */
export function need(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
/** Encode closed writer request DATA with deterministic object key order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  need(
    typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
    'Plain canonical request required'
  );
  return (
    '{' +
    Object.keys(value as object)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]))
      .join(',') +
    '}'
  );
}
/** Compute the hexadecimal SHA-256 digest of canonical writer DATA. */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** Validate the closed writer request shape and return a detached copy of its DATA. */
export function request(raw: unknown): WriteRequest {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'Writer request required');
  const row = raw as Record<string, unknown>;
  need(typeof row.operationId === 'string' && UUID.test(row.operationId), 'Stable UUID required');
  const keys =
    row.kind === 'comment'
      ? ['kind', 'operationId', 'text']
      : row.kind === 'toggle'
        ? ['kind', 'operationId', 'checked']
        : ['kind', 'operationId', 'originalOperationId'];
  need(
    Object.keys(row).length === keys.length && Object.keys(row).every((key) => keys.includes(key)),
    'Closed writer request required'
  );
  if (row.kind === 'comment')
    need(
      typeof row.text === 'string' && row.text.trim() && Buffer.byteLength(row.text) <= 8192,
      'Bounded nonempty comment'
    );
  else if (row.kind === 'toggle') need(typeof row.checked === 'boolean', 'Checkbox value required');
  else
    need(
      row.kind === 'undo' &&
        typeof row.originalOperationId === 'string' &&
        UUID.test(row.originalOperationId),
      'Original Undo UUID required'
    );
  return JSON.parse(JSON.stringify(row)) as WriteRequest;
}
