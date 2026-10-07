/** Closed persisted source DATA grammar. Parsing never creates token authority or an actor. */
import { createHash } from 'node:crypto';
import type { OriginalNativeDocTokenHeader } from './token-store.js';
import type { ConnectorOwnerAuthority } from '../../../connectors/principal/server-principal.js';
const parseJson = JSON.parse;
const define = Object.defineProperty;
const isArray = Array.isArray;
const freeze = Object.freeze;
const ownKeys = Object.keys;
const ownSlot = Object.getOwnPropertyDescriptor;
const scalarJson = JSON.stringify;
const parseTime = Date.parse;

import type {
  OriginalDocTokenNativeFacts,
  OriginalDocTokenNativeRow,
} from './token-native-facts.js';
export interface OriginalDocTokenCapsuleData {
  readonly allowedTypes: readonly string[];
  readonly directions: readonly ('upstream' | 'downstream' | 'system')[];
  readonly permissions: readonly ('ingest' | 'replay' | 'stream')[];
  readonly fileSource: import('./token-native-file-source.js').OriginalDocTokenFileSource;
  readonly owner: ConnectorOwnerAuthority;
  readonly grantIds: readonly string[];
  readonly facts: OriginalDocTokenNativeFacts;
  readonly birth: Readonly<{
    physicalId: string;
    openedAt: string;
    documentId: string;
    createdAt: string;
  }>;
  readonly incarnation: unknown;
  readonly approvedGrants: unknown;
}
function fail(): never {
  throw new Error('Original document token source invalid');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isArray(value)) fail();
  return value as Record<string, unknown>;
}
function field(value: Record<string, unknown>, key: string): unknown {
  const slot = ownSlot(value, key);
  if (!slot || !('value' in slot)) fail();
  return slot.value;
}
function exact(value: Record<string, unknown>, names: readonly string[]) {
  const keys = ownKeys(value);
  if (keys.length !== names.length) fail();
  for (let index = 0; index < names.length; index++) field(value, names[index]!);
}
function row(value: unknown): OriginalDocTokenNativeRow {
  const input = object(value),
    keys = ownKeys(input);
  if (keys.length > 128) fail();
  const out: Record<string, string | number | null> = Object.create(null);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!,
      item = field(input, key);
    if (
      item !== null &&
      typeof item !== 'string' &&
      !(typeof item === 'number' && Number.isFinite(item))
    )
      fail();
    define(out, key, { value: item, enumerable: true });
  }
  return freeze(out);
}
function rows(value: unknown): readonly OriginalDocTokenNativeRow[] {
  if (!isArray(value) || value.length > 1024) fail();
  const out: OriginalDocTokenNativeRow[] = [];
  for (let index = 0; index < value.length; index++)
    define(out, String(index), {
      value: row(value[index]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return freeze(out);
}
function json(value: string, cap: number): unknown {
  if (Buffer.byteLength(value) > cap) fail();
  return Reflect.apply(parseJson, JSON, [value]);
}

function has(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index++) if (values[index] === value) return true;
  return false;
}
function scalarList(text: string, limit: number): string[] {
  const input = json(text, 32768);
  if (!isArray(input)) fail();
  const length = ownSlot(input, 'length')?.value;
  if (!Number.isInteger(length) || length < 1 || length > limit) fail();
  const output: string[] = [];
  for (let index = 0; index < length; index++) {
    const slot = ownSlot(input, String(index));
    const item = slot && ownSlot(slot, 'value');
    if (!item || typeof item.value !== 'string' || !item.value || has(output, item.value)) fail();
    define(output, String(index), {
      value: item.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}
function eventType(value: string): boolean {
  if (!value || value.length > 128) return false;
  let segment = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 46) {
      if (!segment) return false;
      segment = false;
    } else if (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 95 ||
      code === 45
    )
      segment = true;
    else return false;
  }
  return segment;
}
function reservedDirection(type: string): 'upstream' | 'downstream' | 'system' | undefined {
  if (type === 'md.task.toggled') return 'upstream';
  if (type === 'app.ack') return 'downstream';
  if (
    type === 'state.changed' ||
    type === 'event.status' ||
    type === 'doc.opened' ||
    type === 'doc.closed' ||
    type === 'doc.focused' ||
    type === 'doc.blurred' ||
    type === 'doc.viewers'
  )
    return 'system';
  return undefined;
}

/** Consume only DATA from the original fixed native row reader. Engine must independently
 * recognize its own store/hash/current native owner/source/grants before minting scope.
 */
export function parseOriginalDocTokenCapsuleData(
  header: OriginalNativeDocTokenHeader,
  authenticatedIssuerPayload: string
): OriginalDocTokenCapsuleData {
  if (header.bindingVersion !== 1 || header.revokedAt !== null || !header.nativeExpiryCurrent)
    fail();
  const data = {
    record: { documentId: header.documentId },
    binding: {
      birthJson: header.birthJson,
      generation: header.generation,
      scope: header.scope,
      declarationHash: header.declarationHash,
      manifestHash: header.manifestHash,
      incarnationJson: header.incarnationJson,
      approvedGrantsJson: header.approvedGrantsJson,
      issuerJson: authenticatedIssuerPayload,
    },
  };
  const allowedTypes = scalarList(header.allowedTypesJson, 128);
  const directions = scalarList(header.directionsJson, 3);
  const permissions = scalarList(header.permissionsJson, 3);
  for (let index = 0; index < directions.length; index++)
    if (
      directions[index] !== 'upstream' &&
      directions[index] !== 'downstream' &&
      directions[index] !== 'system'
    )
      fail();
  for (let index = 0; index < permissions.length; index++)
    if (
      permissions[index] !== 'ingest' &&
      permissions[index] !== 'replay' &&
      permissions[index] !== 'stream'
    )
      fail();
  if (has(permissions, 'ingest') && !has(directions, 'upstream')) fail();
  const read = has(permissions, 'replay') || has(permissions, 'stream');
  for (let index = 0; index < allowedTypes.length; index++) {
    const type = allowedTypes[index]!;
    if (!eventType(type)) fail();
    const reserved = reservedDirection(type);
    if (reserved) {
      if (!read || !has(directions, reserved)) fail();
    } else if (
      type.slice(0, 4) === 'doc.' ||
      type.slice(0, 6) === 'state.' ||
      type === 'selection.ask'
    )
      fail();
  }
  const birth = object(json(data.binding.birthJson, 4096));
  exact(birth, ['physicalId', 'openedAt', 'documentId', 'createdAt']);
  for (const key of ['physicalId', 'openedAt', 'documentId', 'createdAt'])
    if (typeof field(birth, key) !== 'string') fail();
  if (
    birth.physicalId !== data.record.documentId ||
    birth.documentId !== data.record.documentId ||
    !Number.isFinite(Reflect.apply(parseTime, Date, [birth.openedAt])) ||
    !Number.isFinite(Reflect.apply(parseTime, Date, [birth.createdAt]))
  )
    fail();
  const parts = [
    'doc-checkbox-incarnation-v1',
    birth.physicalId,
    birth.openedAt,
    birth.documentId,
    birth.createdAt,
  ];
  let encoded = '[';
  for (let index = 0; index < parts.length; index++)
    encoded += (index ? ',' : '') + Reflect.apply(scalarJson, JSON, [parts[index]]);
  const generation = createHash('sha256')
    .update(encoded + ']')
    .digest('hex');
  if (generation !== data.binding.generation) fail();
  const issuer = object(json(data.binding.issuerJson, 262144));
  exact(issuer, ['kind', 'owner', 'grantIds', 'nativeFacts', 'fileSource']);
  if (field(issuer, 'kind') !== 'original-native-doc-token-issuer-v1') fail();
  const owner = object(field(issuer, 'owner'));
  const ownerKind = field(owner, 'kind');
  if (ownerKind === 'user') {
    exact(owner, ['kind', 'userId']);
    if (typeof owner.userId !== 'string' || !owner.userId) fail();
  } else if (ownerKind === 'local_install') {
    exact(owner, ['kind', 'installationId']);
    if (typeof owner.installationId !== 'string' || !owner.installationId) fail();
  } else fail();
  const ids = field(issuer, 'grantIds');
  if (!isArray(ids) || ids.length > 1024) fail();
  const grantIds: string[] = [];
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    if (typeof id !== 'string' || !id) fail();
    for (let prior = 0; prior < index; prior++) if (grantIds[prior] === id) fail();
    define(grantIds, String(index), {
      value: id,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const source = object(field(issuer, 'nativeFacts'));
  exact(source, ['physical', 'channel', 'grants', 'approvals', 'owner']);
  const rawOwner = field(source, 'owner');
  let nativeOwner: Readonly<{ id: string }> | null = null;
  if (rawOwner !== null) {
    const input = object(rawOwner);
    exact(input, ['id']);
    if (typeof input.id !== 'string' || !input.id) fail();
    nativeOwner = freeze({ id: input.id });
  }
  const facts: OriginalDocTokenNativeFacts = freeze({
    physical: row(source.physical),
    channel: row(source.channel),
    grants: rows(source.grants),
    approvals: rows(source.approvals),
    owner: nativeOwner,
  });
  if (
    facts.physical.id !== birth.physicalId ||
    facts.physical.opened_at !== birth.openedAt ||
    facts.channel.document_id !== birth.documentId ||
    facts.channel.created_at !== birth.createdAt ||
    facts.physical.scope !== data.binding.scope ||
    facts.channel.scope !== data.binding.scope ||
    facts.channel.declaration_hash !== data.binding.declarationHash ||
    facts.channel.manifest_hash !== data.binding.manifestHash ||
    facts.channel.closed_at !== null
  )
    fail();
  if (ownerKind === 'user' ? nativeOwner?.id !== owner.userId : nativeOwner !== null) fail();
  if (header.creatorId !== (ownerKind === 'user' ? owner.userId : owner.installationId)) fail();
  const fileSource = object(field(issuer, 'fileSource'));
  exact(fileSource, ['policies', 'canonicalRoot', 'canonicalFile']);
  const root = field(fileSource, 'canonicalRoot'),
    file = field(fileSource, 'canonicalFile');
  if (
    (root !== null && typeof root !== 'string') ||
    (file !== null && typeof file !== 'string') ||
    (root === null) !== (file === null)
  )
    fail();
  const policy = object(field(fileSource, 'policies'));
  exact(policy, ['physical', 'session', 'repo', 'author', 'agent']);
  const optional = (name: string) =>
    field(policy, name) === null ? null : row(field(policy, name));
  const fileBinding = freeze({
    canonicalRoot: root as string | null,
    canonicalFile: file as string | null,
    policies: freeze({
      physical: row(field(policy, 'physical')),
      session: optional('session'),
      repo: optional('repo'),
      author: optional('author'),
      agent: optional('agent'),
    }),
  });
  return freeze({
    fileSource: fileBinding,
    allowedTypes: freeze(allowedTypes),
    directions: freeze(directions) as OriginalDocTokenCapsuleData['directions'],
    permissions: freeze(permissions) as OriginalDocTokenCapsuleData['permissions'],
    owner: freeze(owner) as unknown as ConnectorOwnerAuthority,
    grantIds: freeze(grantIds),
    facts,
    birth: freeze(birth) as unknown as OriginalDocTokenCapsuleData['birth'],
    incarnation: json(data.binding.incarnationJson, 262144),
    approvedGrants: json(data.binding.approvedGrantsJson, 262144),
  });
}
