/** Ephemeral request-bound observations; neither a durable approval nor a scheduling proof. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { docDocumentGeneration, DocDocumentIncarnationError } from '../identity/incarnation.js';
import { types as utilTypes } from 'node:util';
import type { Db, DbTransaction } from '@dorkos/db';
import { documentTransaction, type SynchronousResult } from '../store-transaction.js';
import {
  CANVAS_APP_MANIFEST_BYTES,
  CanvasAppManifestError,
  canonicalCanvasAppJson,
  parseCanvasAppManifest,
} from '@dorkos/shared/canvas-app-manifest';
import type { ServerPrincipalProof } from '../../../connectors/principal/server-principal.js';
import { isContained } from '../../../../lib/boundary.js';
import type { DocSourceDescriptor } from '../http-composition.js';
import {
  requireDocChannelStoreDatabase,
  type DocChannelStore,
  type DocGrantRow,
  type DocChannelRow,
} from '../store.js';
import { declaredRoute, type DocGrantAuthority, type DocGrantTarget } from '../grant-policy.js';
import { freezeCheckboxData, type VerifiedCheckboxAuthority } from './checkbox-evidence.js';

/** A checked authority reduction; native/causeful IO errors retain their original uncertainty. */
export class CheckboxAuthorityRefusal extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = 'CheckboxAuthorityRefusal';
  }
}
/** Actual root/file/ancestor/manifest observation, never substituted for original sourceIdentity. */
export interface CheckboxSourceObservation {
  descriptor: DocSourceDescriptor;
  root: { canonicalPath: string; device: string; inode: string; ancestors: string[] };
  canonicalPath: string;
  fileIdentity: string;
  manifestHash: string | null;
}
const snapshotBrand: unique symbol = Symbol('checkbox-authority-snapshot');
/** Opaque once-consumed token bound to the requesting factory, request and original authority. */
export interface CheckboxAuthoritySnapshot {
  readonly [snapshotBrand]: true;
}
/** Internal immutable data behind one token; actor proof retains authentic object identity. */
export interface CheckboxSnapshotData {
  subject: string;
  approved: VerifiedCheckboxAuthority;
  actor?: ServerPrincipalProof;
  surface?: string;
  observation: CheckboxSourceObservation;
}
/** Each factory owns a private registry; there is no document-key cache or cross-factory token. */
export class CheckboxSnapshotRegistry {
  readonly #pending = new WeakMap<CheckboxAuthoritySnapshot, CheckboxSnapshotData>();
  issue(data: CheckboxSnapshotData): CheckboxAuthoritySnapshot {
    const token: CheckboxAuthoritySnapshot = Object.freeze({ [snapshotBrand]: true as const });
    this.#pending.set(token, freezeCheckboxData(data));
    return token;
  }
  consume(snapshot: CheckboxAuthoritySnapshot): CheckboxSnapshotData {
    const data = this.#pending.get(snapshot);
    this.#pending.delete(snapshot);
    if (!data)
      throw new Error('Checkbox authority snapshot is foreign, stale or already consumed.');
    return data;
  }
}
/** Reject/observe nominal synchronous port promises before SQL commit or direct field access. */
export function checkboxAuthoritySync<T>(value: T): T {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (
      !current.value ||
      (typeof current.value !== 'object' && typeof current.value !== 'function')
    )
      continue;
    if (utilTypes.isProxy(current.value))
      throw new Error('Checkbox authority ports require inspectable data.');
    if (seen.has(current.value)) continue;
    if (++visited > 10_000 || current.depth > 64)
      throw new Error('Checkbox authority port data exceeds bounds.');
    seen.add(current.value);
    const descriptors = Object.getOwnPropertyDescriptors(current.value);
    if (Object.values(descriptors).some((descriptor) => !('value' in descriptor)))
      throw new Error('Checkbox authority ports require own data, not accessors.');
    if (utilTypes.isPromise(current.value)) {
      void Promise.prototype.then.call(current.value, undefined, () => {});
      throw new Error('Checkbox authority ports must be synchronous.');
    }
    const prototype: unknown = Object.getPrototypeOf(current.value);
    if (
      prototype !== Object.prototype &&
      prototype !== null &&
      !(Array.isArray(current.value) && prototype === Array.prototype) &&
      !(utilTypes.isDate(current.value) && prototype === Date.prototype)
    )
      throw new Error('Checkbox authority ports require plain data.');
    if (descriptors.then) {
      void Promise.resolve(current.value).catch(() => {});
      throw new Error('Checkbox authority ports must be synchronous.');
    }
    for (const descriptor of Object.values(descriptors))
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    if (pending.length > 10_000) throw new Error('Checkbox authority port data exceeds bounds.');
  }
  return value;
}
/** Capture the configured clock before final rows; never invoke an overridden date method later. */
export function checkboxAuthorityClock(clock: () => Date): number {
  const value = Date.prototype.getTime.call(checkboxAuthoritySync(clock()));
  if (!Number.isFinite(value)) throw new Error('Checkbox authority requires a valid clock.');
  return value;
}
/** A same-connection callback write is uncertainty, not a manufactured authority reduction. */
export class CheckboxAuthorityCallbackError extends Error {
  readonly code = 'CHECKBOX_AUTHORITY_CALLBACK_WROTE_SQL';
  constructor(options?: ErrorOptions) {
    super('Checkbox authority callbacks must not write SQL.', options);
    this.name = 'CheckboxAuthorityCallbackError';
  }
}
/** Detect even rolled-back callback writes before returning authority from the proven own gate. */
export function withCheckboxReadOnlyGate<T>(db: Db, run: () => T): T {
  const stamp = () => {
    const row = db.$client.prepare('SELECT total_changes() AS changes').safeIntegers().get() as {
      changes: bigint;
    };
    if (typeof row.changes !== 'bigint')
      throw new Error('Checkbox authority SQL stamp is unavailable.');
    return row.changes;
  };
  const before = stamp();
  let result: { value: T } | { error: unknown };
  try {
    result = { value: checkboxAuthoritySync(run()) };
  } catch (error) {
    result = { error };
  }
  let after: bigint;
  try {
    after = stamp();
  } catch (error) {
    throw new AggregateError(
      'error' in result ? [result.error, error] : [error],
      'Checkbox authority SQL stamp is unavailable.',
      { cause: error }
    );
  }
  if (before !== after) {
    if ('error' in result && result.error instanceof CheckboxAuthorityCallbackError)
      throw result.error;
    throw new CheckboxAuthorityCallbackError(
      'error' in result ? { cause: result.error } : undefined
    );
  }
  if ('error' in result) throw result.error;
  return result.value;
}

async function rootIdentity(candidate: string) {
  const canonicalPath = await fs.realpath(candidate);
  const info = await fs.stat(canonicalPath, { bigint: true });
  if (!info.isDirectory()) throw new CheckboxAuthorityRefusal('SOURCE_ROOT_CHANGED');
  const ancestors: string[] = [];
  let parent = path.dirname(canonicalPath);
  while (parent !== canonicalPath) {
    const ancestor = await fs.stat(parent, { bigint: true });
    ancestors.push(`${parent}:${ancestor.dev}:${ancestor.ino}`);
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return { canonicalPath, device: `${info.dev}`, inode: `${info.ino}`, ancestors };
}
async function manifestHash(root: string): Promise<string | null> {
  const requested = path.join(root, '.dork', 'app.json');
  let canonical: string;
  try {
    canonical = await fs.realpath(requested);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
  if (!isContained(canonical, root)) throw new CheckboxAuthorityRefusal('MANIFEST_CHANGED');
  const file = await fs.open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.size > BigInt(CANVAS_APP_MANIFEST_BYTES))
      throw new CheckboxAuthorityRefusal('MANIFEST_INVALID');
    const buffer = Buffer.alloc(CANVAS_APP_MANIFEST_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > CANVAS_APP_MANIFEST_BYTES) throw new CheckboxAuthorityRefusal('MANIFEST_INVALID');
    const current = await fs.realpath(requested);
    const named = await fs.stat(current, { bigint: true });
    if (
      current !== canonical ||
      !isContained(current, root) ||
      named.dev !== info.dev ||
      named.ino !== info.ino
    )
      throw new CheckboxAuthorityRefusal('MANIFEST_CHANGED');
    try {
      const manifest = parseCanvasAppManifest(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)))
      );
      return createHash('sha256').update(canonicalCanvasAppJson(manifest)).digest('hex');
    } catch (cause) {
      if (
        cause instanceof CanvasAppManifestError ||
        cause instanceof SyntaxError ||
        cause instanceof TypeError
      )
        throw new CheckboxAuthorityRefusal('MANIFEST_INVALID', { cause });
      throw cause;
    }
  } finally {
    await file.close();
  }
}
/** Bracket awaited probes with current descriptor checks and independently repeated physical observations. */
export async function observeCheckboxSource(
  readCurrent: () => DocSourceDescriptor,
  assertOutside: () => undefined
): Promise<CheckboxSourceObservation> {
  checkboxAuthoritySync(assertOutside());
  const descriptor = checkboxAuthoritySync(readCurrent());
  if (
    !descriptor.sourcePath ||
    !descriptor.sourceIdentity ||
    !descriptor.rootCandidate ||
    !descriptor.treeKind
  )
    throw new CheckboxAuthorityRefusal('WRITE_SOURCE_UNAVAILABLE');
  const pass = async () => {
    checkboxAuthoritySync(assertOutside());
    const root = await rootIdentity(descriptor.rootCandidate!);
    if (descriptor.matchRoot && (await fs.realpath(descriptor.matchRoot)) !== root.canonicalPath)
      throw new CheckboxAuthorityRefusal('SOURCE_ROOT_CHANGED');
    if (
      descriptor.allowedRoot &&
      !isContained(root.canonicalPath, await fs.realpath(descriptor.allowedRoot))
    )
      throw new CheckboxAuthorityRefusal('SOURCE_ROOT_CHANGED');
    const canonicalPath = await fs.realpath(
      path.resolve(root.canonicalPath, descriptor.sourcePath!)
    );
    if (!isContained(canonicalPath, root.canonicalPath))
      throw new CheckboxAuthorityRefusal('SOURCE_PATH_CHANGED');
    const info = await fs.stat(canonicalPath, { bigint: true });
    if (!info.isFile()) throw new CheckboxAuthorityRefusal('WRITE_SOURCE_UNAVAILABLE');
    const hash = await manifestHash(root.canonicalPath);
    const tailRoot = await rootIdentity(descriptor.rootCandidate!);
    const tailPath = await fs.realpath(
      path.resolve(tailRoot.canonicalPath, descriptor.sourcePath!)
    );
    const tailFile = await fs.stat(tailPath, { bigint: true });
    const tailHash = await manifestHash(tailRoot.canonicalPath);
    if (
      hash !== tailHash ||
      JSON.stringify(root) !== JSON.stringify(tailRoot) ||
      canonicalPath !== tailPath ||
      info.dev !== tailFile.dev ||
      info.ino !== tailFile.ino
    )
      throw new CheckboxAuthorityRefusal('SOURCE_OBSERVATION_CHANGED');
    checkboxAuthoritySync(assertOutside());
    if (JSON.stringify(checkboxAuthoritySync(readCurrent())) !== JSON.stringify(descriptor))
      throw new CheckboxAuthorityRefusal('SOURCE_DESCRIPTOR_CHANGED');
    return {
      descriptor,
      root,
      canonicalPath,
      fileIdentity: `${info.dev}:${info.ino}`,
      manifestHash: hash,
    };
  };
  const first = await pass();
  const final = await pass();
  if (JSON.stringify(first) !== JSON.stringify(final))
    throw new CheckboxAuthorityRefusal('SOURCE_OBSERVATION_CHANGED');
  return freezeCheckboxData(final);
}

/** Exact instance-private provenance, minted only over the configured authoritative database. */
export class CheckboxAuthorityTransactions {
  readonly #active = new WeakSet<object>();
  readonly #checkedTimes = new WeakMap<object, string>();
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }
  /** Open a synchronous scoped caller handle; remove authority on every exit path. */
  run<T>(work: (tx: DbTransaction) => T & SynchronousResult<T>): T {
    if (this.#db.$client.inTransaction)
      throw new Error('Checkbox authority cannot nest its transaction boundary.');
    return documentTransaction<T>(this.#db, (tx) => {
      this.#active.add(tx);
      try {
        return work(tx);
      } finally {
        this.#checkedTimes.delete(tx);
        this.#active.delete(tx);
      }
    });
  }
  /** Keep the already-formatted checked clock inside this factory's active caller scope. */
  captureCheckedTime(tx: DbTransaction, time: string): void {
    this.require(tx);
    this.#checkedTimes.set(tx, time);
  }
  /** Consume the already-checked time without another observable clock callback. */
  takeCheckedTime(tx: DbTransaction): string {
    this.require(tx);
    const time = this.#checkedTimes.get(tx);
    this.#checkedTimes.delete(tx);
    if (time === undefined) throw new Error('Checkbox authority checked time is unavailable.');
    return time;
  }
  /** A simultaneous transaction elsewhere cannot lend this handle authority. */
  require(tx: DbTransaction): void {
    if (!this.#active.has(tx) || !this.#db.$client.inTransaction)
      throw new Error('Checkbox authority requires its exact active transaction boundary.');
  }
}

/** An awaited observation cannot silently adopt a replaced caller proof or surface. */
export function requireSameCheckboxActor(
  actual: { principal: ServerPrincipalProof; surface: string },
  bound: { principal: ServerPrincipalProof; surface: string }
): void {
  if (actual.principal !== bound.principal || actual.surface !== bound.surface)
    throw new CheckboxAuthorityRefusal('SNAPSHOT_SUBJECT_CHANGED');
}

/** Initially inactive, exact constructor-owned store/database provenance. */
export function requireCheckboxStoreDatabase(db: Db, store: DocChannelStore): void {
  if (db.$client.inTransaction)
    throw new Error('Checkbox authority construction requires an inactive database.');
  requireDocChannelStoreDatabase(store, db);
}

/** Compatibility authority refusal; the pure leaf owns the single birth hash formula. */
export function checkboxDocumentGeneration(
  physical: { id: string; openedAt: string },
  channel: { documentId: string; createdAt: string }
): string {
  try {
    return docDocumentGeneration(physical, channel);
  } catch (cause) {
    if (cause instanceof DocDocumentIncarnationError)
      throw new CheckboxAuthorityRefusal('DOCUMENT_INCARNATION_CHANGED');
    throw cause;
  }
}

/** Exact source binding from inspected own data; never a fallback to a different source. */
export function checkboxSourceBinding(
  source: DocSourceDescriptor,
  canonicalPath: string
): VerifiedCheckboxAuthority['binding'] {
  if (
    !source.sourceIdentity ||
    !source.resolvedCwd ||
    !['room-main', 'worktree', 'agent-cwd'].includes(source.treeKind ?? '')
  )
    throw new CheckboxAuthorityRefusal('WRITE_SOURCE_UNAVAILABLE');
  return {
    operation: 'checkbox-toggle',
    sourceIdentity: source.sourceIdentity,
    resolvedCwd: source.resolvedCwd,
    treeKind: source.treeKind as 'room-main' | 'worktree' | 'agent-cwd',
    canonicalPath,
  };
}

/** Run original-grant callback phases before the caller's final fresh SQL authority rows. */
export function captureCheckboxGrantContext(
  authority: DocGrantAuthority,
  original: DocGrantRow,
  channel: DocChannelRow,
  scope: string,
  tx: DbTransaction
): Pick<DocGrantAuthority, 'resolveScope' | 'resolveTarget' | 'originCurrent'> {
  const values = new Map<string, string>();
  const capture = (input: unknown): string => {
    if (typeof input !== 'string')
      throw new Error('Original write scope requires plain string data.');
    const prior = values.get(input);
    if (prior !== undefined) return prior;
    const result = checkboxAuthoritySync(authority.resolveScope(input, tx));
    if (typeof result !== 'string')
      throw new Error('Original write scope requires plain string data.');
    values.set(input, result);
    return result;
  };
  const access = checkboxAuthoritySync(authority.requireGrantedCurrent(original, tx));
  if (access.id !== original.documentId || capture(access.scope) !== scope)
    throw new CheckboxAuthorityRefusal('GRANT_AUTHORITY_LOST');
  const route = declaredRoute(channel, original.routeId);
  const target = checkboxAuthoritySync(
    authority.resolveTarget(
      { documentId: original.documentId, scope, route, openerAgentId: channel.openerAgentId },
      tx
    )
  );
  const evidence = original.approvalEvidence as {
    binding?: { scope?: unknown; target?: DocGrantTarget };
  };
  capture(evidence.binding?.scope);
  capture(evidence.binding?.target?.scope);
  for (const session of [
    evidence.binding?.target?.sessionId,
    original.targetSessionId,
    target.sessionId,
  ])
    if (session !== null && session !== undefined) capture(`session:${session}`);
  const origin =
    route.to === 'log' || !original.openerAgentId
      ? false
      : checkboxAuthoritySync(
          authority.originCurrent(original.documentId, original.openerAgentId, tx)
        );
  if (typeof origin !== 'boolean') throw new Error('Original write origin must be boolean.');
  return {
    resolveScope: (input) => {
      const result = values.get(input);
      if (result === undefined) throw new Error('Original write callback context changed.');
      return result;
    },
    resolveTarget: () => target,
    originCurrent: () => origin,
  };
}
