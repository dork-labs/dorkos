/** Fixed native token evidence reads. Possession/header/binding data here never mint authority. */
import type { Db, DbTransaction } from '@dorkos/db';
import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import type { OriginalDocTokenIssuanceStage } from '../current/current-operation-types.js';
import {
  consumeOriginalDocTokenRevocationInsideCurrent,
  consumeOriginalDocTokenIssuanceInsideCurrent,
} from '../current/current-operation-engine.js';
import {
  CanvasChannelTokenRecordSchema,
  type CanvasChannelTokenRecord,
} from '@dorkos/shared/canvas-channel-schemas';
import { z } from 'zod';
import { types } from 'node:util';

const originalApply = Reflect.apply;
const scalarJson = JSON.stringify;
const utf8Bytes = Buffer.byteLength;
const readDescriptor = Object.getOwnPropertyDescriptor;
const readPrototype = Object.getPrototypeOf;
const isProxy = types.isProxy;

const directionsSchema = z
  .array(z.enum(['upstream', 'downstream', 'system']))
  .min(1)
  .max(3)
  .refine((values) => new Set(values).size === values.length);
/** Immutable retained token evidence; neither the header nor its binding grants authority. */
export interface OriginalStoredDocTokenData {
  readonly record: Readonly<
    Omit<CanvasChannelTokenRecord, 'allowedTypes' | 'directions' | 'permissions'>
  > & {
    readonly allowedTypes: readonly string[];
    readonly directions: readonly ('upstream' | 'downstream' | 'system')[];
    readonly permissions: readonly ('ingest' | 'replay' | 'stream')[];
  };
  /** Exact retained bounded bytes. Only the original native document engine may consume them. */
  readonly binding: Readonly<{
    version: number;
    scope: string;
    generation: string;
    birthJson: string;
    incarnationJson: string;
    declarationHash: string;
    manifestHash: string | null;
    approvedGrantsJson: string;
    issuerJson: string;
  }>;
}
interface TokenStoreOwner {
  db: Db;
  native: Db['$client'];
  byId: (id: string) => unknown;
  byHash: (hash: string) => unknown;
  nativeHeaderByHash: (hash: string) => unknown;
  revocationById: (id: string) => unknown;
  revoke: (values: readonly string[]) => number;
  methodsCurrent: () => boolean;
  insert: (values: readonly (string | number | null)[]) => void;
}
const stores = new WeakMap<DocChannelTokenStore, TokenStoreOwner>();
/** Same physical native connection only; this recognizes stored evidence, never authorization. */
export function requireDocChannelTokenStoreDatabase(
  store: DocChannelTokenStore,
  db: Db
): undefined {
  const own = stores.get(store);
  if (!own || own.db !== db) throw new Error('Document token store unavailable.');
  requireServerNativeDatabaseQueryCustody(db);
  if (own.native !== db.$client || !own.methodsCurrent() || !own.native.open)
    throw new Error('Document token store unavailable.');
  return undefined;
}

// Compare descriptor custody before dispatching any native accessor; no reflected method getter runs.
function captureOriginalTokenMethodGraph(target: object, names: readonly string[]): () => boolean {
  const rows: {
    object: object;
    parent: object | null;
    descriptors: (PropertyDescriptor | undefined)[];
  }[] = [];
  let at: object | null = target;
  while (at !== null) {
    // Only this constructor's exact recognized native client/original prepare result may be a root proxy.
    // Native custody is checked before these private captures; proxy ancestors remain refused.
    if ((at !== target && isProxy(at)) || rows.length >= 16)
      throw new Error('Document token store unavailable.');
    const descriptors: (PropertyDescriptor | undefined)[] = [];
    for (let index = 0; index < names.length; index++)
      descriptors[index] = readDescriptor(at, names[index]!);
    const parent = readPrototype(at);
    rows[rows.length] = { object: at, parent, descriptors };
    at = parent;
  }
  return () => {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (readPrototype(row.object) !== row.parent) return false;
      for (let field = 0; field < names.length; field++) {
        const before = row.descriptors[field],
          now = readDescriptor(row.object, names[field]!);
        if (!before !== !now) return false;
        if (before && now) {
          // Missing descriptor slots must not dispatch inherited Object.prototype getters.
          const fields = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];
          for (let slot = 0; slot < fields.length; slot++)
            if (
              readDescriptor(before, fields[slot]!)?.value !==
              readDescriptor(now, fields[slot]!)?.value
            )
              return false;
        }
      }
    }
    return true;
  };
}

// Native CASE prevents oversized historical/corrupt column values crossing into JS.
// Refuse the whole record; NULL from a refused required column is never a truncated value.
const bounded = (column: string, bytes: number) =>
  `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=${bytes} THEN ${column} ELSE NULL END`;
const columns = [
  ['token_id', 'tokenId', 800],
  ['token_hash', 'tokenHash', 64],
  ['document_id', 'documentId', 800],
  ['allowed_types', 'allowedTypesJson', 32768],
  ['directions', 'directionsJson', 128],
  ['permissions', 'permissionsJson', 128],
  ['creator_id', 'creatorId', 800],
  ['created_at', 'createdAt', 64],
  ['expires_at', 'expiresAt', 64],
  ['document_scope', 'scope', 4096],
  ['document_generation', 'generation', 4096],
  ['document_birth', 'birthJson', 4096],
  ['document_incarnation', 'incarnationJson', 262144],
  ['declaration_hash', 'declarationHash', 64],
  ['approved_grant_bindings', 'approvedGrantsJson', 262144],
  ['issuer_binding', 'issuerJson', 262144],
] as const;
const projection =
  columns.map(([column, alias, cap]) => `${bounded(column, cap)} AS ${alias}`).join(', ') +
  `, ${bounded('manifest_hash', 64)} AS manifestHash, ${bounded('revoked_at', 64)} AS revokedAt,
    manifest_hash IS NULL AS manifestAbsent, revoked_at IS NULL AS revocationAbsent, binding_version AS bindingVersion`;

function captureStoredTokenData(raw: unknown): OriginalStoredDocTokenData | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') throw new Error('Document token evidence invalid.');
  const row = raw as Record<string, unknown>;
  for (const [, alias] of columns)
    if (typeof row[alias] !== 'string') throw new Error('Document token evidence invalid.');
  if (
    (!row.manifestAbsent && typeof row.manifestHash !== 'string') ||
    (!row.revocationAbsent && typeof row.revokedAt !== 'string') ||
    row.bindingVersion !== 1
  )
    throw new Error('Document token evidence invalid.');
  let record: CanvasChannelTokenRecord, directions: z.infer<typeof directionsSchema>;
  try {
    directions = directionsSchema.parse(JSON.parse(row.directionsJson as string));
    // Requires the amended strict shared record schema: directions are mandatory, no fallback/backfill.
    record = CanvasChannelTokenRecordSchema.parse({
      tokenId: row.tokenId,
      tokenHash: row.tokenHash,
      documentId: row.documentId,
      allowedTypes: JSON.parse(row.allowedTypesJson as string),
      directions,
      permissions: JSON.parse(row.permissionsJson as string),
      creatorId: row.creatorId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revocationAbsent ? null : row.revokedAt,
    });
    if (
      new Set(record.allowedTypes).size !== record.allowedTypes.length ||
      new Set(record.permissions).size !== record.permissions.length ||
      (record.permissions.includes('ingest') && !directions.includes('upstream'))
    )
      throw new Error('Invalid token constraints.');
  } catch (cause) {
    throw new Error('Document token evidence invalid.', { cause });
  }
  const publicRecord = Object.freeze({
    ...record,
    allowedTypes: Object.freeze([...record.allowedTypes]),
    directions: Object.freeze([...directions]),
    permissions: Object.freeze([...record.permissions]),
  });
  // Do not JSON.parse/certify an issuer/origin capsule in this DATA-only reader.
  return Object.freeze({
    record: publicRecord,
    binding: Object.freeze({
      version: 1,
      scope: row.scope as string,
      generation: row.generation as string,
      birthJson: row.birthJson as string,
      incarnationJson: row.incarnationJson as string,
      declarationHash: row.declarationHash as string,
      manifestHash: row.manifestAbsent ? null : (row.manifestHash as string),
      approvedGrantsJson: row.approvedGrantsJson as string,
      issuerJson: row.issuerJson as string,
    }),
  });
}
/** Read bounded evidence by public token identifier from the constructor's original native database. */
export function readOriginalStoredDocTokenById(
  store: DocChannelTokenStore,
  db: Db,
  id: string
): OriginalStoredDocTokenData | undefined {
  requireDocChannelTokenStoreDatabase(store, db);
  if (typeof id !== 'string' || !id || id.length > 200)
    throw new Error('Document token evidence invalid.');
  const own = stores.get(store)!;
  const result = captureStoredTokenData(own.byId(id));
  requireDocChannelTokenStoreDatabase(store, db);
  return result;
}
/** Read bounded evidence by SHA-256 digest without interpreting its retained issuer binding. */
export function readOriginalStoredDocTokenByHash(
  store: DocChannelTokenStore,
  db: Db,
  hash: string
): OriginalStoredDocTokenData | undefined {
  requireDocChannelTokenStoreDatabase(store, db);
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash))
    throw new Error('Document token evidence invalid.');
  const own = stores.get(store)!;
  const result = captureStoredTokenData(own.byHash(hash));
  requireDocChannelTokenStoreDatabase(store, db);
  return result;
}
/** Bounded raw original SQLite header DATA; no schema parser or actor restoration. */
export interface OriginalNativeDocTokenHeader {
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly documentId: string;
  readonly allowedTypesJson: string;
  readonly directionsJson: string;
  readonly permissionsJson: string;
  readonly creatorId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly scope: string;
  readonly generation: string;
  readonly birthJson: string;
  readonly incarnationJson: string;
  readonly declarationHash: string;
  readonly approvedGrantsJson: string;
  readonly issuerJson: string;
  readonly manifestHash: string | null;
  readonly revokedAt: string | null;
  readonly bindingVersion: number;
  readonly nativeExpiryCurrent: boolean;
}
const originalNativeTokenHeaders = new WeakMap<
  OriginalNativeDocTokenHeader,
  { db: Db; store: DocChannelTokenStore; hash: string }
>();
/** Native header provenance only; freshness/current authorization still requires final reread. */
export function requireOriginalNativeDocTokenHeaderOrigin(
  header: OriginalNativeDocTokenHeader,
  db: Db
): void {
  const own = originalNativeTokenHeaders.get(header);
  if (!own || own.db !== db) throw new Error('Original native token header unavailable.');
  requireDocChannelTokenStoreDatabase(own.store, db);
}
/** Fresh same-store native reread, never a caller hash/DTO used as proof. */
export function readFreshOriginalNativeDocTokenHeaderFromOrigin(
  header: OriginalNativeDocTokenHeader,
  db: Db
): OriginalNativeDocTokenHeader | undefined {
  requireOriginalNativeDocTokenHeaderOrigin(header, db);
  const own = originalNativeTokenHeaders.get(header)!;
  return readOriginalNativeDocTokenHeaderByHash(own.store, db, own.hash);
}
function nativeHeaderField(row: object, key: string): unknown {
  const descriptor = readDescriptor(row, key);
  const value = descriptor && readDescriptor(descriptor, 'value');
  if (!value) throw new Error('Document token native header invalid.');
  return value.value;
}
/** The owning engine must repeat this original read at its final native disclosure/write gate. */
export function readOriginalNativeDocTokenHeaderByHash(
  store: DocChannelTokenStore,
  db: Db,
  hash: string
): OriginalNativeDocTokenHeader | undefined {
  requireDocChannelTokenStoreDatabase(store, db);
  if (typeof hash !== 'string' || hash.length !== 64)
    throw new Error('Document token native header invalid.');
  for (let index = 0; index < hash.length; index++) {
    const character = hash[index]!;
    if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
      throw new Error('Document token native header invalid.');
  }
  const raw = stores.get(store)!.nativeHeaderByHash(hash);
  requireDocChannelTokenStoreDatabase(store, db);
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') throw new Error('Document token native header invalid.');
  const data: Record<string, unknown> = Object.create(null);
  for (let index = 0; index < columns.length; index++) {
    const key = columns[index]![1];
    const value = nativeHeaderField(raw, key);
    if (typeof value !== 'string') throw new Error('Document token native header invalid.');
    Object.defineProperty(data, key, { value, enumerable: true });
  }
  const manifestAbsent = nativeHeaderField(raw, 'manifestAbsent');
  const revocationAbsent = nativeHeaderField(raw, 'revocationAbsent');
  const expiryCurrent = nativeHeaderField(raw, 'nativeExpiryCurrent');
  if (
    (manifestAbsent !== 0 && manifestAbsent !== 1) ||
    (revocationAbsent !== 0 && revocationAbsent !== 1) ||
    (expiryCurrent !== 0 && expiryCurrent !== 1) ||
    nativeHeaderField(raw, 'bindingVersion') !== 1 ||
    data.tokenHash !== hash
  )
    throw new Error('Document token native header invalid.');
  const manifest = nativeHeaderField(raw, 'manifestHash');
  const revoked = nativeHeaderField(raw, 'revokedAt');
  if (
    (manifestAbsent === 1 ? manifest !== null : typeof manifest !== 'string') ||
    (revocationAbsent === 1 ? revoked !== null : typeof revoked !== 'string')
  )
    throw new Error('Document token native header invalid.');
  Object.defineProperties(data, {
    manifestHash: { value: manifest, enumerable: true },
    revokedAt: { value: revoked, enumerable: true },
    bindingVersion: { value: 1, enumerable: true },
    nativeExpiryCurrent: { value: expiryCurrent === 1, enumerable: true },
  });
  const header = Object.freeze(data) as unknown as OriginalNativeDocTokenHeader;
  originalNativeTokenHeaders.set(header, { db, store, hash });
  return header;
}

function encodeOriginalScalarArray(values: readonly string[], cap: number): string {
  let text = '[';
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (typeof value !== 'string') throw new Error('Document token evidence invalid.');
    // Original engine arrays have frozen own scalar entries; never dispatch array toJSON/iterator/join.
    text += (index === 0 ? '' : ',') + originalApply(scalarJson, JSON, [value]);
    if (originalApply(utf8Bytes, Buffer, [text, 'utf8']) > cap)
      throw new Error('Document token evidence invalid.');
  }
  text += ']';
  if (originalApply(utf8Bytes, Buffer, [text, 'utf8']) > cap)
    throw new Error('Document token evidence invalid.');
  return text;
}
/** Consume one genuine active native issuance stage into its owning store and SQL transaction. */
export function writeOriginalDocTokenIssuanceInsideCurrent(
  stage: OriginalDocTokenIssuanceStage,
  store: DocChannelTokenStore,
  db: Db,
  tx: DbTransaction
): void {
  requireDocChannelTokenStoreDatabase(store, db);
  const own = stores.get(store)!;
  if (!own.native.inTransaction) throw new Error('Document token store unavailable.');
  // Engine recognizer repeats original source/owner/grant/expiry tail and consumes before any write.
  const data = consumeOriginalDocTokenIssuanceInsideCurrent(stage, store, db, tx);
  const record = data.record,
    binding = data.binding;
  const values = [
    record.tokenId,
    record.tokenHash,
    record.documentId,
    encodeOriginalScalarArray(record.allowedTypes, 32768),
    encodeOriginalScalarArray(record.directions, 128),
    encodeOriginalScalarArray(record.permissions, 128),
    record.creatorId,
    record.createdAt,
    record.expiresAt,
    binding.scope,
    binding.generation,
    binding.birthJson,
    binding.incarnationJson,
    binding.declarationHash,
    binding.approvedGrantsJson,
    binding.issuerJson,
    binding.manifestHash,
    record.revokedAt,
    binding.version,
  ] as const;
  requireDocChannelTokenStoreDatabase(store, db);
  if (!own.native.inTransaction || binding.version !== 1 || record.revokedAt !== null)
    throw new Error('Document token evidence invalid.');
  // Fixed captured native statement; no caller row, transaction callback or reflected Drizzle builder.
  own.insert(values);
  requireDocChannelTokenStoreDatabase(store, db);
}
/** Raw native revocation selectors are DATA; operator/source authority is separate. */
export function readOriginalDocTokenRevocationData(
  store: DocChannelTokenStore,
  db: Db,
  id: string
) {
  requireDocChannelTokenStoreDatabase(store, db);
  if (typeof id !== 'string' || !id || id.length > 200)
    throw new Error('Invalid token identifier.');
  const raw = stores.get(store)!.revocationById(id);
  requireDocChannelTokenStoreDatabase(store, db);
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') throw new Error('Invalid native token DATA.');
  const fields = ['tokenId', 'tokenHash', 'documentId', 'createdAt', 'expiresAt'] as const;
  const result: Record<string, string | null> = {};
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!,
      value = nativeHeaderField(raw, field);
    if (typeof value !== 'string' || !value || value.length > 200)
      throw new Error('Invalid native token DATA.');
    Object.defineProperty(result, field, { value, enumerable: true });
  }
  const revokedAt = nativeHeaderField(raw, 'revokedAt');
  if (revokedAt !== null && (typeof revokedAt !== 'string' || revokedAt.length > 64))
    throw new Error('Invalid native token DATA.');
  Object.defineProperty(result, 'revokedAt', { value: revokedAt, enumerable: true });
  return Object.freeze(result) as Readonly<{
    tokenId: string;
    tokenHash: string;
    documentId: string;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
  }>;
}
/** Only the genuine original operator engine can consume the one-use active revocation stage. */
export function writeOriginalDocTokenRevocationInsideCurrent(
  stage: import('../current/current-operation-types.js').OriginalDocTokenRevocationStage,
  store: DocChannelTokenStore,
  db: Db,
  tx: DbTransaction
): void {
  requireDocChannelTokenStoreDatabase(store, db);
  const data = consumeOriginalDocTokenRevocationInsideCurrent(stage, store, db, tx);
  const own = stores.get(store)!;
  if (!own.native.inTransaction) throw new Error('Invalid revocation transaction.');
  if (
    own.revoke([
      data.revokedAt,
      data.tokenId,
      data.tokenHash,
      data.documentId,
      data.createdAt,
      data.expiresAt,
    ]) !== 1
  )
    throw new Error('Original token revocation changed.');
  requireDocChannelTokenStoreDatabase(store, db);
}
/** Capture fixed evidence queries on one native connection; public replacements cannot mint authority. */
export class DocChannelTokenStore {
  constructor(db: Db) {
    requireServerNativeDatabaseQueryCustody(db);
    const native = db.$client;
    const nativeGraph = captureOriginalTokenMethodGraph(native, [
      'prepare',
      'open',
      'inTransaction',
    ]);
    if (!native.open || native.inTransaction) throw new Error('Document token store unavailable.');
    const prepare = native.prepare;
    const id = originalApply(prepare, native, [
      `SELECT ${projection} FROM canvas_doc_channel_tokens WHERE token_id=?`,
    ]);
    const hash = originalApply(prepare, native, [
      `SELECT ${projection} FROM canvas_doc_channel_tokens WHERE token_hash=?`,
    ]);
    const nativeHeader = originalApply(prepare, native, [
      `SELECT ${projection},
      CASE WHEN julianday(expires_at) IS NOT NULL AND julianday(expires_at)>julianday('now')
        THEN 1 ELSE 0 END AS nativeExpiryCurrent
      FROM canvas_doc_channel_tokens WHERE token_hash=? LIMIT 1`,
    ]);
    const insert = originalApply(prepare, native, [
      `INSERT INTO canvas_doc_channel_tokens
      (token_id, token_hash, document_id, allowed_types, directions, permissions, creator_id, created_at, expires_at,
       document_scope, document_generation, document_birth, document_incarnation, declaration_hash,
       approved_grant_bindings, issuer_binding, manifest_hash, revoked_at, binding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ]);
    const revocation = originalApply(prepare, native, [
      `SELECT token_id AS tokenId,token_hash AS tokenHash,
      document_id AS documentId,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt
      FROM canvas_doc_channel_tokens WHERE token_id=? LIMIT 1`,
    ]);
    const revoke = originalApply(prepare, native, [
      `UPDATE canvas_doc_channel_tokens SET revoked_at=?
      WHERE token_id=? AND token_hash=? AND document_id=? AND created_at=? AND expires_at=? AND revoked_at IS NULL`,
    ]);
    const revocationGraph = captureOriginalTokenMethodGraph(revocation, ['get']);
    const revokeGraph = captureOriginalTokenMethodGraph(revoke, ['run']);
    const revocationGet = revocation.get,
      revokeRun = revoke.run;
    const idGraph = captureOriginalTokenMethodGraph(id, ['get']);
    const hashGraph = captureOriginalTokenMethodGraph(hash, ['get']);
    const insertGraph = captureOriginalTokenMethodGraph(insert, ['run']);
    const nativeHeaderGraph = captureOriginalTokenMethodGraph(nativeHeader, ['get']);
    const idGet = id.get,
      hashGet = hash.get,
      insertRun = insert.run;
    const nativeHeaderGet = nativeHeader.get;
    stores.set(
      this,
      Object.freeze({
        db,
        native,
        methodsCurrent: () =>
          nativeGraph() &&
          idGraph() &&
          hashGraph() &&
          insertGraph() &&
          nativeHeaderGraph() &&
          revocationGraph() &&
          revokeGraph(),
        byId: (value: string) => originalApply(idGet, id, [value]),
        byHash: (value: string) => originalApply(hashGet, hash, [value]),
        nativeHeaderByHash: (value: string) =>
          originalApply(nativeHeaderGet, nativeHeader, [value]),
        revocationById: (value: string) => originalApply(revocationGet, revocation, [value]),
        revoke: (values: readonly string[]) => originalApply(revokeRun, revoke, values).changes,
        insert: (values: readonly (string | number | null)[]) => {
          originalApply(insertRun, insert, values);
        },
      })
    );
    requireDocChannelTokenStoreDatabase(this, db);
  }
}
