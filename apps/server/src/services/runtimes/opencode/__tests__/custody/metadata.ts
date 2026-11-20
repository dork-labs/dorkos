/** The broker carries only local rendezvous metadata. Native input uses a separate channel. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';

export const MAX_METADATA_BYTES = 4096;
const VERSION = 1;
const ID = /^[a-f0-9]{32}$/;
const KEY = /^[a-f0-9]{64}$/;

export interface RunDescriptor {
  readonly version: 1;
  readonly runId: string;
  readonly generation: string;
  readonly capability: string;
}
interface TokenConnection {
  readonly endpointId: string;
  readonly token: string;
}
export type ConnectionDescriptor = TokenConnection &
  ({ readonly transport?: never } | { readonly transport: 'posix'; readonly directory: string });
interface Coordinates {
  readonly requestId: string;
  readonly scopeId: string;
}
export type WorkerMetadata = Coordinates &
  ({ readonly kind: 'acquire'; readonly deadline: number | null } | { readonly kind: 'cancel' });

export type BrokerMetadata = Coordinates &
  (
    | { readonly kind: 'ready'; readonly connection: ConnectionDescriptor }
    | { readonly kind: 'refused'; readonly reason: 'expired' | 'busy' | 'unavailable' }
  );

type Metadata = WorkerMetadata | BrokerMetadata;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function key(value: unknown): value is string {
  return typeof value === 'string' && KEY.test(value);
}

/** Verify the portable part of one private broker generation's descriptor. */
export function validRunDescriptor(run: RunDescriptor): boolean {
  return run.version === VERSION && id(run.runId) && id(run.generation) && key(run.capability);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((name) => Object.hasOwn(value, name))
  );
}

/** Only the endpoint ID and one-use connection token can leave endpoint negotiation. */
export function validConnection(value: unknown): value is ConnectionDescriptor {
  return (
    record(value) &&
    id(value.endpointId) &&
    key(value.token) &&
    (exact(value, ['endpointId', 'token']) ||
      (exact(value, ['endpointId', 'token', 'transport', 'directory']) &&
        value.transport === 'posix' &&
        typeof value.directory === 'string' &&
        posix.isAbsolute(value.directory) &&
        posix.normalize(value.directory) === value.directory &&
        Array.from(value.directory).every((character) => {
          const code = character.charCodeAt(0);
          return code >= 32 && code !== 127;
        }) &&
        Buffer.byteLength(value.directory) + 39 < 104))
  );
}

function payloadFields(data: Metadata): readonly unknown[] {
  switch (data.kind) {
    case 'acquire':
      return [data.deadline];
    case 'cancel':
      return [];
    case 'ready':
      return data.connection.transport === 'posix'
        ? [data.connection.endpointId, data.connection.token, 'posix', data.connection.directory]
        : [data.connection.endpointId, data.connection.token];
    case 'refused':
      return [data.reason];
  }
}

function proof(run: RunDescriptor, data: Metadata) {
  return createHmac('sha256', Buffer.from(run.capability, 'hex'))
    .update(
      JSON.stringify([
        run.version,
        run.runId,
        run.generation,
        data.kind,
        data.requestId,
        data.scopeId,
        ...payloadFields(data),
      ])
    )
    .digest('hex');
}

/** Encode only allowlisted fields, even if a caller passes an object with extra data. */
export function encodeMetadata(run: RunDescriptor, data: Metadata): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      version: VERSION,
      runId: run.runId,
      generation: run.generation,
      requestId: data.requestId,
      scopeId: data.scopeId,
      kind: data.kind,
      fields: payloadFields(data),
      mac: proof(run, data),
    })
  );
}

function parseData(value: Record<string, unknown>): Metadata | undefined {
  if (!id(value.requestId) || !id(value.scopeId) || !Array.isArray(value.fields)) return;
  const coordinates = { requestId: value.requestId, scopeId: value.scopeId };
  const [first, second] = value.fields as readonly unknown[];
  switch (value.kind) {
    case 'acquire':
      if (
        value.fields.length === 1 &&
        (first === null || (typeof first === 'number' && Number.isSafeInteger(first) && first > 0))
      )
        return { ...coordinates, kind: 'acquire', deadline: first };
      break;
    case 'cancel':
      if (value.fields.length === 0) return { ...coordinates, kind: 'cancel' };
      break;
    case 'ready':
      if (value.fields.length === 2 && id(first) && key(second))
        return { ...coordinates, kind: 'ready', connection: { endpointId: first, token: second } };
      if (value.fields.length === 4) {
        const connection = {
          endpointId: first,
          token: second,
          transport: value.fields[2],
          directory: value.fields[3],
        };
        if (validConnection(connection)) return { ...coordinates, kind: 'ready', connection };
      }
      break;
    case 'refused':
      if (
        value.fields.length === 1 &&
        (first === 'expired' || first === 'busy' || first === 'unavailable')
      )
        return { ...coordinates, kind: 'refused', reason: first };
      break;
  }
}

function decode(run: RunDescriptor, bytes: Uint8Array): Metadata | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_METADATA_BYTES) return;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return;
  }
  if (
    !record(value) ||
    !exact(value, [
      'version',
      'runId',
      'generation',
      'requestId',
      'scopeId',
      'kind',
      'fields',
      'mac',
    ]) ||
    value.version !== run.version ||
    value.runId !== run.runId ||
    value.generation !== run.generation ||
    !key(value.mac)
  )
    return;
  const data = parseData(value);
  if (data && timingSafeEqual(Buffer.from(value.mac, 'hex'), Buffer.from(proof(run, data), 'hex')))
    return data;
}

/** Authenticate the worker record and accept only acquisition and cancellation directions. */
export function decodeWorker(run: RunDescriptor, bytes: Uint8Array): WorkerMetadata | undefined {
  const data = decode(run, bytes);
  return data?.kind === 'acquire' || data?.kind === 'cancel' ? data : undefined;
}

/** Authenticate a reply and correlate it with the exact pending worker request. */
export function decodeReply(
  run: RunDescriptor,
  expected: Coordinates,
  bytes: Uint8Array
): BrokerMetadata | undefined {
  const data = decode(run, bytes);
  if (
    data?.requestId === expected.requestId &&
    data.scopeId === expected.scopeId &&
    (data.kind === 'ready' || data.kind === 'refused')
  )
    return data;
}
