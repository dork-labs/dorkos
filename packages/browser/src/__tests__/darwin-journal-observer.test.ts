import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { observeDarwinJournal } from '../runtime/darwin-journal-observer.js';
import { darwinBirth, type DarwinProcessObserver } from '../runtime/darwin-process-observer.js';
import {
  observeJournalDirectory,
  readJournal,
  type JournalSnapshot,
} from '../lifecycle/process-journal.js';

/** Synthetic syscall-contract frames exercise the real durable producer; no native qualification. */
async function fixture() {
  const parentDirectory = await realpath(
    await mkdtemp(join(tmpdir(), 'journal-parent-transition-'))
  );
  const managerNative = { pid: 10, seconds: '100', microseconds: '0' };
  const rootNative = { pid: 20, seconds: '200', microseconds: '0' };
  const childNative = { pid: 30, seconds: '300', microseconds: '0' };
  const manager = darwinBirth(managerNative),
    root = darwinBirth(rootNative);
  const window = {
    startSequence: 0,
    checkpointSequence: 0,
    endSequence: 0,
    startMonotonic: 10,
    endMonotonic: 10,
  };
  const binding = {
    journalId: 'parent-transition',
    browserId: 'browser',
    browserGeneration: 0,
    reservationNonce: 'nonce',
    runtimeIdentityDigest: 'a'.repeat(64),
    profile: { kind: 'ephemeral' as const },
    manager,
    bootScope: {
      kind: 'observed' as const,
      value: 'darwin-boot:1:0',
      sourceIdentityDigest: 'b'.repeat(64),
    },
  };
  const location = {
    parentDirectory,
    parentIdentity: await observeJournalDirectory(parentDirectory),
    binding,
  };
  const initial: JournalSnapshot = {
    schemaVersion: 1,
    kind: 'browser-process-journal',
    provenance: 'recorded-data',
    binding,
    writer: { writerId: 'observer', epoch: 0, kind: 'observer' },
    sequence: 0,
    phase: 'allocated',
    observationWindow: window,
    root: { kind: 'pending' },
    retainedIdentities: [
      {
        identity: manager,
        role: 'manager',
        parent: null,
        association: null,
        currentParent: null,
        acquisitionEpoch: 0,
        firstSeenSequence: 0,
        lastSeenSequence: 0,
        relationWindow: window,
        lifecycle: 'alive',
      },
    ],
    gaps: [],
    firstCause: null,
  };
  return {
    parentDirectory,
    managerNative,
    rootNative,
    childNative,
    manager,
    root,
    location,
    initial,
  };
}

it('preserves an admitted root association when the old manager dies during its child snapshot', async () => {
  const f = await fixture();
  let round = 0,
    managerDied = false,
    clock = 10;
  const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
  const checkpoints: JournalSnapshot[] = [];
  const observer: DarwinProcessObserver = {
    async inspect(pids) {
      return {
        ...boot,
        processes: pids.map((pid) => {
          if (round >= 3 || (pid === 10 && managerDied)) return { kind: 'absent' as const, pid };
          const identity = pid === 10 ? f.managerNative : pid === 20 ? f.rootNative : f.childNative;
          return {
            kind: 'present' as const,
            identity,
            parentPid: pid === 10 ? 1 : pid === 20 ? (managerDied ? 1 : 10) : 20,
            zombie: false,
          };
        }),
      };
    },
    async children(parent) {
      const identity = parent.pid === 20 ? f.rootNative : f.childNative;
      // Death occurs strictly between the before/after observations of the SAME root lifetime.
      // Its own parent changes; the known root->child relation remains exact.
      if (parent.pid === 20 && round === 1) managerDied = true;
      return {
        ...boot,
        parentBefore: identity,
        parentAfter: { ...identity },
        complete: true,
        processes:
          parent.pid === 20
            ? [{ kind: 'present' as const, identity: f.childNative, parentPid: 20, zombie: false }]
            : [],
      };
    },
  };
  try {
    expect(
      await observeDarwinJournal({
        location: f.location,
        initial: f.initial,
        root: f.root,
        observer,
        monotonicNow: () => clock++,
        pause: async () => {
          const read = await readJournal(f.location);
          if (read.state === 'valid-recorded-data') checkpoints.push(read.snapshot);
          round++;
        },
        endMonotonic: 1000,
        maxGap: 100,
      })
    ).toBe('recorded-gone');
    const before = checkpoints[0],
      after = checkpoints.find((snapshot) => snapshot.phase === 'manager-lost');
    expect(before.root.kind).toBe('attributed');
    expect(after).toBeDefined();
    expect(after!.root).toEqual(before.root);
    expect(after!.retainedIdentities.find((value) => value.role === 'root')?.association).toEqual(
      before.retainedIdentities.find((value) => value.role === 'root')?.association
    );
    expect(after!.retainedIdentities.find((value) => value.role === 'root')?.lifecycle).toBe(
      'alive'
    );
    expect(after!.gaps).toEqual([]);
    const final = await readJournal(f.location);
    expect(final.state).toBe('valid-recorded-data');
    if (final.state === 'valid-recorded-data') {
      expect(final.snapshot.gaps).toEqual([]);
      expect(final.snapshot.retainedIdentities.map((value) => value.lifecycle)).toEqual([
        'dead',
        'dead',
        'dead',
      ]);
    }
  } finally {
    await rm(f.parentDirectory, { recursive: true, force: true });
  }
});

it('refuses new root attribution if its old parent dies between the initial native observations', async () => {
  const f = await fixture();
  let clock = 10,
    selected = false;
  const observer: DarwinProcessObserver = {
    async inspect(pids) {
      return {
        version: 1,
        bootSeconds: '1',
        bootMicroseconds: '0',
        processes: pids.map((pid) => {
          if (pid === 20) {
            selected = true;
            return {
              kind: 'present' as const,
              identity: f.rootNative,
              parentPid: 10,
              zombie: false,
            };
          }
          return selected
            ? { kind: 'absent' as const, pid }
            : { kind: 'present' as const, identity: f.managerNative, parentPid: 1, zombie: false };
        }),
      };
    },
    async children() {
      throw new Error('new root cannot enter descendant discovery');
    },
  };
  try {
    expect(
      await observeDarwinJournal({
        location: f.location,
        initial: f.initial,
        root: f.root,
        observer,
        monotonicNow: () => clock++,
        pause: async () => {},
        endMonotonic: 1000,
        maxGap: 100,
      })
    ).toBe('retained');
    const read = await readJournal(f.location);
    expect(read.state).toBe('valid-recorded-data');
    if (read.state === 'valid-recorded-data') {
      expect(read.snapshot.root.kind).toBe('pending');
      expect(read.snapshot.gaps.some((value) => value.cause === 'association-missing')).toBe(true);
    }
  } finally {
    await rm(f.parentDirectory, { recursive: true, force: true });
  }
});

it('retains a genuine-shaped discovery gap while tracking admitted originals to natural absence', async () => {
  const f = await fixture();
  let round = 0,
    clock = 10,
    childrenCalls = 0;
  const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
  const refusals: unknown[] = [];
  const checkpoints: JournalSnapshot[] = [];
  const observer: DarwinProcessObserver = {
    async inspect(pids) {
      return {
        ...boot,
        processes: pids.map((pid) => {
          if (round >= 4 || (round >= 2 && pid === 10)) return { kind: 'absent' as const, pid };
          return {
            kind: 'present' as const,
            identity: pid === 10 ? f.managerNative : pid === 20 ? f.rootNative : f.childNative,
            parentPid: pid === 10 ? 1 : pid === 20 ? (round >= 2 ? 1 : 10) : 20,
            zombie: false,
          };
        }),
      };
    },
    async children(parent) {
      childrenCalls++;
      const identity = parent.pid === 20 ? f.rootNative : f.childNative;
      return {
        ...boot,
        parentBefore: identity,
        parentAfter: identity,
        complete: round !== 2,
        processes:
          parent.pid === 20 && round === 1
            ? [{ kind: 'present' as const, identity: f.childNative, parentPid: 20, zombie: false }]
            : [],
      };
    },
  };
  try {
    expect(
      await observeDarwinJournal({
        location: f.location,
        initial: f.initial,
        root: f.root,
        observer,
        monotonicNow: () => clock++,
        endMonotonic: 1000,
        maxGap: 100,
        onIncompleteChildren: async (parent, batch) => {
          refusals.push({ parent, batch });
        },
        pause: async () => {
          const read = await readJournal(f.location);
          if (read.state === 'valid-recorded-data') checkpoints.push(read.snapshot);
          round++;
        },
      })
    ).toBe('retained');
    expect(refusals).toHaveLength(1);
    expect(childrenCalls).toBe(2); // Initial root discovery, then the exact incomplete root sweep.
    const gappedAlive = checkpoints.find((snapshot) => snapshot.gaps.length);
    expect(gappedAlive?.retainedIdentities[1].lifecycle).toBe('alive');
    const final = await readJournal(f.location);
    expect(final.state).toBe('valid-recorded-data');
    if (final.state === 'valid-recorded-data') {
      expect(final.snapshot.phase).toBe('retained');
      expect(final.snapshot.retainedIdentities.map((value) => value.lifecycle)).toEqual([
        'dead',
        'dead',
        'dead',
      ]);
      expect(final.snapshot.root).toEqual(checkpoints[0].root);
      expect(final.snapshot.gaps).toHaveLength(1);
      expect(final.snapshot.gaps[0].cause).toBe('association-missing');
      expect(final.snapshot.gaps[0].identity).toEqual(f.root);
      expect(final.snapshot.firstCause?.cause).toBe('association-missing');
    }
  } finally {
    await rm(f.parentDirectory, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'records the selected controller-supervisor-root chain and refuses a replaced supervisor (%s)',
  async (replaced) => {
    const f = await fixture();
    let round = 0,
      clock = 10;
    const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
    const supervisor = f.root;
    const root = darwinBirth(f.childNative);
    const observer: DarwinProcessObserver = {
      async inspect(pids) {
        return {
          ...boot,
          processes: pids.map((pid) => {
            if (round >= 4) return { kind: 'absent' as const, pid };
            const identity =
              pid === 10
                ? f.managerNative
                : pid === 20
                  ? { ...f.rootNative, ...(replaced ? { seconds: '201' } : {}) }
                  : f.childNative;
            return {
              kind: 'present' as const,
              identity,
              parentPid: pid === 10 ? 1 : pid === 20 ? 10 : 20,
              zombie: false,
            };
          }),
        };
      },
      async children(parent) {
        const identity = parent.pid === 20 ? f.rootNative : f.childNative;
        return {
          ...boot,
          parentBefore: identity,
          parentAfter: { ...identity },
          complete: true,
          processes:
            parent.pid === 20
              ? [
                  {
                    kind: 'present' as const,
                    identity: f.childNative,
                    parentPid: 20,
                    zombie: false,
                  },
                ]
              : [],
        };
      },
    };
    try {
      const result = await observeDarwinJournal({
        location: f.location,
        initial: f.initial,
        root,
        rootSupervisor: () => supervisor,
        observer,
        monotonicNow: () => clock++,
        pause: async () => {
          round++;
        },
        endMonotonic: 100,
        maxGap: 100,
      });
      const read = await readJournal(f.location);
      expect(read.state).toBe('valid-recorded-data');
      if (read.state !== 'valid-recorded-data') throw new Error('NO_DURABLE_IDENTITY');
      if (replaced) {
        expect(result).not.toBe('recorded-gone');
        expect(read.snapshot.gaps.some((gap) => gap.cause === 'association-missing')).toBe(true);
        expect(read.snapshot.root.kind).toBe('pending');
      } else {
        expect(result).toBe('recorded-gone');
        expect(read.snapshot.gaps).toEqual([]);
        const retainedSupervisor = read.snapshot.retainedIdentities.find(
          (value) => value.identity.pid === 20
        );
        const retainedRoot = read.snapshot.retainedIdentities.find(
          (value) => value.role === 'root'
        );
        expect(retainedSupervisor?.parent).toEqual(f.manager);
        expect(retainedRoot?.identity).toEqual(root);
        expect(retainedRoot?.parent).toEqual(supervisor);
      }
    } finally {
      await rm(f.parentDirectory, { recursive: true, force: true });
    }
  }
);

it.each([false, true])(
  'keeps admitted same-birth supervised zombies pending until disappearance (%s)',
  async (remains) => {
    const f = await fixture();
    let round = 0,
      clock = 10;
    const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
    const observer: DarwinProcessObserver = {
      async inspect(pids) {
        return {
          ...boot,
          processes: pids.map((pid) => {
            if (pid !== 10 && round >= 4 && !remains) return { kind: 'absent' as const, pid };
            const identity =
              pid === 10 ? f.managerNative : pid === 20 ? f.rootNative : f.childNative;
            return {
              kind: 'present' as const,
              identity,
              parentPid: pid === 10 ? 1 : pid === 20 ? 10 : 20,
              zombie: pid === 30 && round >= 2,
            };
          }),
        };
      },
      async children(parent) {
        const identity = parent.pid === 20 ? f.rootNative : f.childNative;
        return {
          ...boot,
          parentBefore: identity,
          parentAfter: { ...identity },
          complete: true,
          processes:
            parent.pid === 20
              ? [
                  {
                    kind: 'present' as const,
                    identity: f.childNative,
                    parentPid: 20,
                    zombie: round >= 2,
                  },
                ]
              : [],
        };
      },
    };
    try {
      const result = await observeDarwinJournal({
        location: f.location,
        initial: f.initial,
        root: darwinBirth(f.childNative),
        rootSupervisor: () => f.root,
        observer,
        endBrowser: () => true,
        monotonicNow: () => clock++,
        pause: async () => {
          round++;
        },
        endMonotonic: 100,
        maxGap: 100,
      });
      expect(result).toBe(remains ? 'retained' : 'campaign-closed-gapped');
      const read = await readJournal(f.location);
      expect(read.state).toBe('valid-recorded-data');
      if (read.state === 'valid-recorded-data')
        expect(
          read.snapshot.retainedIdentities.find((value) => value.role === 'root')?.lifecycle
        ).toBe(remains ? 'alive' : 'dead');
    } finally {
      await rm(f.parentDirectory, { recursive: true, force: true });
    }
  }
);

it.each([false, true])(
  'keeps finite duration unchanged; continuous original campaign=%s crosses 30 seconds',
  async (continuous) => {
    const f = await fixture();
    let round = 0,
      clock = 10;
    const checkpoints: JournalSnapshot[] = [];
    const published: number[] = [];
    const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
    const observer: DarwinProcessObserver = {
      async inspect(pids) {
        return {
          ...boot,
          processes: pids.map((pid) =>
            round >= 35
              ? { kind: 'absent' as const, pid }
              : {
                  kind: 'present' as const,
                  identity: pid === 10 ? f.managerNative : f.rootNative,
                  parentPid: pid === 10 ? 1 : 10,
                  zombie: false,
                }
          ),
        };
      },
      async children(parent) {
        const identity = parent.pid === 10 ? f.managerNative : f.rootNative;
        return {
          ...boot,
          parentBefore: identity,
          parentAfter: { ...identity },
          complete: true,
          processes: [],
        };
      },
    };
    try {
      const result = await observeDarwinJournal({
        location: f.location,
        initial: f.initial,
        root: f.root,
        observer,
        monotonicNow: () => clock++,
        pause: async () => {
          const read = await readJournal(f.location);
          if (read.state === 'valid-recorded-data') checkpoints.push(read.snapshot);
          round++;
          clock += 1000;
        },
        endMonotonic: 30010,
        maxGap: 5000,
        ...(continuous ? { continuousWindowMilliseconds: 30000 } : {}),
        onCheckpoint: async (checkpoint) => {
          const read = await readJournal(f.location);
          expect(read.state).toBe('valid-recorded-data');
          if (read.state !== 'valid-recorded-data') throw new Error('durable checkpoint missing');
          expect(read.snapshot.sequence).toBe(checkpoint.sequence);
          expect(read.snapshot.observationWindow.endMonotonic).toBe(checkpoint.monotonic);
          expect(read.snapshot.root).toMatchObject({
            kind: 'attributed',
            identity: checkpoint.root,
          });
          expect(checkpoint.root).toEqual(f.root);
          expect(read.snapshot.gaps).toHaveLength(0);
          expect(checkpoint.sequence).toBeGreaterThan(published.at(-1) ?? 0);
          published.push(checkpoint.sequence);
        },
      });
      expect(result).toBe(continuous ? 'recorded-gone' : 'retained');
      expect(published.length > 0).toBe(continuous);
      if (continuous) {
        expect(
          checkpoints.some((snapshot) => snapshot.observationWindow.endMonotonic > 30010)
        ).toBe(true);
        expect(
          checkpoints.every(
            (snapshot) =>
              snapshot.binding.journalId === f.initial.binding.journalId &&
              snapshot.writer.writerId === f.initial.writer.writerId &&
              snapshot.binding.manager.birth === f.manager.birth &&
              snapshot.gaps.length === 0
          )
        ).toBe(true);
        expect(
          checkpoints.every(
            (snapshot) =>
              snapshot.root.kind === 'attributed' && snapshot.root.identity.birth === f.root.birth
          )
        ).toBe(true);
      } else
        expect(
          checkpoints.every((snapshot) => snapshot.observationWindow.endMonotonic < 30010)
        ).toBe(true);
    } finally {
      await rm(f.parentDirectory, { recursive: true, force: true });
    }
  }
);
it('fences continuous original campaign at a durable native gap and never renews that checkpoint', async () => {
  const f = await fixture();
  let clock = 10,
    round = 0,
    fault = 0;
  const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
  const observer: DarwinProcessObserver = {
    async inspect(pids) {
      return {
        ...boot,
        processes: pids.map((pid) => ({
          kind: 'present' as const,
          identity: pid === 10 ? f.managerNative : f.rootNative,
          parentPid: pid === 10 ? 1 : 10,
          zombie: false,
        })),
      };
    },
    async children(parent) {
      const identity = parent.pid === 10 ? f.managerNative : f.rootNative;
      return {
        ...boot,
        parentBefore: identity,
        parentAfter: { ...identity },
        complete: true,
        processes: [],
      };
    },
  };
  try {
    expect(
      await observeDarwinJournal({
        location: f.location,
        initial: f.initial,
        root: f.root,
        observer,
        monotonicNow: () => clock++,
        pause: async () => {
          round++;
          clock += 6000;
        },
        endMonotonic: 30010,
        maxGap: 5000,
        continuousWindowMilliseconds: 30000,
        onObservationFault: async () => {
          fault++;
          const read = await readJournal(f.location);
          expect(read.state).toBe('valid-recorded-data');
          if (read.state === 'valid-recorded-data')
            expect(read.snapshot.gaps.length).toBeGreaterThan(0);
        },
      })
    ).toBe('retained');
    expect(round).toBe(1);
    expect(fault).toBe(1);
  } finally {
    await rm(f.parentDirectory, { recursive: true, force: true });
  }
});

it('retains an attributed nonroot exited-unreaped child without losing the continuous campaign', async () => {
  const f = await fixture();
  let round = 0,
    clock = 10,
    faults = 0;
  const checkpoints: JournalSnapshot[] = [];
  const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
  const observer: DarwinProcessObserver = {
    async inspect(pids) {
      return {
        ...boot,
        processes: pids.map((pid) => {
          if (round >= 6 || (pid === 30 && round >= 4)) return { kind: 'absent' as const, pid };
          return {
            kind: 'present' as const,
            identity: pid === 10 ? f.managerNative : pid === 20 ? f.rootNative : f.childNative,
            parentPid: pid === 10 ? 1 : pid === 20 ? 10 : 20,
            zombie: pid === 30 && round >= 2,
          };
        }),
      };
    },
    async children(parent) {
      if (parent.pid === 30 && round >= 2)
        throw new Error('NONEXECUTING_CHILD_MUST_NOT_BE_ENUMERATED');
      const identity =
        parent.pid === 10 ? f.managerNative : parent.pid === 20 ? f.rootNative : f.childNative;
      return {
        ...boot,
        parentBefore: identity,
        parentAfter: { ...identity },
        complete: true,
        processes:
          parent.pid === 20 && round < 4
            ? [
                {
                  kind: 'present' as const,
                  identity: f.childNative,
                  parentPid: 20,
                  zombie: round >= 2,
                },
              ]
            : [],
      };
    },
  };
  try {
    const result = await observeDarwinJournal({
      location: f.location,
      initial: f.initial,
      root: f.root,
      observer,
      monotonicNow: () => clock++,
      endMonotonic: 30010,
      maxGap: 5000,
      continuousWindowMilliseconds: 30000,
      onObservationFault: async () => {
        faults++;
      },
      pause: async () => {
        const read = await readJournal(f.location);
        if (read.state !== 'valid-recorded-data') throw new Error('DURABLE_CHECKPOINT_REQUIRED');
        checkpoints.push(read.snapshot);
        round++;
        clock += 100;
      },
    });
    expect(result).toBe('recorded-gone');
    expect(faults).toBe(0);
    const held = checkpoints.filter((snapshot) =>
      snapshot.retainedIdentities.some(
        (row) => row.identity.pid === 30 && row.lifecycle === 'exited-unreaped'
      )
    );
    expect(held.length).toBeGreaterThan(0);
    for (const snapshot of held) {
      expect(snapshot.gaps).toEqual([]);
      expect(snapshot.phase).toBe('observing');
      expect(snapshot.retainedIdentities.find((row) => row.identity.pid === 20)?.lifecycle).toBe(
        'alive'
      );
      expect(snapshot.retainedIdentities.find((row) => row.identity.pid === 30)).toMatchObject({
        identity: darwinBirth(f.childNative),
        role: 'descendant',
        parent: f.root,
        lifecycle: 'exited-unreaped',
      });
    }
    expect(
      checkpoints.some((snapshot) =>
        snapshot.retainedIdentities.some(
          (row) => row.identity.pid === 30 && row.lifecycle === 'dead'
        )
      )
    ).toBe(true);
  } finally {
    await rm(f.parentDirectory, { recursive: true, force: true });
  }
});

it.each([
  'manager-zombie',
  'root-zombie',
  'new-zombie',
  'parent-replaced',
  'boot-changed',
  'terminal-revived',
] as const)(
  'preserves continuous refusal for %s around an enrolled terminal descendant',
  async (mode) => {
    const f = await fixture();
    let round = 0,
      clock = 10,
      faults = 0;
    let bootCheckpoint: Awaited<ReturnType<typeof readJournal>> | undefined;
    const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
    const observer: DarwinProcessObserver = {
      async inspect(pids) {
        return {
          ...boot,
          bootSeconds: mode === 'boot-changed' && round >= 2 ? '2' : '1',
          processes: pids.map((pid) => {
            let identity = pid === 10 ? f.managerNative : pid === 20 ? f.rootNative : f.childNative;
            if (mode === 'parent-replaced' && round >= 2 && pid === 20)
              identity = { ...identity, seconds: '999' };
            const zombie =
              round >= 2 &&
              (mode === 'manager-zombie'
                ? pid === 10
                : mode === 'root-zombie'
                  ? pid === 20
                  : pid === 30) &&
              !(mode === 'terminal-revived' && round >= 3);
            return {
              kind: 'present' as const,
              identity,
              parentPid: pid === 10 ? 1 : pid === 20 ? 10 : 20,
              zombie,
            };
          }),
        };
      },
      async children(parent) {
        const identity =
          parent.pid === 10 ? f.managerNative : parent.pid === 20 ? f.rootNative : f.childNative;
        return {
          ...boot,
          parentBefore: identity,
          parentAfter: { ...identity },
          complete: true,
          processes:
            parent.pid === 20 && (mode !== 'new-zombie' || round >= 2)
              ? [
                  {
                    kind: 'present' as const,
                    identity: f.childNative,
                    parentPid: 20,
                    zombie: round >= 2 && !(mode === 'terminal-revived' && round >= 3),
                  },
                ]
              : [],
        };
      },
    };
    try {
      const result = await observeDarwinJournal({
        location: f.location,
        initial: f.initial,
        root: f.root,
        observer,
        monotonicNow: () => clock++,
        endMonotonic: 1000,
        maxGap: 500,
        continuousWindowMilliseconds: 1000,
        pause: async () => {
          round++;
          if (mode === 'boot-changed' && round === 2)
            bootCheckpoint = await readJournal(f.location);
        },
        onObservationFault: async () => {
          faults++;
        },
      });
      expect(result).toBe(mode === 'boot-changed' ? 'uncertain' : 'retained');
      expect(faults).toBe(1);
      const read = await readJournal(f.location);
      expect(read.state).toBe('valid-recorded-data');
      if (read.state !== 'valid-recorded-data') throw new Error('DURABLE_REFUSAL_REQUIRED');
      if (mode === 'boot-changed') {
        // Validation refusal seals the writer; foreign-boot facts never replace its last checkpoint.
        expect(bootCheckpoint?.state).toBe('valid-recorded-data');
        if (bootCheckpoint?.state !== 'valid-recorded-data')
          throw new Error('ORIGINAL_BOOT_CHECKPOINT_REQUIRED');
        expect(read.snapshot).toEqual(bootCheckpoint.snapshot);
        expect(read.snapshot.gaps).toEqual([]);
        expect(read.snapshot.binding.bootScope).toEqual(f.initial.binding.bootScope);
      } else expect(read.snapshot.gaps.length).toBeGreaterThan(0);
      expect(read.snapshot.phase).not.toBe('observation-ended');
      if (mode === 'new-zombie')
        expect(read.snapshot.retainedIdentities.some((row) => row.identity.pid === 30)).toBe(false);
      if (mode === 'terminal-revived')
        expect(
          read.snapshot.retainedIdentities.find((row) => row.identity.pid === 30)?.lifecycle
        ).toBe('unknown');
    } finally {
      await rm(f.parentDirectory, { recursive: true, force: true });
    }
  }
);
