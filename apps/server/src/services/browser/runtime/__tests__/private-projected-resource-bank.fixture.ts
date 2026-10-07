import type { ChildProcess } from 'node:child_process';
import type { ProcessIdentity, ProcessObserver } from '@dorkos/browser';
import type { OriginalNativeBirth } from '../private-native-projection.js';

/** Private measurements of original IPC projections + captured frontend child.
 * These rows confer no controller/grant/retirement authority. */
export function createOriginalProjectedResourceBank(options: {
  parent: ProcessIdentity;
  identity(pid: number): Promise<ProcessIdentity | null>;
  attributeRoot(parent: ProcessIdentity, child: ProcessIdentity): Promise<boolean>;
  cli: ChildProcess;
  processes: ProcessObserver;
  signal: AbortSignal;
  current(): void;
  own<T>(original: Promise<T>): Promise<T>;
}) {
  const identity = options.identity.bind(options),
    attributeRoot = options.attributeRoot.bind(options);
  const known = new Map<string, ProcessIdentity>();
  const births = new Map<string, OriginalNativeBirth>();
  const key = (id: ProcessIdentity) => id.pid + ':' + id.birth;
  const same = (a: ProcessIdentity, b: ProcessIdentity) => key(a) === key(b);
  const remember = (rows: readonly ProcessIdentity[]) => {
    for (const row of rows.slice(0, 512)) known.set(key(row), Object.freeze({ ...row }));
    if (known.size > 8192) throw new Error('PROJECTED_ORIGINAL_BIRTH_BOUND');
  };
  let first: { value: unknown } | undefined, manager: ProcessIdentity | undefined;
  let frontend:
    Readonly<{ root: ProcessIdentity; identities: readonly ProcessIdentity[] }> | undefined;
  const guard = () => {
    if (first) throw first.value;
    options.current();
    options.signal.throwIfAborted();
  };
  const tree = async (root: ProcessIdentity) => {
    try {
      guard();
      const before = await options.own(options.processes.descendants(root, options.signal));
      remember(before.identities);
      guard();
      if (
        before.status !== 'complete' ||
        before.identities.length > 512 ||
        !before.identities.some((id) => same(id, root))
      )
        throw new Error('PROJECTED_ORIGINAL_TREE_UNKNOWN');
      for (const row of before.identities) {
        const live = await options.own(options.processes.observe(row, options.signal));
        guard();
        if (live.status !== 'alive') throw new Error('PROJECTED_ORIGINAL_BIRTH_UNKNOWN');
      }
      const after = await options.own(options.processes.descendants(root, options.signal));
      remember(after.identities);
      guard();
      if (
        after.status !== 'complete' ||
        after.identities.length !== before.identities.length ||
        after.identities.some((id) => !before.identities.some((old) => same(old, id)))
      )
        throw new Error('PROJECTED_ORIGINAL_COHORT_CHANGED');
      return Object.freeze(after.identities.map((id) => Object.freeze({ ...id })));
    } catch (value) {
      first ??= { value };
      throw value;
    }
  };
  const protect = async <T>(job: () => Promise<T>): Promise<T> => {
    try {
      return await job();
    } catch (value) {
      first ??= { value };
      throw value;
    }
  };
  return Object.freeze({
    captureCli() {
      return protect(async () => {
        guard();
        const pid = options.cli.pid;
        if (manager || !pid || options.cli.exitCode !== null || options.cli.signalCode !== null)
          throw new Error('PROJECTED_ORIGINAL_CLI_BIRTH_UNKNOWN');
        const original = await options.own(identity(pid));
        if (original) remember([original]);
        guard();
        if (
          !original ||
          original.pid !== pid ||
          !(await options.own(attributeRoot(options.parent, original)))
        )
          throw new Error('PROJECTED_ORIGINAL_CLI_BIRTH_UNKNOWN');
        guard();
        if (
          options.cli.pid !== pid ||
          options.cli.exitCode !== null ||
          options.cli.signalCode !== null
        )
          throw new Error('PROJECTED_ORIGINAL_CLI_BIRTH_UNKNOWN');
        manager = Object.freeze({ ...original });
        return manager;
      });
    },
    async retainBirth(birth: OriginalNativeBirth) {
      remember([birth.root, birth.supervisor, birth.manager, ...birth.identities]);
      const id = birth.browserId + ':' + birth.browserGeneration;
      const duplicate = births.has(id);
      if (!duplicate) births.set(id, birth);
      try {
        guard();
        if (
          duplicate ||
          !manager ||
          !same(manager, birth.manager) ||
          birth.manager.pid !== options.cli.pid ||
          !birth.complete ||
          birth.identities.length > 512 ||
          !birth.identities.some((row) => same(row, birth.root)) ||
          new Set(birth.identities.map((row) => row.pid)).size !== birth.identities.length
        )
          throw new Error('PROJECTED_ORIGINAL_CLI_MANAGER_MISMATCH');
        // Exact constructor projection is retained before ACK; actual live tree checks belong to later roles().
      } catch (value) {
        first ??= { value };
        throw value;
      }
    },
    captureFrontend(child: ChildProcess) {
      return protect(async () => {
        guard();
        const pid = child.pid;
        if (frontend || !pid || child.exitCode !== null || child.signalCode !== null)
          throw new Error('PROJECTED_ORIGINAL_FRONTEND_BIRTH_UNKNOWN');
        const root = await options.own(identity(pid));
        if (root) remember([root]);
        guard();
        if (!root || root.pid !== pid || !(await options.own(attributeRoot(options.parent, root))))
          throw new Error('PROJECTED_ORIGINAL_FRONTEND_BIRTH_UNKNOWN');
        guard();
        if (child.pid !== pid || child.exitCode !== null || child.signalCode !== null)
          throw new Error('PROJECTED_ORIGINAL_FRONTEND_BIRTH_UNKNOWN');
        frontend = Object.freeze({
          root: Object.freeze({ ...root }),
          identities: Object.freeze([Object.freeze({ ...root })]),
        });
      });
    },
    roles(bindings: readonly Readonly<{ browserId: string; browserGeneration: number }>[]) {
      return protect(async () => {
        guard();
        if (bindings.length !== 2 || !manager || !frontend)
          throw new Error('PROJECTED_ORIGINAL_ROLES_REQUIRED');
        if (options.cli.exitCode !== null || options.cli.signalCode !== null)
          throw new Error('PROJECTED_ORIGINAL_CLI_RETURNED');
        const live = await options.own(options.processes.observe(manager, options.signal));
        if (live.status !== 'alive') throw new Error('PROJECTED_ORIGINAL_CLI_RETURNED');
        const roles = [];
        for (const binding of bindings) {
          const original = births.get(binding.browserId + ':' + binding.browserGeneration);
          if (!original) throw new Error('PROJECTED_ORIGINAL_OPEN_RECEIPT_UNKNOWN');
          roles.push(
            Object.freeze({
              kind: 'browser' as const,
              root: original.root,
              identities: await tree(original.root),
              binding: Object.freeze({ ...binding }),
            })
          );
        }
        roles.push(
          Object.freeze({
            kind: 'frontend' as const,
            root: frontend.root,
            identities: await tree(frontend.root),
          })
        );
        if (
          new Set(roles.flatMap((role) => role.identities).map((id) => id.pid)).size !==
          roles.reduce((n, role) => n + role.identities.length, 0)
        )
          throw new Error('PROJECTED_ORIGINAL_ROLE_OVERLAP');
        guard();
        return Object.freeze(roles);
      });
    },
    resourceNodeIdentities(
      bindings: readonly Readonly<{ browserId: string; browserGeneration: number }>[]
    ) {
      guard();
      if (!manager || bindings.length !== 2 || new Set(bindings.map((b) => b.browserId)).size !== 2)
        throw new Error('PROJECTED_ORIGINAL_NODE_ROLES_REQUIRED');
      const rows = [manager];
      for (const binding of bindings) {
        const original = births.get(binding.browserId + ':' + binding.browserGeneration);
        if (!original || !same(manager, original.manager))
          throw new Error('PROJECTED_ORIGINAL_NODE_ROLES_REQUIRED');
        rows.push(original.supervisor);
      }
      if (new Set(rows.map((row) => row.pid)).size !== 3)
        throw new Error('PROJECTED_ORIGINAL_NODE_ROLE_OVERLAP');
      return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
    },
    originalKnownBirths: () => Object.freeze([...known.values()]),
    assertCurrent: guard,
  });
}
