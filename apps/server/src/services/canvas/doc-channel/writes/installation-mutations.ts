import { AsyncLocalStorage } from 'node:async_hooks';
import {
  MutationRefusal,
  sameMutationRoot,
  type TreeRootIdentity,
  type TreeRootProbe,
  type TrustedTreeRoot,
} from './mutation-roots.js';

/** Ordinary file participants share ownership; all opaque namespace/Git work is exclusive. */
export type InstallationMutationMode = 'files' | 'opaque';

/** Lifetime capability only. Complete room mutexes precede admission; no nested acquisition. */
export interface OwnedMutation {
  readonly mode: InstallationMutationMode;
  readonly roots: readonly TreeRootIdentity[];
  /** Recheck all roots after an await and immediately before an effect or rollback. */
  assertCurrentRoots(): Promise<void>;
  /** Refuse stale/disposed capability use even when no filesystem probe is necessary. */
  assertActive(): void;
}

/** Inject exactly one host instance. This gate supplies exclusion, never permissions. */
export interface InstallationMutationPort {
  withMutation<T>(
    mode: InstallationMutationMode,
    roots: readonly TrustedTreeRoot[],
    effect: (owned: OwnedMutation) => Promise<T>
  ): Promise<T>;
  stop(): Promise<void>;
}

interface Reservation {
  readonly mode: InstallationMutationMode;
  ready: boolean;
  grant(): void;
  reject(error: unknown): void;
}

interface InstallationOwner {
  withMutation<T>(
    mode: InstallationMutationMode,
    roots: readonly TrustedTreeRoot[],
    effect: (owned: OwnedMutation) => Promise<T>
  ): Promise<T>;
  stop(): Promise<void>;
}
const installationOwners = new WeakMap<object, InstallationOwner>();
/** Constructor/exclusion custody only; roots are not permission or document authority. */
export function requireInstallationMutations(value: unknown): InstallationMutations {
  if (!value || typeof value !== 'object' || !installationOwners.has(value))
    throw new MutationRefusal('inactive');
  return value as InstallationMutations;
}
/** Run through the recognized installation's captured mutation coordinator. */
export function withRecognizedInstallationMutation<T>(
  owner: InstallationMutations,
  mode: InstallationMutationMode,
  roots: readonly TrustedTreeRoot[],
  effect: (owned: OwnedMutation) => Promise<T>
): Promise<T> {
  requireInstallationMutations(owner);
  return installationOwners.get(owner)!.withMutation(mode, roots, effect);
}
/** Stop the recognized installation mutation coordinator. */
export function stopRecognizedInstallationMutations(owner: InstallationMutations): Promise<void> {
  requireInstallationMutations(owner);
  return installationOwners.get(owner)!.stop();
}

/**
 * Bounded FIFO installation scheduler. Reserve actual operations before probing; an unresolved
 * earlier request is a barrier. Contiguous files requests run together, opaque waits for all owners.
 * Retain ownership until effect, rollback, verification and publication have actually settled.
 * All callers must already own their complete room mutex set and must await their child work.
 */
export class InstallationMutations implements InstallationMutationPort {
  readonly #context = new AsyncLocalStorage<boolean>();
  readonly #queue: Reservation[] = [];
  readonly #owners = new Set<Reservation>();
  readonly #operations = new Set<Promise<unknown>>();
  #closing = false;
  #draining?: Promise<void>;

  readonly #probe: TreeRootProbe;
  constructor(probe: TreeRootProbe) {
    this.#probe = Object.freeze({ resolve: probe.resolve.bind(probe) });
    installationOwners.set(this, {
      withMutation: (mode, roots, effect) => this.#withMutation(mode, roots, effect),
      stop: () => this.#stop(),
    });
  }

  /** Reserve one complete operation before any IO; roots are evidence, not independent locks. */
  withMutation<T>(
    mode: InstallationMutationMode,
    roots: readonly TrustedTreeRoot[],
    effect: (owned: OwnedMutation) => Promise<T>
  ): Promise<T> {
    return this.#withMutation(mode, roots, effect);
  }

  #withMutation<T>(
    mode: InstallationMutationMode,
    roots: readonly TrustedTreeRoot[],
    effect: (owned: OwnedMutation) => Promise<T>
  ): Promise<T> {
    if (this.#context.getStore()) return Promise.reject(new MutationRefusal('reentrant'));
    if (this.#closing) return Promise.reject(new MutationRefusal('closing'));
    if (mode !== 'files' && mode !== 'opaque')
      return Promise.reject(new MutationRefusal('invalid-mode'));
    if (!Array.isArray(roots) || roots.length < 1 || roots.length > 16)
      return Promise.reject(new MutationRefusal('root-limit'));
    if (this.#operations.size >= 1024) return Promise.reject(new MutationRefusal('queue-limit'));
    const supplied = roots.map((root) => Object.freeze({ directory: root.directory }));
    let reservation!: Reservation;
    const granted = new Promise<void>((grant, reject) => {
      reservation = { mode, ready: false, grant, reject };
    });
    void granted.catch(() => {});
    this.#queue.push(reservation);
    // Probe invocation is a microtask: capacity and FIFO are registered before any injected code.
    const operation = this.#context.run(true, () =>
      Promise.resolve().then(() => this.#run(reservation, supplied, granted, effect))
    );
    this.#operations.add(operation);
    void operation.finally(() => this.#operations.delete(operation)).catch(() => {});
    return operation;
  }

  async #resolveAll(roots: readonly TrustedTreeRoot[]): Promise<TreeRootIdentity[]> {
    let failed = false;
    let firstError: unknown;
    const probes = roots.map((root) =>
      Promise.resolve()
        .then(() => this.#probe.resolve(root))
        .catch((error: unknown) => {
          if (!failed) {
            failed = true;
            firstError = error;
          }
          throw error;
        })
    );
    const results = await Promise.allSettled(probes);
    if (failed) throw firstError;
    return results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      const root = result.value;
      if (
        !root ||
        typeof root.canonicalPath !== 'string' ||
        !root.physicalKey ||
        !Array.isArray(root.ancestorPhysicalKeys)
      )
        throw new MutationRefusal('invalid-root');
      return Object.freeze({
        ...root,
        ancestorPhysicalKeys: Object.freeze([...root.ancestorPhysicalKeys]),
      });
    });
  }

  async #run<T>(
    reservation: Reservation,
    supplied: readonly TrustedTreeRoot[],
    granted: Promise<void>,
    effect: (owned: OwnedMutation) => Promise<T>
  ): Promise<T> {
    let active = false;
    const checks = new Set<Promise<void>>();
    let failed = false;
    let firstCause: unknown;
    let result: T | undefined;
    const fail = (error: unknown) => {
      if (!failed) {
        failed = true;
        firstCause = error;
      }
    };
    try {
      const original = await this.#resolveAll(supplied);
      if (this.#closing) throw new MutationRefusal('closing');
      reservation.ready = true;
      this.#dispatch();
      await granted;
      active = true;
      const assertActive = () => {
        if (!active) throw new MutationRefusal('inactive');
      };
      const assertCurrentRoots = () => {
        const check = (async () => {
          assertActive();
          const fresh = await this.#resolveAll(supplied);
          assertActive();
          if (!fresh.every((root, index) => sameMutationRoot(root, original[index]!)))
            throw new MutationRefusal('root-changed');
        })();
        checks.add(check);
        void check.finally(() => checks.delete(check)).catch(() => {});
        return check;
      };
      await assertCurrentRoots();
      const owned: OwnedMutation = Object.freeze({
        mode: reservation.mode,
        roots: Object.freeze(original),
        assertActive,
        assertCurrentRoots,
      });
      result = await effect(owned);
    } catch (error) {
      fail(error);
    } finally {
      active = false;
      for (const check of await Promise.allSettled([...checks]))
        if (check.status === 'rejected') fail(check.reason);
      try {
        const index = this.#queue.indexOf(reservation);
        if (index !== -1) this.#queue.splice(index, 1);
        this.#owners.delete(reservation);
      } catch (error) {
        fail(error);
      }
      try {
        this.#dispatch();
      } catch (error) {
        fail(error);
      }
    }
    if (failed) throw firstCause;
    return result as T;
  }

  #dispatch(): void {
    if (this.#closing || [...this.#owners].some((owner) => owner.mode === 'opaque')) return;
    while (this.#queue.length) {
      const next = this.#queue[0]!;
      if (!next.ready || (next.mode === 'opaque' && this.#owners.size > 0)) return;
      this.#queue.shift();
      this.#owners.add(next);
      next.grant();
      if (next.mode === 'opaque') return;
    }
  }

  /** Close synchronously and drain all launched probes and owned work before DB/filesystem disposal. */
  stop(): Promise<void> {
    return this.#stop();
  }

  #stop(): Promise<void> {
    if (this.#context.getStore()) return Promise.reject(new MutationRefusal('reentrant'));
    if (!this.#draining) {
      this.#closing = true;
      for (const pending of this.#queue.splice(0)) pending.reject(new MutationRefusal('closing'));
      this.#draining = Promise.allSettled([...this.#operations]).then(() => {});
    }
    return this.#draining;
  }
}
