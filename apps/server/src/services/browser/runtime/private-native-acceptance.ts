import { writeFileSync, renameSync, lstatSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { ProcessIdentity, ProcessObserver } from '@dorkos/browser';
import type { PrivateBrowserRetirementReceiver } from '@dorkos/browser/server-owner';
import type { BrowserBinding } from '@dorkos/shared/browser-schemas';

/** Constructor-only observation port. A projection grants no browser operation or native lease. */
export interface PrivateBrowserResourceOwner {
  onOriginalChild(
    receiver: PrivateBrowserRetirementReceiver,
    original: Readonly<{
      root: ProcessIdentity;
      supervisor: ProcessIdentity;
      manager: ProcessIdentity;
      identities: readonly ProcessIdentity[];
      complete: boolean;
    }>
  ): Promise<void>;
}
export type PrivateViewerSample = Readonly<{
  at: number;
  binding: BrowserBinding;
  viewerId: string;
  pendingFrames: number;
  pendingBytes: number;
  encodingMs: number | null;
  droppedFrames: number;
  closed: boolean;
}>;
export type PrivateViewerCensus = Readonly<{ at: number; subscriptions: number; closed: boolean }>;
export type PrivateViewerCensusObserver = (value: PrivateViewerCensus) => void;
export type PrivateViewerSampleObserver = ((sample: PrivateViewerSample) => void) & {
  /** Constructor-private exact browser bank binding; never supplied by an HTTP request. */
  census?: (
    scope: Readonly<{ browserId: string; browserGeneration: number }>
  ) => PrivateViewerCensusObserver;
};
type Role = Readonly<{
  kind: 'browser' | 'frontend';
  root: ProcessIdentity;
  identities: readonly ProcessIdentity[];
  binding?: Readonly<{ browserId: string; browserGeneration: number }>;
}>;
const same = (a: ProcessIdentity, b: ProcessIdentity) => a.pid === b.pid && a.birth === b.birth;
const immutable = (id: ProcessIdentity) => Object.freeze({ pid: id.pid, birth: id.birth });

/** Actual native observer + original constructor callbacks own every role; no caller PID selects one. */
export function createPrivateNativeAcceptance(
  options: Readonly<{
    manager: ProcessIdentity;
    processes: ProcessObserver;
    own<T>(original: Promise<T>): Promise<T>;
    current(): void;
    publishQueue?: (snapshot: Readonly<{ samples: readonly PrivateViewerSample[] }>) => void;
  }>
) {
  const manager = immutable(options.manager),
    processes = options.processes;
  const own = options.own.bind(options),
    current = options.current.bind(options);
  const publishQueue = options.publishQueue?.bind(options);
  const observe = processes.observe.bind(processes),
    descendants = processes.descendants.bind(processes);
  const births = new Map<PrivateBrowserRetirementReceiver, Role>();
  const originalKnown = new Map<string, ProcessIdentity>();
  const remember = (identities: readonly ProcessIdentity[]) => {
    for (const identity of identities) {
      const key = identity.pid + ':' + identity.birth;
      if (!originalKnown.has(key) && originalKnown.size >= 8192)
        throw new Error('PRIVATE_ACCEPTANCE_NATIVE_BIRTH_BOUND');
      originalKnown.set(key, immutable(identity));
    }
  };
  let frontend: Role | undefined, frontendChild: ChildProcess | undefined;
  const samples: PrivateViewerSample[] = [];
  let first: Readonly<{ value: unknown }> | undefined;
  const fail = (value: unknown) => {
    first ??= { value };
  };
  const guard = () => {
    if (first) throw first.value;
    current();
  };
  const tree = async (root: ProcessIdentity) => {
    try {
      guard();
      const result = await own(descendants(root, new AbortController().signal));
      remember(result.identities.slice(0, 512));
      guard();
      if (
        result.status !== 'complete' ||
        !result.identities.some((id) => same(id, root)) ||
        result.identities.length > 512 ||
        new Set(result.identities.map((id) => id.pid)).size !== result.identities.length
      )
        throw new Error('PRIVATE_ACCEPTANCE_COMPLETE_ORIGINAL_TREE_REQUIRED');
      for (const identity of result.identities) {
        const result = await own(observe(identity, new AbortController().signal));
        guard();
        if (result.status !== 'alive')
          throw new Error('PRIVATE_ACCEPTANCE_ORIGINAL_BIRTH_NOT_ALIVE');
      }
      return Object.freeze(result.identities.map(immutable));
    } catch (value) {
      fail(value);
      throw value;
    }
  };
  const role = async (
    kind: Role['kind'],
    root: ProcessIdentity,
    binding?: Role['binding']
  ): Promise<Role> => {
    try {
      const before = await tree(root),
        after = await tree(root);
      if (
        before.length !== after.length ||
        before.some((id) => !after.some((next) => same(id, next)))
      )
        throw new Error('PRIVATE_ACCEPTANCE_ROLE_COHORT_CHANGED');
      return Object.freeze({
        kind,
        root: immutable(root),
        identities: after,
        ...(binding ? { binding: Object.freeze({ ...binding }) } : {}),
      });
    } catch (value) {
      fail(value);
      throw value;
    }
  };
  const resources: PrivateBrowserResourceOwner = Object.freeze({
    onOriginalChild: (
      receiver: Parameters<PrivateBrowserResourceOwner['onOriginalChild']>[0],
      original: Parameters<PrivateBrowserResourceOwner['onOriginalChild']>[1]
    ) => {
      // Synchronously retain original root/cohort before currentness or incomplete observation can refuse.
      // These are the exact native launcher's constructor callback rows, never a preparation baseline.
      remember([original.root, original.supervisor]);
      remember(original.identities.slice(0, 512));
      const observed: Role = Object.freeze({
        kind: 'browser',
        root: immutable(original.root),
        identities: Object.freeze(original.identities.slice(0, 512).map(immutable)),
        binding: Object.freeze({
          browserId: receiver.browserId,
          browserGeneration: receiver.browserGeneration,
        }),
      });
      const replaced = births.has(receiver);
      if (!replaced) births.set(receiver, observed);
      void receiver.observation.then(() => births.delete(receiver), fail);
      return own(
        Promise.resolve().then(() => {
          try {
            guard();
            if (
              replaced ||
              births.size > 64 ||
              !same(original.manager, manager) ||
              !receiver.isOrdinary()
            )
              throw new Error('PRIVATE_ACCEPTANCE_ORIGINAL_BIRTH_REFUSED');
            if (
              !original.complete ||
              original.identities.length > 512 ||
              !original.identities.some((id) => same(id, original.root)) ||
              new Set(original.identities.map((id) => id.pid)).size !== original.identities.length
            )
              throw new Error('PRIVATE_ACCEPTANCE_COMPLETE_ORIGINAL_TREE_REQUIRED');
          } catch (value) {
            fail(value);
            throw value;
          }
        })
      );
    },
  });
  const viewerSamples: PrivateViewerSampleObserver = (sample) => {
    guard();
    if (samples.length >= 8192) {
      const value = new Error('PRIVATE_ACCEPTANCE_VIEWER_SAMPLE_BOUND');
      fail(value);
      throw value;
    }
    samples.push(
      Object.freeze({
        ...sample,
        binding: Object.freeze({ ...sample.binding }),
      })
    );
    try {
      publishQueue?.(Object.freeze({ samples: Object.freeze([...samples]) }));
    } catch (value) {
      fail(value);
      throw value;
    }
  };
  return Object.freeze({
    resources,
    viewerSamples,
    async captureFrontend(original: ChildProcess) {
      try {
        guard();
        if (
          frontendChild ||
          !original.pid ||
          original.exitCode !== null ||
          original.signalCode !== null
        )
          throw new Error('PRIVATE_ACCEPTANCE_ORIGINAL_FRONTEND_REQUIRED');
        frontendChild = original; // Retain exact returned original before any native query can fail.
        const known = await tree(manager),
          birth = known.find((identity) => identity.pid === original.pid);
        if (!birth) throw new Error('PRIVATE_ACCEPTANCE_FRONTEND_BIRTH_UNKNOWN');
        frontend = await role('frontend', birth);
        guard();
        if (
          original.pid !== birth.pid ||
          original.exitCode !== null ||
          original.signalCode !== null
        )
          throw new Error('PRIVATE_ACCEPTANCE_FRONTEND_RETURNED');
        return frontend;
      } catch (value) {
        fail(value);
        throw value;
      }
    },
    async roles(
      bindings: readonly Readonly<{
        browserId: string;
        browserGeneration: number;
      }>[]
    ) {
      try {
        guard();
        if (bindings.length !== 2 || !frontend)
          throw new Error('PRIVATE_ACCEPTANCE_TWO_BROWSERS_AND_FRONTEND_REQUIRED');
        const selected: Role[] = [];
        for (const binding of bindings) {
          const matches = [...births].filter(
            ([receiver]) =>
              receiver.browserId === binding.browserId &&
              receiver.browserGeneration === binding.browserGeneration &&
              receiver.isAuthorityCurrent()
          );
          if (matches.length !== 1)
            throw new Error('PRIVATE_ACCEPTANCE_EXACT_OPEN_RECEIPT_REQUIRED');
          const [receiver, captured] = matches[0]!;
          const live = await role('browser', captured.root, captured.binding);
          if (!receiver.isAuthorityCurrent())
            throw new Error('PRIVATE_ACCEPTANCE_ORIGINAL_BIRTH_REVOKED');
          selected.push(live);
        }
        selected.push(await role('frontend', frontend.root));
        const identities = selected.flatMap((value) => value.identities);
        if (new Set(identities.map((id) => id.pid)).size !== identities.length)
          throw new Error('PRIVATE_ACCEPTANCE_RESOURCE_ROLE_OVERLAP');
        guard();
        return Object.freeze(selected);
      } catch (value) {
        fail(value);
        throw value;
      }
    },
    queueSnapshot() {
      guard();
      return Object.freeze({ samples: Object.freeze([...samples]) });
    },
    originalFrontend: () => frontendChild,
    originalKnownBirths: () => Object.freeze([...originalKnown.values()]),
    assertCurrent: guard,
  });
}

/** Parent-owned fresh artifact sink. The held-viewer test reads atomic snapshots of actual bank events. */
export function createOriginalViewerFileSink(path: string) {
  if (!isAbsolute(path)) throw new Error('PRIVATE_ACCEPTANCE_QUEUE_PATH_REQUIRED');
  const parent = dirname(path),
    identity = lstatSync(parent, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || realpathSync(parent) !== parent)
    throw new Error('PRIVATE_ACCEPTANCE_QUEUE_PARENT_UNOWNED');
  writeFileSync(path, JSON.stringify({ samples: [] }), {
    flag: 'wx',
    mode: 0o600,
  });
  const current = () => {
    const actual = lstatSync(parent, { bigint: true });
    if (
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      actual.dev !== identity.dev ||
      actual.ino !== identity.ino
    )
      throw new Error('PRIVATE_ACCEPTANCE_QUEUE_PARENT_REPLACED');
  };
  return (snapshot: Readonly<{ samples: readonly PrivateViewerSample[] }>) => {
    current();
    if (snapshot.samples.length > 8192) throw new Error('PRIVATE_ACCEPTANCE_QUEUE_SAMPLE_BOUND');
    const bytes = JSON.stringify(snapshot);
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024)
      throw new Error('PRIVATE_ACCEPTANCE_QUEUE_BYTES_BOUND');
    const temporary = join(parent, 'original-viewer-' + randomUUID() + '.json');
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    current();
    renameSync(temporary, path);
    current();
  };
}
