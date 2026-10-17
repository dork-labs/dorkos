import { lstat, realpath, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { InstallationMutationPort, OwnedMutation } from './installation-mutations.js';
import { MutationRefusal, type TrustedTreeRoot } from './mutation-roots.js';

/** Host-derived relative target within one member of the complete authorized root set. */
export interface NamespaceTarget {
  readonly rootIndex: number;
  readonly relativePath: string;
}

/** Actual identities of existing components; absence belongs to the nearest existing parent. */
export interface NamespaceIdentity {
  readonly target: NamespaceTarget;
  readonly absolutePath: string;
  readonly components: readonly { readonly path: string; readonly physicalKey: string }[];
  readonly missing: readonly string[];
}

/** Required live rights and original sole-ledger census. Unknown/corrupt evidence must return blocked. */
export interface NamespaceAuthority {
  /** Refuse any filesystem admission or continuation inside an active SQLite transaction. */
  assertOutsideTransaction(): undefined;
  /** Refresh genuine current rights outside SQL; never synthesize a caller or approval. */
  prepare(owned: OwnedMutation): Promise<void>;
  /** Last synchronous current binding/owner/tree/room check; async returns are rejected. */
  requireCurrent(owned: OwnedMutation): undefined;
  /** Fresh INSTALLATION-wide unresolved census, not a root-only or cached count. */
  unresolved(): 'clear' | 'blocked';
}

/** Opaque callback capability; every effect/rollback step requires freshly inspected physical evidence. */
export interface OwnedNamespace {
  readonly initial: readonly NamespaceIdentity[];
  inspect(): Promise<readonly NamespaceIdentity[]>;
  step<T>(expected: readonly NamespaceIdentity[], effect: () => Promise<T>): Promise<T>;
}

function syncOutside(authority: NamespaceAuthority): void {
  const value: unknown = authority.assertOutsideTransaction();
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => {});
    throw new MutationRefusal('unresolved');
  }
}

function syncCurrent(authority: NamespaceAuthority, owned: OwnedMutation): void {
  syncOutside(authority);
  const value: unknown = authority.requireCurrent(owned);
  if (value !== undefined) {
    // Observe rejected promises without admitting an asynchronous authority check.
    void Promise.resolve(value).catch(() => {});
    throw new MutationRefusal('unresolved');
  }
}

function syncCensus(authority: NamespaceAuthority): void {
  const value: unknown = authority.unresolved();
  if (value !== 'clear') {
    if (value !== 'blocked') void Promise.resolve(value).catch(() => {});
    throw new MutationRefusal('unresolved');
  }
}

async function inspectTarget(
  owned: OwnedMutation,
  target: NamespaceTarget
): Promise<NamespaceIdentity> {
  const root = owned.roots[target.rootIndex];
  if (
    !root ||
    !Number.isSafeInteger(target.rootIndex) ||
    !target.relativePath ||
    path.isAbsolute(target.relativePath) ||
    target.relativePath.includes('\\') ||
    target.relativePath.includes('\0')
  )
    throw new MutationRefusal('invalid-path');
  const names = target.relativePath.split('/');
  if (names.some((name) => !name || name === '.' || name === '..'))
    throw new MutationRefusal('invalid-path');
  const components: Array<{ path: string; physicalKey: string }> = [];
  let current = root.canonicalPath;
  for (let index = 0; index < names.length; index++) {
    current = path.join(current, names[index]!);
    let info;
    try {
      info = await lstat(current, { bigint: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return Object.freeze({
          target,
          absolutePath: path.join(root.canonicalPath, ...names),
          components: Object.freeze(components),
          missing: Object.freeze(names.slice(index)),
        });
      throw error;
    }
    if (info.isSymbolicLink() || (index < names.length - 1 && !info.isDirectory()))
      throw new MutationRefusal('invalid-path');
    if ((await realpath(current)) !== current) throw new MutationRefusal('namespace-changed');
    components.push(Object.freeze({ path: current, physicalKey: `${info.dev}:${info.ino}` }));
  }
  return Object.freeze({
    target,
    absolutePath: current,
    components: Object.freeze(components),
    missing: Object.freeze([]),
  });
}

function sameNamespace(a: NamespaceIdentity, b: NamespaceIdentity): boolean {
  return (
    a.absolutePath === b.absolutePath &&
    a.missing.join('/') === b.missing.join('/') &&
    a.components.length === b.components.length &&
    a.components.every(
      (component, index) =>
        component.path === b.components[index]!.path &&
        component.physicalKey === b.components[index]!.physicalKey
    )
  );
}

/**
 * Private namespace protocol around ONE installation scheduler. External processes remain outside
 * this cooperative gate, so callers retain non-overwrite syscalls and their original version guards.
 * No default authority, inferred rights, durable ledger or root-only unresolved bypass exists here.
 */
export class ConfinedNamespace {
  constructor(
    private readonly mutations: InstallationMutationPort,
    private readonly authority: NamespaceAuthority
  ) {}

  /** Hold installation exclusion through actual child work, rollback, readback and publication. */
  withNamespace<T>(
    roots: readonly TrustedTreeRoot[],
    targets: readonly NamespaceTarget[],
    run: (namespace: OwnedNamespace) => Promise<T>
  ): Promise<T> {
    try {
      syncOutside(this.authority);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!targets.length || targets.length > 1024)
      return Promise.reject(new MutationRefusal('invalid-path'));
    const supplied = targets.map((target) => Object.freeze({ ...target }));
    return this.mutations.withMutation('opaque', roots, async (owned) => {
      const witnessed = new WeakSet<readonly NamespaceIdentity[]>();
      let active = true;
      let admitting = true;
      let stepping = false;
      const children = new Set<Promise<unknown>>();
      let failed = false;
      let firstError: unknown;
      const requireActive = () => {
        syncOutside(this.authority);
        owned.assertActive();
        if (!active) throw new MutationRefusal('inactive');
      };
      const inspectActual = async () => {
        requireActive();
        await owned.assertCurrentRoots();
        let rejected = false;
        let firstError: unknown;
        const results = await Promise.allSettled(
          supplied.map((target) =>
            inspectTarget(owned, target).catch((error: unknown) => {
              if (!rejected) {
                rejected = true;
                firstError = error;
              }
              throw error;
            })
          )
        );
        if (rejected) throw firstError;
        requireActive();
        await owned.assertCurrentRoots();
        const identities = Object.freeze(
          results.map((result) => {
            if (result.status === 'rejected') throw result.reason;
            return result.value;
          })
        );
        witnessed.add(identities);
        return identities;
      };
      const inspect = () => {
        requireActive();
        if (!admitting) throw new MutationRefusal('inactive');
        const inspection = inspectActual();
        children.add(inspection);
        void inspection.finally(() => children.delete(inspection)).catch(() => {});
        return inspection;
      };
      const guard = async () => {
        requireActive();
        await this.authority.prepare(owned);
        syncCensus(this.authority);
        requireActive();
        await owned.assertCurrentRoots();
        syncCurrent(this.authority, owned);
        syncCensus(this.authority);
      };
      await guard();
      const initial = await inspect();
      syncCurrent(this.authority, owned);
      const namespace: OwnedNamespace = Object.freeze({
        initial,
        inspect,
        step: <R>(expected: readonly NamespaceIdentity[], effect: () => Promise<R>) => {
          requireActive();
          if (!admitting) throw new MutationRefusal('inactive');
          if (stepping || !witnessed.has(expected))
            return Promise.reject(new MutationRefusal('reentrant'));
          stepping = true;
          const operation = (async () => {
            try {
              await guard();
              const fresh = await inspectActual();
              // Census is read again after filesystem awaits; immutable snapshot is never permission.
              syncCensus(this.authority);
              requireActive();
              await owned.assertCurrentRoots();
              if (!fresh.every((identity, index) => sameNamespace(identity, expected[index]!)))
                throw new MutationRefusal('namespace-changed');
              syncCurrent(this.authority, owned);
              syncCensus(this.authority);
              return await effect();
            } finally {
              stepping = false;
            }
          })();
          children.add(operation);
          void operation.finally(() => children.delete(operation)).catch(() => {});
          void operation.catch((error: unknown) => {
            if (!failed) {
              failed = true;
              firstError = error;
            }
          });
          return operation;
        },
      });
      try {
        const result = await run(namespace);
        admitting = false;
        await Promise.allSettled([...children]);
        if (failed) throw firstError;
        return result;
      } finally {
        admitting = false;
        await Promise.allSettled([...children]);
        active = false;
      }
    });
  }
}

/** Actual non-overwriting same-filesystem publication; an external destination is never replaced. */
export async function publishNamespaceCreate(temp: string, destination: string): Promise<void> {
  await link(temp, destination);
}

/** Remove only an actual object whose physical ownership evidence still matches. */
export async function removeOwnedNamespaceTemp(temp: string, physicalKey: string): Promise<void> {
  const current = await lstat(temp, { bigint: true });
  if (current.isSymbolicLink() || `${current.dev}:${current.ino}` !== physicalKey)
    throw new MutationRefusal('cleanup-ownership');
  await unlink(temp);
}
