/* eslint-disable max-lines -- Keep the single journal writer and its original file custody in one module so private handoff membership and sticky failure state share one owner. */
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse } from 'node:path';
import { z } from 'zod';
import type { ProcessIdentity } from '../configuration.js';

/** Recorded data only. None of these projections authorizes native cleanup or profile reuse. */
export const JOURNAL_LIMITS = Object.freeze({
  bytes: 1048576,
  writerBytes: 4096,
  identities: 512,
  gaps: 32,
  depth: 16,
  pending: 8,
});
export const GAP_CODES = [
  'boot-unknown',
  'boot-changed',
  'identity-unknown',
  'root-pending',
  'parent-changed',
  'association-missing',
  'observer-lost',
  'sequence-gap',
  'frame-invalid',
  'capacity-exceeded',
  'read-uncertain',
  'persistence-uncertain',
  'custody-pending',
] as const;
export type JournalCause = (typeof GAP_CODES)[number];
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = (cap: number) =>
  z
    .string()
    .min(1)
    .refine(
      (v) =>
        v.length <= cap &&
        Buffer.byteLength(v) <= cap &&
        Buffer.from(v).toString('utf8') === v &&
        ![...v].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    );
const opaque = text(64).refine((v) => /^[A-Za-z0-9_-]+$/.test(v));
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ProcessIdentitySchema = z
  .object({ pid: counter.refine((v) => v > 0), birth: text(128) })
  .strict();
export const BootScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('observed'), value: text(128), sourceIdentityDigest: digestSchema })
    .strict(),
  z.object({ kind: z.literal('unknown'), cause: z.enum(GAP_CODES) }).strict(),
]);
export const JournalBindingSchema = z
  .object({
    journalId: opaque,
    browserId: opaque,
    profile: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('persistent'), profileId: opaque }).strict(),
      z.object({ kind: z.literal('ephemeral') }).strict(),
    ]),
    browserGeneration: counter,
    reservationNonce: opaque,
    runtimeIdentityDigest: digestSchema,
    manager: ProcessIdentitySchema,
    bootScope: BootScopeSchema,
  })
  .strict();
export const JournalWriterSchema = z
  .object({ writerId: opaque, epoch: counter, kind: z.enum(['manager', 'observer', 'reconciler']) })
  .strict();
export const ObservationWindowSchema = z
  .object({
    startSequence: counter,
    checkpointSequence: counter,
    endSequence: counter,
    startMonotonic: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    endMonotonic: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (w) =>
      w.startSequence <= w.checkpointSequence &&
      w.checkpointSequence <= w.endSequence &&
      w.startMonotonic <= w.endMonotonic
  );
export const AssociationSchema = z
  .object({
    parentBefore: ProcessIdentitySchema,
    parentAfter: ProcessIdentitySchema,
    child: ProcessIdentitySchema,
    childParentPid: counter.refine((v) => v > 0),
    window: ObservationWindowSchema,
    recordedSequence: counter,
    parentDeathSequence: counter.nullable(),
  })
  .strict()
  .refine(
    (a) =>
      sameProcess(a.parentBefore, a.parentAfter) &&
      a.child.pid !== a.parentBefore.pid &&
      a.childParentPid === a.parentBefore.pid &&
      a.window.endSequence <= a.recordedSequence &&
      (a.parentDeathSequence === null || a.recordedSequence < a.parentDeathSequence)
  );
const retainedSchema = z
  .object({
    identity: ProcessIdentitySchema,
    role: z.enum(['manager', 'root', 'descendant']),
    parent: ProcessIdentitySchema.nullable(),
    association: AssociationSchema.nullable(),
    currentParent: ProcessIdentitySchema.nullable(),
    acquisitionEpoch: counter,
    firstSeenSequence: counter,
    lastSeenSequence: counter,
    relationWindow: ObservationWindowSchema,
    lifecycle: z.enum(['alive', 'exited-unreaped', 'dead', 'replacement', 'unknown']),
  })
  .strict();
const gapSchema = z
  .object({
    cause: z.enum(GAP_CODES),
    firstSequence: counter,
    identity: ProcessIdentitySchema.nullable(),
    count: counter.refine((v) => v > 0),
  })
  .strict();
const causeSchema = z.object({ cause: z.enum(GAP_CODES), sequence: counter }).strict();
export const JournalSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('browser-process-journal'),
    provenance: z.literal('recorded-data'),
    binding: JournalBindingSchema,
    writer: JournalWriterSchema,
    sequence: counter,
    phase: z.enum([
      'allocated',
      'launch-intent',
      'observing',
      'manager-lost',
      'reconciling',
      'observation-ended',
      'retained',
    ]),
    observationWindow: ObservationWindowSchema,
    root: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('pending') }).strict(),
      z.object({ kind: z.literal('absent-before-launch') }).strict(),
      z
        .object({
          kind: z.literal('attributed'),
          identity: ProcessIdentitySchema,
          association: AssociationSchema,
        })
        .strict(),
    ]),
    retainedIdentities: z.array(retainedSchema).max(JOURNAL_LIMITS.identities),
    gaps: z.array(gapSchema).max(JOURNAL_LIMITS.gaps),
    firstCause: causeSchema.nullable(),
  })
  .strict();
export type JournalBinding = z.infer<typeof JournalBindingSchema>;
export type JournalWriterIdentity = z.infer<typeof JournalWriterSchema>;
export type ObservationWindow = z.infer<typeof ObservationWindowSchema>;
export type RecordedAssociation = z.infer<typeof AssociationSchema>;
export type JournalSnapshot = z.infer<typeof JournalSnapshotSchema>;
export type JournalGap = JournalSnapshot['gaps'][number];

/** Closed journal failure; recorded data cannot grant native authority. */
export class ProcessJournalError extends Error {
  constructor(readonly causeCode: JournalCause) {
    super(causeCode);
    this.name = 'ProcessJournalError';
  }
}
function insist(ok: unknown, cause: JournalCause = 'frame-invalid'): asserts ok {
  if (!ok) throw new ProcessJournalError(cause);
}
/** Exact lifetime comparison; never PID-only or textual boot-only. */
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.birth === b.birth;
}
/** Stable key for the exact recorded PID and birth pair. */
export function processKey(identity: ProcessIdentity): string {
  return JSON.stringify([identity.pid, identity.birth]);
}

/** Inspect own data descriptors before any schema access; never invoke getters/thenables/toJSON. */
export function copyJournalData(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    insist(++nodes <= 32768 && depth <= JOURNAL_LIMITS.depth, 'capacity-exceeded');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      insist(Number.isFinite(item));
      return item;
    }
    if (typeof item === 'string') {
      insist(item.length <= 128 && Buffer.byteLength(item) <= 128, 'capacity-exceeded');
      insist(Buffer.from(item).toString('utf8') === item);
      return item;
    }
    insist(typeof item === 'object' && item !== null);
    insist(!seen.has(item));
    seen.add(item);
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    insist(array ? proto === Array.prototype : proto === Object.prototype || proto === null);
    insist(Object.getOwnPropertySymbols(item).length === 0);
    const keys = Object.getOwnPropertyNames(item);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(item, 'length');
      insist(
        length &&
          'value' in length &&
          Number.isSafeInteger(length.value) &&
          length.value >= 0 &&
          length.value <= JOURNAL_LIMITS.identities,
        'capacity-exceeded'
      );
      insist(keys.length === length.value + 1);
      const out: unknown[] = [];
      for (let i = 0; i < length.value; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        insist(descriptor && 'value' in descriptor && descriptor.enumerable);
        out.push(visit(descriptor.value, depth + 1));
      }
      seen.delete(item);
      return out;
    }
    insist(keys.length <= 24, 'capacity-exceeded');
    const out: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      insist(
        key.length <= 64 &&
          !['__proto__', 'constructor', 'prototype', 'then', 'toJSON'].includes(key)
      );
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      insist(descriptor && 'value' in descriptor && descriptor.enumerable);
      out[key] = visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
    return out;
  };
  try {
    return visit(value, 0);
  } catch (error) {
    throw error instanceof ProcessJournalError ? error : new ProcessJournalError('frame-invalid');
  }
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
/** Stable bounded JSON bytes. Canonical equality is integrity, never issuer membership. */
export function recordedJSON(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)])
      );
    return item;
  };
  return JSON.stringify(sort(copyJournalData(value)));
}
/** Compare the complete recorded binding without creating producer membership. */
export function sameJournalBinding(a: JournalBinding, b: JournalBinding): boolean {
  return recordedJSON(a) === recordedJSON(b);
}
/** Closed snapshot validation includes original parent windows and sticky-history consistency. */
export function validateJournalSnapshot(value: unknown): JournalSnapshot {
  const parsed = JournalSnapshotSchema.safeParse(copyJournalData(value));
  insist(parsed.success);
  const s = parsed.data;
  insist(s.observationWindow.endSequence <= s.sequence);
  const identities = new Map(s.retainedIdentities.map((r) => [processKey(r.identity), r]));
  insist(identities.size === s.retainedIdentities.length);
  const managers = s.retainedIdentities.filter((r) => r.role === 'manager');
  insist(managers.length === 1 && sameProcess(managers[0]!.identity, s.binding.manager));
  for (const r of s.retainedIdentities) {
    insist(
      r.firstSeenSequence <= r.lastSeenSequence &&
        r.lastSeenSequence <= s.sequence &&
        r.relationWindow.endSequence <= r.firstSeenSequence &&
        r.acquisitionEpoch <= s.writer.epoch
    );
    // A recorded terminal fact remains retained; only attributed nonroot originals may await reaping.
    if (r.lifecycle === 'exited-unreaped')
      insist(
        r.role === 'descendant' &&
          r.association !== null &&
          r.parent !== null &&
          r.firstSeenSequence < r.lastSeenSequence,
        'association-missing'
      );
    if (r.lifecycle === 'unknown')
      insist(
        s.gaps.some(
          (g) =>
            g.cause === 'identity-unknown' &&
            (g.identity === null || sameProcess(g.identity, r.identity))
        ),
        'identity-unknown'
      );
    if (r.role === 'manager') insist(r.parent === null && r.association === null);
    else {
      const a = r.association;
      insist(
        a &&
          r.parent &&
          sameProcess(a.parentBefore, r.parent) &&
          sameProcess(a.child, r.identity) &&
          a.recordedSequence === r.firstSeenSequence &&
          identities.has(processKey(r.parent)),
        'association-missing'
      );
      insist(recordedJSON(a.window) === recordedJSON(r.relationWindow));
      let ancestor: ProcessIdentity | null = r.parent,
        depth = 0;
      const visited = new Set([processKey(r.identity)]);
      while (ancestor) {
        const originalAncestor = ancestor;
        const key = processKey(originalAncestor);
        insist(!visited.has(key) && ++depth <= JOURNAL_LIMITS.depth, 'association-missing');
        visited.add(key);
        const parent = identities.get(key);
        insist(parent, 'association-missing');
        ancestor = parent.parent;
      }
    }
  }
  const roots = s.retainedIdentities.filter((r) => r.role === 'root');
  if (s.root.kind === 'attributed') {
    insist(
      roots.length === 1 &&
        sameProcess(roots[0]!.identity, s.root.identity) &&
        recordedJSON(roots[0]!.association) === recordedJSON(s.root.association),
      'association-missing'
    );
  } else insist(roots.length === 0, 'root-pending');
  const gapKinds = new Set(s.gaps.map((g) => g.cause));
  insist(gapKinds.size === s.gaps.length && s.gaps.every((g) => g.firstSequence <= s.sequence));
  if (s.gaps.length)
    insist(
      s.firstCause &&
        s.gaps.some(
          (g) => g.cause === s.firstCause!.cause && g.firstSequence === s.firstCause!.sequence
        ) &&
        s.firstCause.sequence === Math.min(...s.gaps.map((g) => g.firstSequence))
    );
  else insist(s.firstCause === null);
  insist(Buffer.byteLength(recordedJSON(s)) <= JOURNAL_LIMITS.bytes, 'capacity-exceeded');
  return frozen(s);
}
const phases: JournalSnapshot['phase'][] = [
  'allocated',
  'launch-intent',
  'observing',
  'manager-lost',
  'reconciling',
  'observation-ended',
  'retained',
];
function successor(prior: JournalSnapshot, next: JournalSnapshot): void {
  insist(
    sameJournalBinding(prior.binding, next.binding) &&
      next.sequence === prior.sequence + 1 &&
      next.writer.epoch === prior.writer.epoch &&
      recordedJSON(next.writer) === recordedJSON(prior.writer),
    'sequence-gap'
  );
  insist(
    phases.indexOf(next.phase) >= phases.indexOf(prior.phase) &&
      next.observationWindow.startSequence >= prior.observationWindow.startSequence &&
      next.observationWindow.checkpointSequence >= prior.observationWindow.checkpointSequence &&
      next.observationWindow.endSequence >= prior.observationWindow.endSequence &&
      next.observationWindow.startMonotonic >= prior.observationWindow.startMonotonic &&
      next.observationWindow.endMonotonic >= prior.observationWindow.endMonotonic,
    'sequence-gap'
  );
  if (prior.root.kind === 'attributed')
    insist(recordedJSON(prior.root) === recordedJSON(next.root), 'association-missing');
  if (prior.firstCause) insist(recordedJSON(prior.firstCause) === recordedJSON(next.firstCause));
  for (const gap of prior.gaps)
    insist(
      next.gaps.some(
        (g) =>
          g.cause === gap.cause &&
          g.firstSequence === gap.firstSequence &&
          g.count >= gap.count &&
          recordedJSON(g.identity) === recordedJSON(gap.identity)
      )
    );
  for (const old of prior.retainedIdentities) {
    const current = next.retainedIdentities.find((r) => sameProcess(r.identity, old.identity));
    insist(
      current &&
        current.role === old.role &&
        current.acquisitionEpoch === old.acquisitionEpoch &&
        current.firstSeenSequence === old.firstSeenSequence &&
        current.lastSeenSequence >= old.lastSeenSequence &&
        recordedJSON(current.parent) === recordedJSON(old.parent) &&
        recordedJSON(current.association) === recordedJSON(old.association) &&
        recordedJSON(current.relationWindow) === recordedJSON(old.relationWindow),
      'association-missing'
    );
  }
  for (const old of prior.retainedIdentities)
    if (old.lifecycle === 'exited-unreaped') {
      const current = next.retainedIdentities.find((r) => sameProcess(r.identity, old.identity));
      insist(current && current.lifecycle !== 'alive', 'identity-unknown');
    }
  for (const added of next.retainedIdentities)
    if (!prior.retainedIdentities.some((r) => sameProcess(r.identity, added.identity))) {
      insist(
        added.role !== 'manager' && added.firstSeenSequence === next.sequence,
        'association-missing'
      );
      const originalParent = prior.retainedIdentities.find(
        (r) => added.parent && sameProcess(r.identity, added.parent)
      );
      if (originalParent) {
        insist(originalParent.lifecycle === 'alive', 'association-missing');
        continue;
      }
      let node = added;
      const visited = new Set<string>();
      for (;;) {
        const key = processKey(node.identity);
        insist(!visited.has(key) && visited.size < JOURNAL_LIMITS.depth, 'association-missing');
        visited.add(key);
        const window = node.relationWindow;
        insist(
          node.role !== 'manager' &&
            node.lifecycle === 'alive' &&
            node.firstSeenSequence === next.sequence &&
            node.lastSeenSequence === next.sequence &&
            node.acquisitionEpoch === next.writer.epoch &&
            window.startSequence === next.sequence &&
            window.checkpointSequence === next.sequence &&
            window.endSequence === next.sequence &&
            window.startMonotonic === next.observationWindow.startMonotonic &&
            window.endMonotonic <= next.observationWindow.endMonotonic &&
            node.parent,
          'association-missing'
        );
        const identity = node.parent;
        const priorParent = prior.retainedIdentities.find((r) => sameProcess(r.identity, identity));
        if (priorParent) {
          insist(priorParent.lifecycle === 'alive', 'association-missing');
          break;
        }
        const parent = next.retainedIdentities.find((r) => sameProcess(r.identity, identity));
        insist(
          parent && parent.relationWindow.endMonotonic <= window.endMonotonic,
          'association-missing'
        );
        node = parent;
      }
    }
}

export interface JournalDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly uid: number;
  readonly type: 'directory';
}
type FileIdentity =
  | JournalDirectoryIdentity
  | Readonly<{
      device: string;
      inode: string;
      mode: number;
      uid: number;
      type: 'file';
      size: string;
      mtimeNs: string;
      ctimeNs: string;
    }>;
export type JournalFaultPoint =
  | 'parent-check'
  | 'namespace-created'
  | 'namespace-sync'
  | 'parent-sync'
  | 'marker-open'
  | 'marker-write'
  | 'marker-sync'
  | 'marker-close'
  | 'payload-open'
  | 'payload-write'
  | 'payload-sync'
  | 'payload-close'
  | 'snapshot-rename'
  | 'snapshot-directory-sync'
  | 'reader-open'
  | 'reader-read'
  | 'reader-close'
  | 'directory-close'
  | 'handoff-write'
  | 'marker-unlink'
  | 'handoff-directory-sync';
interface JournalHooks {
  /** Trusted fault seam surrounds real operations; cannot supply accepted filesystem facts. */
  readonly fault?: (point: JournalFaultPoint) => void | Promise<void>;
  readonly writeChunkBytes?: number;
}
export interface JournalLocation {
  readonly parentDirectory: string;
  readonly parentIdentity: JournalDirectoryIdentity;
  readonly binding: JournalBinding;
}
interface Duty {
  handle?: FileHandle;
  acquisitionPending: boolean;
  acquired: boolean;
  closeAttempted: boolean;
  closed: boolean;
}
export interface JournalCustody {
  readonly opens: number;
  readonly closesAttempted: number;
  readonly closed: number;
  readonly held: number;
}
// Failed original closes retain their actual handles. This is finite filesystem custody,
// not a process ownership/retirement registry. There is no retry or timeout release.
const heldFiles = new Set<Files>();
let localFileSlots = 0;
class Files {
  readonly duties: Duty[] = [];
  constructor(readonly hooks: JournalHooks = {}) {}
  async point(point: JournalFaultPoint): Promise<void> {
    await this.hooks.fault?.(point);
  }
  async open(path: string, flags: number, mode = 0o600): Promise<Duty> {
    insist(this.duties.length < 64 && localFileSlots < 64, 'capacity-exceeded');
    const duty: Duty = {
      acquisitionPending: true,
      acquired: false,
      closeAttempted: false,
      closed: false,
    };
    this.duties.push(duty);
    localFileSlots++; // Reserve synchronously before the original fallible open.
    try {
      duty.handle = await fs.open(path, flags, mode);
      duty.acquired = true;
      duty.acquisitionPending = false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOENT') {
        duty.acquisitionPending = false;
        localFileSlots--;
      }
      // Other failed-open dispositions stay uncertain; no guessed no-acquisition refund.
      throw error;
    }
    return duty;
  }
  async close(duty: Duty, point?: JournalFaultPoint): Promise<void> {
    if (duty.closeAttempted) return;
    duty.closeAttempted = true;
    let failed = false,
      fault: unknown;
    try {
      if (point) await this.point(point);
    } catch (error) {
      failed = true;
      fault = error;
    }
    try {
      await duty.handle!.close();
      duty.closed = true;
      localFileSlots--;
    } catch (error) {
      if (!failed) {
        failed = true;
        fault = error;
      }
    }
    if (failed) throw fault;
  }
  async drain(): Promise<boolean> {
    let ok = true;
    for (const duty of this.duties)
      if (duty.acquired && !duty.closeAttempted) {
        try {
          await this.close(duty);
        } catch {
          ok = false;
        }
      }
    const returned =
      ok && this.duties.every((d) => !d.acquisitionPending && (!d.acquired || d.closed));
    if (this.duties.some((d) => d.acquisitionPending || (d.acquired && !d.closed)))
      heldFiles.add(this);
    return returned;
  }
  custody(): JournalCustody {
    return Object.freeze({
      opens: this.duties.filter((d) => d.acquired).length,
      closesAttempted: this.duties.filter((d) => d.closeAttempted).length,
      closed: this.duties.filter((d) => d.closed).length,
      held: this.duties.filter((d) => d.acquisitionPending || (d.acquired && !d.closed)).length,
    });
  }
}
/** Close the exact acquired original once; cleanup must not replace an earlier failure. */
async function withOriginalClose<T>(
  io: Files,
  duty: Duty,
  operation: () => Promise<T>,
  point: JournalFaultPoint
): Promise<T> {
  let failed = false,
    failure: unknown;
  let result!: T;
  try {
    result = await operation();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await io.close(duty, point);
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  // A rejection may carry undefined/null; the separate flag preserves that completion too.
  if (failed) throw failure;
  return result;
}
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const createFlags =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;
function identity(s: BigIntStats): FileIdentity {
  const shared = {
    device: String(s.dev),
    inode: String(s.ino),
    mode: Number(s.mode),
    uid: Number(s.uid),
  };
  if (s.isDirectory()) return { ...shared, type: 'directory' };
  insist(s.isFile() && !s.isSymbolicLink(), 'read-uncertain');
  return {
    ...shared,
    type: 'file',
    size: String(s.size),
    mtimeNs: String(s.mtimeNs),
    ctimeNs: String(s.ctimeNs),
  };
}
function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function sameDirectory(a: FileIdentity, b: JournalDirectoryIdentity): boolean {
  return (
    a.type === 'directory' &&
    a.device === b.device &&
    a.inode === b.inode &&
    a.mode === b.mode &&
    a.uid === b.uid
  );
}
async function named(path: string): Promise<FileIdentity> {
  return identity(await fs.lstat(path, { bigint: true }));
}
async function maybe(path: string): Promise<FileIdentity | null> {
  try {
    return await named(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
/** Data-only parent observation for trusted composition; no recursive directory creation. */
export async function observeJournalDirectory(path: string): Promise<JournalDirectoryIdentity> {
  insist(isAbsolute(path) && normalize(path) === path && path.length <= 4096, 'read-uncertain');
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    insist((await named(current)).type === 'directory', 'read-uncertain');
  }
  const value = await named(path);
  insist(value.type === 'directory' && (value.mode & 0o077) === 0, 'read-uncertain');
  return Object.freeze(value);
}
function location(options: JournalLocation): JournalLocation {
  const binding = JournalBindingSchema.parse(copyJournalData(options.binding));
  const p = z
    .object({
      device: z.string().regex(/^\d+$/),
      inode: z.string().regex(/^\d+$/),
      mode: counter,
      uid: counter,
      type: z.literal('directory'),
    })
    .strict()
    .parse(copyJournalData(options.parentIdentity));
  insist(
    p &&
      p.type === 'directory' &&
      /^\d+$/.test(p.device) &&
      /^\d+$/.test(p.inode) &&
      Number.isSafeInteger(p.mode) &&
      Number.isSafeInteger(p.uid) &&
      (p.mode & 0o077) === 0,
    'read-uncertain'
  );
  insist(
    isAbsolute(options.parentDirectory) &&
      normalize(options.parentDirectory) === options.parentDirectory &&
      options.parentDirectory.length <= 4096,
    'read-uncertain'
  );
  return Object.freeze({
    parentDirectory: options.parentDirectory,
    parentIdentity: Object.freeze({ ...p }),
    binding: frozen(binding),
  });
}
function rootPath(l: JournalLocation): string {
  return join(l.parentDirectory, 'journal-' + l.binding.journalId);
}
async function assertParent(l: JournalLocation, io: Files): Promise<void> {
  await io.point('parent-check');
  insist(
    sameDirectory(await observeJournalDirectory(l.parentDirectory), l.parentIdentity),
    'parent-changed'
  );
}
async function assertRoot(
  l: JournalLocation,
  pin: JournalDirectoryIdentity,
  io: Files
): Promise<void> {
  await assertParent(l, io);
  insist(sameDirectory(await named(rootPath(l)), pin), 'parent-changed');
}
async function syncDirectory(path: string, io: Files, point: JournalFaultPoint): Promise<void> {
  const before = await named(path);
  insist(before.type === 'directory', 'persistence-uncertain');
  const d = await io.open(path, readFlags | constants.O_DIRECTORY);
  await withOriginalClose(
    io,
    d,
    async () => {
      insist(
        sameFile(before, identity(await d.handle!.stat({ bigint: true }))),
        'persistence-uncertain'
      );
      await io.point(point);
      await d.handle!.sync();
      insist(sameFile(before, await named(path)), 'persistence-uncertain');
    },
    'directory-close'
  );
}
async function writeAll(
  d: Duty,
  bytes: Buffer,
  io: Files,
  point: JournalFaultPoint
): Promise<void> {
  const cap = io.hooks.writeChunkBytes ?? 65536;
  insist(Number.isSafeInteger(cap) && cap > 0 && cap <= 65536);
  let offset = 0;
  while (offset < bytes.length) {
    await io.point(point);
    const { bytesWritten } = await d.handle!.write(
      bytes,
      offset,
      Math.min(cap, bytes.length - offset),
      offset
    );
    insist(
      bytesWritten > 0 && bytesWritten <= Math.min(cap, bytes.length - offset),
      'persistence-uncertain'
    );
    offset += bytesWritten;
  }
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
interface ReadValue {
  snapshot: JournalSnapshot;
  digest: string;
  identity: FileIdentity;
}
function checkDepth(bytes: Buffer): string {
  const textValue = bytes.toString('utf8');
  insist(Buffer.from(textValue).equals(bytes));
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const char of textValue) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[')
      insist(++depth <= JOURNAL_LIMITS.depth, 'capacity-exceeded');
    else if (char === '}' || char === ']') insist(--depth >= 0);
  }
  insist(!quoted && depth === 0);
  return textValue;
}
async function readSnapshot(
  l: JournalLocation,
  root: JournalDirectoryIdentity,
  io: Files
): Promise<ReadValue | null> {
  await assertRoot(l, root, io);
  const path = join(rootPath(l), 'snapshot.json');
  const before = await maybe(path);
  if (!before) {
    await assertRoot(l, root, io);
    insist((await maybe(path)) === null, 'read-uncertain');
    return null;
  }
  insist(
    before.type === 'file' &&
      BigInt(before.size) <= BigInt(JOURNAL_LIMITS.bytes) &&
      before.uid === root.uid &&
      (before.mode & 0o077) === 0,
    'read-uncertain'
  );
  await io.point('reader-open');
  const d = await io.open(path, readFlags);
  const result = await withOriginalClose(
    io,
    d,
    async (): Promise<ReadValue> => {
      insist(sameFile(before, identity(await d.handle!.stat({ bigint: true }))), 'read-uncertain');
      const buffer = Buffer.alloc(Math.min(JOURNAL_LIMITS.bytes + 1, Number(before.size) + 1));
      let offset = 0;
      while (offset < buffer.length) {
        await io.point('reader-read');
        const { bytesRead } = await d.handle!.read(
          buffer,
          offset,
          Math.min(65536, buffer.length - offset),
          offset
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      insist(offset === Number(before.size), 'read-uncertain');
      const bytes = buffer.subarray(0, offset);
      const raw = checkDepth(bytes);
      const snapshot = validateJournalSnapshot(JSON.parse(raw));
      // Reject ambiguous duplicate-key/noncanonical documents produced outside this closed writer.
      insist(recordedJSON(snapshot) === raw);
      insist(sameJournalBinding(snapshot.binding, l.binding), 'boot-changed');
      insist(
        sameFile(before, identity(await d.handle!.stat({ bigint: true }))) &&
          sameFile(before, await named(path)),
        'read-uncertain'
      );
      return { snapshot, digest: sha(bytes), identity: before };
    },
    'reader-close'
  );
  insist(sameFile(before, await named(path)), 'read-uncertain');
  await assertRoot(l, root, io);
  return result;
}
export type JournalReadResult =
  | Readonly<{ state: 'missing'; custody: JournalCustody }>
  | Readonly<{
      state: 'valid-recorded-data';
      snapshot: JournalSnapshot;
      digest: string;
      identity: FileIdentity;
      custody: JournalCustody;
    }>
  | Readonly<{ state: 'refused'; cause: JournalCause; custody: JournalCustody }>;
/** Bounded nofollow original-FD read. A valid record is never a writer or native permit. */
export async function readJournal(
  options: JournalLocation & JournalHooks
): Promise<JournalReadResult> {
  const io = new Files(options);
  let result:
    | { state: 'missing' }
    | {
        state: 'valid-recorded-data';
        snapshot: JournalSnapshot;
        digest: string;
        identity: FileIdentity;
      }
    | { state: 'refused'; cause: JournalCause };
  try {
    const l = location(options);
    await assertParent(l, io);
    const root = await maybe(rootPath(l));
    if (!root) {
      await assertParent(l, io);
      insist((await maybe(rootPath(l))) === null, 'read-uncertain');
      result = { state: 'missing' };
    } else {
      insist(
        root.type === 'directory' && root.uid === l.parentIdentity.uid && (root.mode & 0o077) === 0,
        'read-uncertain'
      );
      const read = await readSnapshot(l, root, io);
      result = read ? { state: 'valid-recorded-data', ...read } : { state: 'missing' };
    }
  } catch (error) {
    result = {
      state: 'refused',
      cause: error instanceof ProcessJournalError ? error.causeCode : 'read-uncertain',
    };
  }
  if (!(await io.drain()) && result.state !== 'refused')
    result = { state: 'refused', cause: 'custody-pending' };
  return Object.freeze({ ...result, custody: io.custody() }) as JournalReadResult;
}

const ticketBrand: unique symbol = Symbol('journal-successor');
export type JournalSuccessorTicket = Readonly<{ [ticketBrand]: true }>;
interface TicketData {
  location: JournalLocation;
  root: JournalDirectoryIdentity;
  prior: ReadValue | null;
  writer: JournalWriterIdentity;
  used: boolean;
}
const tickets = new WeakMap<JournalSuccessorTicket, TicketData>();
export type JournalCommitResult =
  | Readonly<{
      state: 'durable-recorded';
      sequence: number;
      digest: string;
      custody: JournalCustody;
    }>
  | Readonly<{
      state: 'uncertain';
      cause: JournalCause;
      phase: string;
      oldDigest: string | null;
      newDigest: string | null;
      custody: JournalCustody;
    }>;
export type JournalCloseResult =
  | Readonly<{ state: 'closed'; custody: JournalCustody }>
  | Readonly<{ state: 'uncertain'; cause: JournalCause; custody: JournalCustody }>;
export type JournalHandoffResult =
  | Readonly<{
      state: 'handed-off';
      ticket: JournalSuccessorTicket;
      sequence: number | null;
      digest: string | null;
      custody: JournalCustody;
    }>
  | Readonly<{ state: 'uncertain'; cause: JournalCause; custody: JournalCustody }>;
export interface ProcessJournalWriter {
  commitSnapshot(snapshot: unknown): Promise<JournalCommitResult>;
  handoff(nextWriter: JournalWriterIdentity): Promise<JournalHandoffResult>;
  close(): Promise<JournalCloseResult>;
}
export type JournalOpenResult =
  | Readonly<{ state: 'allocated'; writer: ProcessJournalWriter; custody: JournalCustody }>
  | Readonly<{
      state: 'busy' | 'refused' | 'uncertain';
      cause: JournalCause;
      custody: JournalCustody;
    }>;
export type JournalPrior =
  Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'recorded'; sequence: number; digest: string }>;

/** Exclusive cooperating writer. No stale lock theft or cross-process adoption is supplied here. */
export async function openJournalWriter(
  options: JournalLocation &
    JournalHooks &
    Readonly<{
      writer: JournalWriterIdentity;
      prior: JournalPrior;
      ticket?: JournalSuccessorTicket;
    }>
): Promise<JournalOpenResult> {
  const io = new Files(options);
  let marker: Duty | undefined;
  let l: JournalLocation, root: JournalDirectoryIdentity, prior: ReadValue | null;
  let writerIdentity: JournalWriterIdentity, markerPin: FileIdentity;
  const markerName = 'writer.json',
    temporaryName = 'snapshot.tmp';
  let markerAcquired = false;
  try {
    l = location(options);
    writerIdentity = frozen(JournalWriterSchema.parse(copyJournalData(options.writer)));
    const expected = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('absent') }).strict(),
        z.object({ kind: z.literal('recorded'), sequence: counter, digest: digestSchema }).strict(),
      ])
      .parse(copyJournalData(options.prior));
    await assertParent(l, io);
    const ticket = options.ticket && tickets.get(options.ticket);
    if (options.ticket) {
      insist(
        ticket &&
          !ticket.used &&
          sameJournalBinding(ticket.location.binding, l.binding) &&
          ticket.location.parentDirectory === l.parentDirectory &&
          sameDirectory(ticket.location.parentIdentity, l.parentIdentity) &&
          recordedJSON(ticket.writer) === recordedJSON(writerIdentity),
        'sequence-gap'
      );
      ticket.used = true; // Consume before any acquisition; a failed attempt cannot replay it.
    } else insist(expected.kind === 'absent', 'custody-pending');
    let initial = await maybe(rootPath(l));
    if (initial && !ticket) {
      // Even an empty abandoned namespace is not fresh absence or takeover authority.
      if (await maybe(join(rootPath(l), markerName))) {
        const busy = new Error('journal writer exists') as NodeJS.ErrnoException;
        busy.code = 'EEXIST';
        throw busy;
      }
      throw new ProcessJournalError('custody-pending');
    }
    if (!initial) {
      insist(!ticket && expected.kind === 'absent', 'sequence-gap');
      await fs.mkdir(rootPath(l), { mode: 0o700 });
      initial = await named(rootPath(l));
      insist(
        initial.type === 'directory' &&
          initial.uid === l.parentIdentity.uid &&
          (initial.mode & 0o077) === 0
      );
      await io.point('namespace-created');
      await assertRoot(l, initial, io);
      await syncDirectory(rootPath(l), io, 'namespace-sync');
      await syncDirectory(l.parentDirectory, io, 'parent-sync');
    }
    insist(
      initial.type === 'directory' &&
        initial.uid === l.parentIdentity.uid &&
        (initial.mode & 0o077) === 0,
      'read-uncertain'
    );
    root = initial;
    if (ticket) insist(sameDirectory(root, ticket.root), 'read-uncertain');
    await assertRoot(l, root, io);
    await io.point('marker-open');
    await assertRoot(l, root, io);
    marker = await io.open(join(rootPath(l), markerName), createFlags);
    markerAcquired = true;
    prior = await readSnapshot(l, root, io);
    if (expected.kind === 'absent') insist(prior === null, 'sequence-gap');
    else
      insist(
        prior &&
          prior.digest === expected.digest &&
          prior.snapshot.sequence === expected.sequence &&
          ticket &&
          ticket.prior?.digest === prior.digest,
        'sequence-gap'
      );
    insist((await maybe(join(rootPath(l), temporaryName))) === null, 'persistence-uncertain');
    const ownerBytes = Buffer.from(
      recordedJSON({
        schemaVersion: 1,
        binding: l.binding,
        writer: writerIdentity,
        phase: 'allocated',
        sequence: prior?.snapshot.sequence ?? null,
        digest: prior?.digest ?? null,
      })
    );
    insist(ownerBytes.length <= JOURNAL_LIMITS.writerBytes, 'capacity-exceeded');
    await writeAll(marker, ownerBytes, io, 'marker-write');
    await io.point('marker-sync');
    await marker.handle!.sync();
    markerPin = identity(await marker.handle!.stat({ bigint: true }));
    insist(sameFile(markerPin, await named(join(rootPath(l), markerName))));
    await syncDirectory(rootPath(l), io, 'namespace-sync');
    await syncDirectory(l.parentDirectory, io, 'parent-sync');
    await assertRoot(l, root, io);
  } catch (error) {
    await io.drain();
    const busy =
      !markerAcquired && (error as NodeJS.ErrnoException | null | undefined)?.code === 'EEXIST';
    return Object.freeze({
      state: busy ? 'busy' : markerAcquired ? 'uncertain' : 'refused',
      cause:
        error instanceof ProcessJournalError
          ? error.causeCode
          : busy
            ? 'custody-pending'
            : 'persistence-uncertain',
      custody: io.custody(),
    });
  }
  // The marker original is the sole long-lived FD. Completed operation histories are bounded per call.
  const markerOriginal = marker!;
  let accepting = true,
    firstCause: JournalCause | null = null,
    pending = 0;
  let tail: Promise<void> = Promise.resolve();
  let closePromise: Promise<JournalCloseResult> | null = null;
  let handoffPromise: Promise<JournalHandoffResult> | null = null;
  const heldCalls = new Set<Files>();
  const custody = (): JournalCustody => {
    const records = [io.custody(), ...[...heldCalls].map((call) => call.custody())];
    return Object.freeze({
      opens: records.reduce((n, r) => n + r.opens, 0),
      closesAttempted: records.reduce((n, r) => n + r.closesAttempted, 0),
      closed: records.reduce((n, r) => n + r.closed, 0),
      held: records.reduce((n, r) => n + r.held, 0),
    });
  };
  const fail = (cause: JournalCause) => {
    firstCause ??= cause;
    accepting = false;
  };
  const markerCurrent = async (call: Files) => {
    insist(firstCause === null, firstCause ?? 'persistence-uncertain');
    await assertRoot(l, root, call);
    insist(firstCause === null, firstCause ?? 'persistence-uncertain');
    insist(
      sameFile(markerPin, identity(await markerOriginal.handle!.stat({ bigint: true }))) &&
        sameFile(markerPin, await named(join(rootPath(l), markerName))),
      'persistence-uncertain'
    );
  };
  const uncertain = (call: Files, phase: string, nextDigest: string | null): JournalCommitResult =>
    Object.freeze({
      state: 'uncertain',
      cause: firstCause ?? 'persistence-uncertain',
      phase,
      oldDigest: prior?.digest ?? null,
      newDigest: nextDigest,
      custody: call.custody(),
    });
  const commit = async (input: unknown): Promise<JournalCommitResult> => {
    const call = new Files(options);
    let phase = 'validation',
      nextDigest: string | null = null;
    try {
      insist(firstCause === null, firstCause ?? 'persistence-uncertain');
      const next = validateJournalSnapshot(input);
      insist(
        sameJournalBinding(next.binding, l.binding) &&
          recordedJSON(next.writer) === recordedJSON(writerIdentity),
        'sequence-gap'
      );
      if (prior) {
        const previous = prior.snapshot;
        if (previous.writer.epoch === writerIdentity.epoch) successor(previous, next);
        else {
          insist(
            previous.writer.epoch < Number.MAX_SAFE_INTEGER &&
              writerIdentity.epoch === previous.writer.epoch + 1,
            'sequence-gap'
          );
          // Handoff may change writer only; all retained identities/gaps/sequence rules still apply.
          successor(validateJournalSnapshot({ ...previous, writer: writerIdentity }), next);
        }
      } else insist(next.sequence === 0, 'sequence-gap');
      const bytes = Buffer.from(recordedJSON(next));
      nextDigest = sha(bytes);
      await markerCurrent(call);
      const current = await readSnapshot(l, root, call);
      insist(
        (current?.digest ?? null) === (prior?.digest ?? null) &&
          (!current || !prior || sameFile(current.identity, prior.identity)),
        'persistence-uncertain'
      );
      const temporary = join(rootPath(l), temporaryName);
      insist((await maybe(temporary)) === null, 'persistence-uncertain');
      phase = 'temporary';
      await call.point('payload-open');
      await markerCurrent(call);
      const d = await call.open(temporary, createFlags);
      const payloadPin = await withOriginalClose(
        call,
        d,
        async () => {
          await writeAll(d, bytes, call, 'payload-write');
          await call.point('payload-sync');
          await d.handle!.sync();
          const pin = identity(await d.handle!.stat({ bigint: true }));
          insist(
            pin.type === 'file' &&
              Number(pin.size) === bytes.length &&
              sameFile(pin, await named(temporary)),
            'persistence-uncertain'
          );
          return pin;
        },
        'payload-close'
      );
      await markerCurrent(call);
      insist(sameFile(payloadPin, await named(temporary)), 'persistence-uncertain');
      const destination = join(rootPath(l), 'snapshot.json'),
        namedPrior = await maybe(destination);
      insist(
        prior ? namedPrior && sameFile(namedPrior, prior.identity) : namedPrior === null,
        'persistence-uncertain'
      );
      phase = 'rename-pending';
      await call.point('snapshot-rename');
      await markerCurrent(call);
      // Check the destination again after fault seam/reentrancy, before replacement.
      const finalPrior = await maybe(destination);
      insist(
        prior ? finalPrior && sameFile(finalPrior, prior.identity) : finalPrior === null,
        'persistence-uncertain'
      );
      await fs.rename(temporary, destination);
      phase = 'renamed';
      await syncDirectory(rootPath(l), call, 'snapshot-directory-sync');
      await syncDirectory(l.parentDirectory, call, 'parent-sync');
      await markerCurrent(call);
      const read = await readSnapshot(l, root, call);
      insist(read && read.digest === nextDigest, 'persistence-uncertain');
      insist(await call.drain(), 'custody-pending');
      prior = read;
      return Object.freeze({
        state: 'durable-recorded',
        sequence: next.sequence,
        digest: nextDigest,
        custody: call.custody(),
      });
    } catch (error) {
      fail(error instanceof ProcessJournalError ? error.causeCode : 'persistence-uncertain');
      if (!(await call.drain())) {
        heldCalls.add(call);
        fail('custody-pending');
      }
      return uncertain(call, phase, nextDigest);
    }
  };
  const owner: ProcessJournalWriter = Object.freeze({
    commitSnapshot(input: unknown): Promise<JournalCommitResult> {
      if (!accepting || pending >= JOURNAL_LIMITS.pending) {
        if (pending >= JOURNAL_LIMITS.pending) fail('capacity-exceeded');
        return Promise.resolve(uncertain(new Files(), 'admission', null));
      }
      // Validate/copy before queueing: caller mutation cannot change an admitted request.
      let snapshot: JournalSnapshot;
      try {
        snapshot = validateJournalSnapshot(input);
      } catch (error) {
        fail(error instanceof ProcessJournalError ? error.causeCode : 'frame-invalid');
        return Promise.resolve(uncertain(new Files(), 'validation', null));
      }
      pending++;
      const operation = tail.then(() => commit(snapshot));
      tail = operation.then(
        () => {
          pending--;
        },
        () => {
          pending--;
          fail('persistence-uncertain');
        }
      );
      return operation;
    },
    handoff(nextWriter: JournalWriterIdentity): Promise<JournalHandoffResult> {
      if (handoffPromise) return handoffPromise;
      if (closePromise || !accepting)
        return Promise.resolve(
          Object.freeze({
            state: 'uncertain',
            cause: firstCause ?? 'custody-pending',
            custody: custody(),
          })
        );
      accepting = false;
      let proposedWriter: JournalWriterIdentity;
      try {
        proposedWriter = frozen(JournalWriterSchema.parse(copyJournalData(nextWriter)));
      } catch {
        fail('frame-invalid');
        handoffPromise = (async () => {
          await tail;
          await io.drain();
          return Object.freeze({
            state: 'uncertain' as const,
            cause: firstCause!,
            custody: custody(),
          });
        })();
        return handoffPromise;
      }
      handoffPromise = (async () => {
        await tail;
        const call = new Files(options);
        try {
          insist(firstCause === null, firstCause ?? 'persistence-uncertain');
          const next = proposedWriter;
          insist(
            writerIdentity.epoch < Number.MAX_SAFE_INTEGER &&
              next.epoch === writerIdentity.epoch + 1,
            'sequence-gap'
          );
          await markerCurrent(call);
          const bytes = Buffer.from(
            recordedJSON({
              schemaVersion: 1,
              binding: l.binding,
              writer: writerIdentity,
              phase: 'handoff',
              successor: next,
              sequence: prior?.snapshot.sequence ?? null,
              digest: prior?.digest ?? null,
            })
          );
          insist(bytes.length <= JOURNAL_LIMITS.writerBytes, 'capacity-exceeded');
          await call.point('handoff-write');
          await markerOriginal.handle!.truncate(0);
          await writeAll(markerOriginal, bytes, call, 'marker-write');
          await call.point('marker-sync');
          await markerOriginal.handle!.sync();
          markerPin = identity(await markerOriginal.handle!.stat({ bigint: true }));
          await syncDirectory(rootPath(l), call, 'namespace-sync');
          await markerCurrent(call);
          await io.close(markerOriginal, 'marker-close');
          insist(await io.drain(), 'custody-pending');
          insist(
            sameFile(markerPin, await named(join(rootPath(l), markerName))),
            'persistence-uncertain'
          );
          await call.point('marker-unlink');
          await assertRoot(l, root, call);
          insist(
            sameFile(markerPin, await named(join(rootPath(l), markerName))),
            'persistence-uncertain'
          );
          await fs.unlink(join(rootPath(l), markerName));
          await syncDirectory(rootPath(l), call, 'handoff-directory-sync');
          await syncDirectory(l.parentDirectory, call, 'parent-sync');
          insist((await maybe(join(rootPath(l), markerName))) === null, 'persistence-uncertain');
          insist(await call.drain(), 'custody-pending');
          const ticket: JournalSuccessorTicket = Object.freeze({ [ticketBrand]: true as const });
          tickets.set(ticket, { location: l, root, prior, writer: next, used: false });
          return Object.freeze({
            state: 'handed-off',
            ticket,
            sequence: prior?.snapshot.sequence ?? null,
            digest: prior?.digest ?? null,
            custody: custody(),
          });
        } catch (error) {
          fail(error instanceof ProcessJournalError ? error.causeCode : 'persistence-uncertain');
          if (!(await call.drain())) heldCalls.add(call);
          await io.drain();
          return Object.freeze({ state: 'uncertain', cause: firstCause!, custody: custody() });
        }
      })();
      return handoffPromise;
    },
    close(): Promise<JournalCloseResult> {
      if (closePromise) return closePromise;
      accepting = false;
      closePromise = (async () => {
        if (handoffPromise) await handoffPromise;
        else {
          await tail;
          try {
            await io.close(markerOriginal, 'marker-close');
          } catch {
            fail('custody-pending');
          }
          if (!(await io.drain())) fail('custody-pending');
        }
        // Ordinary close retains the marker. No parsed record can reopen this owner.
        return Object.freeze(
          firstCause
            ? { state: 'uncertain', cause: firstCause, custody: custody() }
            : { state: 'closed', custody: custody() }
        );
      })();
      return closePromise;
    },
  });
  return Object.freeze({ state: 'allocated', writer: owner, custody: io.custody() });
}
