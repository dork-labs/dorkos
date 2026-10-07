import { AsyncLocalStorage } from 'node:async_hooks';

/** Identity of an existing regular file, resolved by confined server filesystem authority. */
export interface CanonicalFileIdentity {
  canonicalPath: string;
  device: string;
  inode: string;
}

export interface CanonicalWriterPorts {
  resolve(path: string): Promise<CanonicalFileIdentity>;
  /** Must throw when filesystem work would run inside a SQLite transaction. */
  assertOutsideTransaction(): void;
}

/** Replacing writers must reserve the fresh inode before exposing it through rename. */
export interface CanonicalWriteLease {
  reserveReplacement(path: string): Promise<CanonicalFileIdentity>;
}

const originalCanonicalLeases = new WeakMap<
  CanonicalWriteLease,
  {
    coordinator: CanonicalFileWriteCoordinator;
    active: () => boolean;
    owned: Set<string>;
  }
>();
/** Lookup only. No caller can issue an active coordinator lease by copying its methods. */
export function requireOriginalCanonicalWriteLease(
  coordinator: CanonicalFileWriteCoordinator,
  lease: CanonicalWriteLease,
  identity: CanonicalFileIdentity
): void {
  const own = originalCanonicalLeases.get(lease);
  if (
    !own ||
    own.coordinator !== coordinator ||
    !own.active() ||
    !own.owned.has(`path:${identity.canonicalPath}`) ||
    !own.owned.has(`inode:${identityKey(identity)}`)
  )
    throw new Error('Original canonical writer custody is unavailable.');
}

/** The queued identity changed before the write callback could perform any effect. */
export class CanonicalFileIdentityChangedError extends Error {
  constructor() {
    super('Canonical file identity changed while waiting');
    this.name = 'CanonicalFileIdentityChangedError';
  }
}

interface CanonicalOwner {
  withFiles<T>(
    paths: readonly string[],
    write: (identities: readonly CanonicalFileIdentity[], lease: CanonicalWriteLease) => Promise<T>
  ): Promise<T>;
  stop(): Promise<void>;
}
const canonicalOwners = new WeakMap<object, CanonicalOwner>();
/** Constructor/exclusion custody only; no database or document authority. */
export function requireCanonicalFileWriteCoordinator(
  value: unknown
): CanonicalFileWriteCoordinator {
  if (!value || typeof value !== 'object' || !canonicalOwners.has(value))
    throw new Error('Unknown canonical file writer.');
  return value as CanonicalFileWriteCoordinator;
}
/** Run against the recognized canonical file writer's original operations. */
export function withRecognizedCanonicalFiles<T>(
  owner: CanonicalFileWriteCoordinator,
  paths: readonly string[],
  write: (identities: readonly CanonicalFileIdentity[], lease: CanonicalWriteLease) => Promise<T>
): Promise<T> {
  requireCanonicalFileWriteCoordinator(owner);
  return canonicalOwners.get(owner)!.withFiles(paths, write);
}
/** Stop the recognized canonical file writer through its captured lifetime. */
export function stopRecognizedCanonicalWriter(owner: CanonicalFileWriteCoordinator): Promise<void> {
  requireCanonicalFileWriteCoordinator(owner);
  return canonicalOwners.get(owner)!.stop();
}

/** Serialize cooperative writes, including hard-link aliases, in a single server process. */
export class CanonicalFileWriteCoordinator {
  readonly #tails = new Map<string, Promise<void>>();
  #queued = 0;
  #closed = false;
  readonly #operations = new Set<Promise<unknown>>();
  #resolutionTail = Promise.resolve();
  readonly #context = new AsyncLocalStorage<boolean>();

  readonly #ports: CanonicalWriterPorts;
  constructor(ports: CanonicalWriterPorts) {
    this.#ports = Object.freeze({
      resolve: ports.resolve.bind(ports),
      assertOutsideTransaction: ports.assertOutsideTransaction.bind(ports),
    });
    canonicalOwners.set(this, {
      withFiles: (paths, write) => this.#withFiles(paths, write),
      stop: () => this.#stop(),
    });
  }

  withFiles<T>(
    paths: readonly string[],
    write: (identities: readonly CanonicalFileIdentity[], lease: CanonicalWriteLease) => Promise<T>
  ): Promise<T> {
    return this.#withFiles(paths, write);
  }

  async #withFiles<T>(
    paths: readonly string[],
    write: (identities: readonly CanonicalFileIdentity[], lease: CanonicalWriteLease) => Promise<T>
  ): Promise<T> {
    this.#ports.assertOutsideTransaction();
    if (this.#context.getStore()) throw new Error('Recursive canonical write acquisition');
    this.#requireOpen();
    if (paths.length === 0 || paths.length > 16)
      throw new Error('Invalid canonical write key count');
    if (this.#queued >= 1024) throw new Error('Canonical write queue is full');
    this.#queued++;
    const operation = this.#acquire([...paths], write);
    this.#operations.add(operation);
    try {
      return await operation;
    } finally {
      this.#operations.delete(operation);
      this.#queued--;
    }
  }

  /** Close admission and drain admitted operations before their shared resources are disposed. */
  stop(): Promise<void> {
    return this.#stop();
  }

  async #stop(): Promise<void> {
    if (this.#context.getStore()) throw new Error('Recursive canonical writer stop');
    this.#closed = true;
    await Promise.allSettled([...this.#operations]);
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error('Canonical writer admission is closed');
  }

  async #resolveAll(paths: readonly string[]): Promise<CanonicalFileIdentity[]> {
    let failed = false;
    let firstError: unknown;
    // Scheduling each call also converts synchronous port throws without skipping later probes.
    const probes = paths.map((path) =>
      Promise.resolve()
        .then(() => this.#ports.resolve(path))
        .catch((error: unknown) => {
          if (!failed) {
            failed = true;
            firstError = error;
          }
          throw error;
        })
    );
    const settled = await Promise.allSettled(probes);
    if (failed) throw firstError;
    return settled.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
  }

  async #acquire<T>(
    paths: readonly string[],
    write: (identities: readonly CanonicalFileIdentity[], lease: CanonicalWriteLease) => Promise<T>
  ): Promise<T> {
    // Preserve arrival order even when alias realpath/stat calls finish out of order.
    const previousResolution = this.#resolutionTail;
    let releaseResolution!: () => void;
    this.#resolutionTail = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    let before: CanonicalFileIdentity[];
    try {
      await previousResolution;
      this.#requireOpen();
      before = await this.#resolveAll(paths);
      this.#requireOpen();
      this.#ports.assertOutsideTransaction();
    } finally {
      releaseResolution();
    }
    // Rename changes the inode before verification/intent completion. Retain
    // pathname ownership as well as inode ownership throughout that interval.
    const keys = [
      ...new Set(
        before.flatMap((identity) => [
          `inode:${identityKey(identity)}`,
          `path:${identity.canonicalPath}`,
        ])
      ),
    ].sort();
    const releases: Array<() => void> = [];
    const owned = new Set(keys);
    const blockers: Promise<void>[] = [];
    let active = true;
    let reservations = 0;
    const requireActive = () => {
      this.#ports.assertOutsideTransaction();
      if (!active) throw new Error('Canonical write lease is no longer active');
    };
    const reserveKey = (key: string) => {
      const previous = this.#tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => held);
      this.#tails.set(key, tail);
      releases.push(() => {
        release();
        if (this.#tails.get(key) === tail) this.#tails.delete(key);
      });
      return previous;
    };
    const lease: CanonicalWriteLease = Object.freeze({
      reserveReplacement: async (path: string) => {
        requireActive();
        if (++reservations > 16)
          throw new Error('Canonical replacement reservation limit exceeded');
        const identity = await this.#ports.resolve(path);
        requireActive();
        const key = `inode:${identityKey(identity)}`;
        if (!owned.has(key)) {
          // Never wait out of order while holding other keys: refuse before rename.
          if (this.#tails.has(key)) throw new Error('Replacement inode is already held or queued');
          reserveKey(key);
          owned.add(key);
        }
        return identity;
      },
    });
    originalCanonicalLeases.set(lease, { coordinator: this, active: () => active, owned });
    let failed = false;
    let firstCause: unknown;
    let result: T | undefined;
    try {
      // Publish the full request before awaiting any key, preserving overlapping arrival FIFO.
      for (const key of keys) blockers.push(reserveKey(key));
      await Promise.all(blockers);
      this.#ports.assertOutsideTransaction();
      this.#requireOpen();
      const current = await this.#resolveAll(paths);
      this.#requireOpen();
      this.#ports.assertOutsideTransaction();
      if (
        current.some(
          (identity, index) =>
            identityKey(identity) !== identityKey(before[index]!) ||
            identity.canonicalPath !== before[index]!.canonicalPath
        )
      )
        throw new CanonicalFileIdentityChangedError();
      this.#ports.assertOutsideTransaction();
      result = await this.#context.run(true, () => write(current, lease));
    } catch (error) {
      failed = true;
      firstCause = error;
    } finally {
      active = false;
      originalCanonicalLeases.delete(lease);
      for (const release of releases.reverse()) {
        try {
          release();
        } catch (error) {
          if (!failed) {
            failed = true;
            firstCause = error;
          }
        }
      }
    }
    if (failed) throw firstCause;
    return result as T;
  }
}

function identityKey(identity: CanonicalFileIdentity): string {
  if (!identity.canonicalPath || !identity.device || !identity.inode) {
    throw new Error('Incomplete canonical file identity');
  }
  return JSON.stringify([identity.device, identity.inode]);
}
