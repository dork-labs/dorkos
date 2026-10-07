import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { observeDarwinJournal } from '../runtime/darwin-journal-observer.js';
import {
  darwinBirth,
  type DarwinProcessObserver,
  type DarwinProcessBatch,
} from '../runtime/darwin-process-observer.js';
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
            : {
                kind: 'present' as const,
                identity: f.managerNative,
                parentPid: 1,
                zombie: false,
              };
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

it.each([false, true])(
  'retains the same original incomplete or unqualified child batch (%s)',
  async (unqualified) => {
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
              ? [
                  {
                    kind: 'present' as const,
                    identity: f.childNative,
                    parentPid: 20,
                    zombie: unqualified,
                  },
                ]
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
          onIncompleteChildren: async (parent, batch, original) => {
            refusals.push({ parent, batch, original });
          },
          pause: async () => {
            const read = await readJournal(f.location);
            if (read.state === 'valid-recorded-data') checkpoints.push(read.snapshot);
            round++;
          },
        })
      ).toBe('retained');
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({
        original: {
          reason: unqualified ? 'CHILD_UNQUALIFIED' : 'CHILDREN_INCOMPLETE',
          sequence: expect.any(Number),
        },
      });
      expect(childrenCalls).toBe(unqualified ? 1 : 2); // Initial root discovery, then the exact incomplete root sweep.
      const gappedAlive = checkpoints.find((snapshot) => snapshot.gaps.length);
      expect(gappedAlive?.retainedIdentities[1].lifecycle).toBe('alive');
      const final = await readJournal(f.location);
      expect(final.state).toBe('valid-recorded-data');
      if (final.state === 'valid-recorded-data') {
        expect(final.snapshot.phase).toBe('retained');
        expect(final.snapshot.retainedIdentities.map((value) => value.lifecycle)).toEqual(
          unqualified ? ['dead', 'dead'] : ['dead', 'dead', 'dead']
        );
        expect(final.snapshot.root).toEqual(checkpoints[0].root);
        expect(final.snapshot.gaps).toHaveLength(1);
        expect(final.snapshot.gaps[0].cause).toBe('association-missing');
        expect(final.snapshot.gaps[0].identity).toEqual(f.root);
        expect(final.snapshot.firstCause?.cause).toBe('association-missing');
      }
    } finally {
      await rm(f.parentDirectory, { recursive: true, force: true });
    }
  }
);

it.each([false, true])(
  'records the selected controller-supervisor-root chain and refuses a replaced supervisor (%s)',
  async (replaced) => {
    const f = await fixture();
    let round = 0,
      clock = 10;
    const boot = {
      version: 1 as const,
      bootSeconds: '1',
      bootMicroseconds: '0',
    };
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
    const boot = {
      version: 1 as const,
      bootSeconds: '1',
      bootMicroseconds: '0',
    };
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
    let clock = 10;
    const checkpoints: JournalSnapshot[] = [];
    const published: number[] = [];
    const boot = {
      version: 1 as const,
      bootSeconds: '1',
      bootMicroseconds: '0',
    };
    const observer: DarwinProcessObserver = {
      async inspect(pids) {
        return {
          ...boot,
          processes: pids.map((pid) =>
            clock >= 35010
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
          // Sample fewer synthetic idle epochs, strictly inside the unchanged5000ms gap.
          clock += 4000;
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
      expect(checkpoints.length).toBeGreaterThan(0);
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
    const boot = {
      version: 1 as const,
      bootSeconds: '1',
      bootMicroseconds: '0',
    };
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

it('uses genuine original root return only to stop fresh enumeration, retaining known descendants until strict absence', async () => {
  const f = await fixture();
  let round = 0,
    clock = 10,
    returned = false,
    afterReturnRootQueries = 0,
    afterReturnDescendantQueries = 0;
  const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
  const checkpoints: JournalSnapshot[] = [];
  const observer: DarwinProcessObserver = {
    async inspect(pids) {
      const processes = pids.map((pid) => {
        if ((pid === 20 && returned) || (pid === 30 && round >= 4))
          return { kind: 'absent' as const, pid };
        const identity = pid === 10 ? f.managerNative : pid === 20 ? f.rootNative : f.childNative;
        return {
          kind: 'present' as const,
          identity,
          parentPid: pid === 10 ? 1 : pid === 20 ? 10 : returned ? 1 : 20,
          zombie: false,
        };
      });
      if (round === 2) returned = true; // Original return arrives after this inspect took its facts.
      return { ...boot, processes };
    },
    async children(parent) {
      if (returned && parent.pid === 20) afterReturnRootQueries++;
      if (returned && parent.pid === 30) afterReturnDescendantQueries++;
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
    expect(
      await observeDarwinJournal({
        location: f.location,
        initial: f.initial,
        root: f.root,
        observer,
        originalRootReturned: () => (returned ? f.root : undefined),
        endBrowser: () => returned,
        monotonicNow: () => clock++,
        pause: async () => {
          const read = await readJournal(f.location);
          if (read.state === 'valid-recorded-data') checkpoints.push(read.snapshot);
          round++;
        },
        endMonotonic: 1000,
        maxGap: 100,
      })
    ).toBe('campaign-closed');
    expect(afterReturnRootQueries).toBe(0);
    expect(afterReturnDescendantQueries).toBeGreaterThan(0);
    expect(
      checkpoints.some(
        (s) =>
          s.retainedIdentities.some(
            (row) => row.role === 'descendant' && row.lifecycle === 'alive'
          ) && s.retainedIdentities.some((row) => row.role === 'root' && row.lifecycle === 'dead')
      )
    ).toBe(true);
    const read = await readJournal(f.location);
    expect(read.state).toBe('valid-recorded-data');
    if (read.state === 'valid-recorded-data') {
      expect(read.snapshot.gaps).toEqual([]);
      expect(
        read.snapshot.retainedIdentities
          .filter((row) => row.role !== 'manager')
          .every((row) => row.lifecycle === 'dead')
      ).toBe(true);
    }
  } finally {
    await rm(f.parentDirectory, { recursive: true, force: true });
  }
});

it('never heals an already-entered incomplete query when the original root returns during it', async () => {
  const f = await fixture();
  let clock = 10,
    returned = false,
    entered = false;
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
    async children() {
      entered = true;
      // The original query entered before this genuine private proof became available.
      returned = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        ...boot,
        parentBefore: null,
        parentAfter: null,
        complete: false,
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
        originalRootReturned: () => (returned ? f.root : undefined),
        endBrowser: () => returned,
        monotonicNow: () => clock++,
        pause: async () => {
          clock += 20;
        },
        endMonotonic: 100,
        maxGap: 100,
      })
    ).toBe('retained');
    expect(entered).toBe(true);
    const read = await readJournal(f.location);
    expect(read.state).toBe('valid-recorded-data');
    if (read.state === 'valid-recorded-data') {
      expect(read.snapshot.gaps.some((gap) => gap.cause === 'association-missing')).toBe(true);
      expect(read.snapshot.firstCause?.cause).toBe('association-missing');
    }
  } finally {
    await rm(f.parentDirectory, { recursive: true, force: true });
  }
});

it('refuses a returned-root lifetime mismatch without upgrading the recorded campaign', async () => {
  const f = await fixture();
  let clock = 10,
    round = 0;
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
    async children() {
      return {
        ...boot,
        parentBefore: f.rootNative,
        parentAfter: f.rootNative,
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
        originalRootReturned: () => (round ? { ...f.root, birth: 'reused-lifetime' } : undefined),
        endBrowser: () => true,
        monotonicNow: () => clock++,
        pause: async () => {
          round++;
          clock += 20;
        },
        endMonotonic: 100,
        maxGap: 100,
      })
    ).toBe('retained');
    const read = await readJournal(f.location);
    expect(read.state).toBe('valid-recorded-data');
    if (read.state === 'valid-recorded-data') {
      expect(read.snapshot.gaps.some((gap) => gap.cause === 'identity-unknown')).toBe(true);
      expect(read.snapshot.firstCause?.cause).toBe('identity-unknown');
    }
  } finally {
    await rm(f.parentDirectory, { recursive: true, force: true });
  }
});

it('enrolls a grandchild forked by a retained live descendant after genuine root return', async () => {
  const f = await fixture();
  const grandchildNative = { pid: 40, seconds: '400', microseconds: '0' };
  let round = 0,
    clock = 10,
    returned = false,
    enrolledAfterReturn = false;
  const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
  const checkpoints: JournalSnapshot[] = [];
  const observer: DarwinProcessObserver = {
    async inspect(pids) {
      return {
        ...boot,
        processes: pids.map((pid) => {
          if ((pid === 20 && returned) || (pid === 30 && round >= 5) || (pid === 40 && round >= 6))
            return { kind: 'absent' as const, pid };
          const identity =
            pid === 10
              ? f.managerNative
              : pid === 20
                ? f.rootNative
                : pid === 30
                  ? f.childNative
                  : grandchildNative;
          return {
            kind: 'present' as const,
            identity,
            parentPid:
              pid === 10
                ? 1
                : pid === 20
                  ? 10
                  : pid === 30
                    ? returned
                      ? 1
                      : 20
                    : round >= 5
                      ? 1
                      : 30,
            zombie: false,
          };
        }),
      };
    },
    async children(parent) {
      const identity =
        parent.pid === 20 ? f.rootNative : parent.pid === 30 ? f.childNative : grandchildNative;
      if (returned && parent.pid === 30) enrolledAfterReturn = true;
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
            : returned && parent.pid === 30
              ? [
                  {
                    kind: 'present' as const,
                    identity: grandchildNative,
                    parentPid: 30,
                    zombie: false,
                  },
                ]
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
        originalRootReturned: () => (returned ? f.root : undefined),
        endBrowser: () => returned,
        monotonicNow: () => clock++,
        pause: async () => {
          const read = await readJournal(f.location);
          if (read.state === 'valid-recorded-data') checkpoints.push(read.snapshot);
          round++;
          if (round === 2) returned = true;
        },
        endMonotonic: 1000,
        maxGap: 100,
      })
    ).toBe('campaign-closed');
    expect(enrolledAfterReturn).toBe(true);
    expect(
      checkpoints.some((s) =>
        s.retainedIdentities.some((row) => row.identity.pid === 40 && row.lifecycle === 'alive')
      )
    ).toBe(true);
    const read = await readJournal(f.location);
    expect(read.state).toBe('valid-recorded-data');
    if (read.state === 'valid-recorded-data') {
      expect(read.snapshot.gaps).toEqual([]);
      expect(
        read.snapshot.retainedIdentities.find((row) => row.identity.pid === 40)?.lifecycle
      ).toBe('dead');
    }
  } finally {
    await rm(f.parentDirectory, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'joins an entered native query and durable commit before pre-close ACK (incomplete=%s)',
  async (incomplete) => {
    const f = await fixture();
    const boot = {
      version: 1 as const,
      bootSeconds: '1',
      bootMicroseconds: '0',
    };
    let clock = 10,
      requested = false,
      closed = false,
      calls = 0;
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const acknowledged: number[] = [];
    const originals: { operation?: Promise<unknown> } = {};
    onTestFinished(async () => {
      release();
      if (originals.operation) await originals.operation;
      await rm(f.parentDirectory, { recursive: true, force: true });
    });
    const observer: DarwinProcessObserver = {
      async inspect(pids) {
        return {
          ...boot,
          processes: pids.map((pid) =>
            closed && pid !== 10
              ? { kind: 'absent' as const, pid }
              : {
                  kind: 'present' as const,
                  identity:
                    pid === 10 ? f.managerNative : pid === 20 ? f.rootNative : f.childNative,
                  parentPid: pid === 10 ? 1 : pid === 20 ? 10 : 20,
                  zombie: false,
                }
          ),
        };
      },
      async children() {
        calls++;
        requested = true; // Reentrant original query requests close before its own return.
        enter();
        await held;
        return {
          ...boot,
          parentBefore: incomplete ? null : f.rootNative,
          parentAfter: incomplete ? null : f.rootNative,
          complete: !incomplete,
          processes: incomplete
            ? []
            : [
                {
                  kind: 'present' as const,
                  identity: f.childNative,
                  parentPid: 20,
                  zombie: false,
                },
              ],
        };
      },
    };
    originals.operation = observeDarwinJournal({
      location: f.location,
      initial: f.initial,
      root: f.root,
      observer,
      enumerationCloseRequested: () => requested,
      onEnumerationClosed: async (checkpoint) => {
        const read = await readJournal(f.location);
        expect(read.state).toBe('valid-recorded-data');
        if (read.state !== 'valid-recorded-data') throw new Error('MISSING_DURABLE_CHECKPOINT');
        expect(read.snapshot.sequence).toBe(checkpoint.sequence);
        expect(read.snapshot.gaps).toEqual([]);
        expect(read.snapshot.retainedIdentities.some((row) => row.identity.pid === 30)).toBe(true);
        acknowledged.push(checkpoint.sequence);
        closed = true;
      },
      endBrowser: () => closed,
      originalRootReturned: () => (closed ? f.root : undefined),
      monotonicNow: () => clock++,
      pause: async () => {},
      endMonotonic: 100,
      maxGap: 100,
    });
    await entered;
    await Promise.resolve();
    expect(acknowledged).toEqual([]);
    release();
    expect(await originals.operation).toBe(incomplete ? 'uncertain' : 'campaign-closed');
    expect(calls).toBe(1);
    expect(acknowledged.length).toBe(incomplete ? 0 : 1);
    const final = await readJournal(f.location);
    expect(final.state).toBe('valid-recorded-data');
    if (final.state === 'valid-recorded-data') {
      if (incomplete)
        expect(final.snapshot.gaps.some((row) => row.cause === 'association-missing')).toBe(true);
      else
        expect(
          final.snapshot.retainedIdentities
            .filter((row) => row.role !== 'manager')
            .every((row) => row.lifecycle === 'dead')
        ).toBe(true);
    }
  }
);

it('retains an original undefined pre-close ACK failure without reopening enumeration', async () => {
  const f = await fixture();
  let clock = 10,
    requested = false,
    calls = 0;
  const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
  try {
    const result = await observeDarwinJournal({
      location: f.location,
      initial: f.initial,
      root: f.root,
      observer: {
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
        async children() {
          calls++;
          requested = true;
          return {
            ...boot,
            parentBefore: f.rootNative,
            parentAfter: f.rootNative,
            complete: true,
            processes: [],
          };
        },
      },
      enumerationCloseRequested: () => requested,
      onEnumerationClosed: async () => {
        throw undefined;
      },
      monotonicNow: () => clock++,
      pause: async () => {},
      endMonotonic: 100,
      maxGap: 100,
    });
    expect(result).toBe('uncertain');
    expect(calls).toBe(1);
    const read = await readJournal(f.location);
    expect(read.state).toBe('valid-recorded-data');
    if (read.state === 'valid-recorded-data') expect(read.snapshot.phase).toBe('retained');
  } finally {
    await rm(f.parentDirectory, { recursive: true, force: true });
  }
});

it.each([
  ['birth-changed', 'JOURNAL_IDENTITY_NATIVE_BIRTH_CHANGED'],
  ['parent-changed', 'JOURNAL_IDENTITY_NATIVE_PARENT_CHANGED'],
  ['alive-to-zombie', 'JOURNAL_IDENTITY_NATIVE_ALIVE_TO_ZOMBIE'],
  ['zombie-to-alive', 'JOURNAL_IDENTITY_NATIVE_ZOMBIE_TO_ALIVE'],
  ['membership-disappeared', 'JOURNAL_IDENTITY_NATIVE_MEMBERSHIP_DISAPPEARED'],
  ['membership-appeared', 'JOURNAL_IDENTITY_NATIVE_MEMBERSHIP_APPEARED'],
  [
    'membership-absent-with-present-reads',
    'JOURNAL_IDENTITY_NATIVE_MEMBERSHIP_ABSENT_WITH_PRESENT_READS',
  ],
  [35, 'JOURNAL_IDENTITY_NATIVE_EAGAIN'],
  [3, 'JOURNAL_IDENTITY_NATIVE_ESRCH'],
  [1, 'JOURNAL_IDENTITY_NATIVE_PERMISSION'],
  [13, 'JOURNAL_IDENTITY_NATIVE_PERMISSION'],
  [5, 'JOURNAL_IDENTITY_NATIVE_IO'],
  [22, 'JOURNAL_IDENTITY_NATIVE_OTHER'],
  ['missing', 'JOURNAL_IDENTITY_MISSING_FACT'],
  ['boot', 'JOURNAL_IDENTITY_BOOT_MISMATCH'],
  ['terminal', 'JOURNAL_IDENTITY_TERMINAL_CONTRADICTION'],
] as const)(
  'retains original identity gap %s and only its fixed refusal branch',
  async (fault, code) => {
    const f = await fixture();
    let clock = 10,
      round = 0,
      refusal: string | undefined;
    const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
    const observer: DarwinProcessObserver = {
      async inspect(pids) {
        return {
          ...boot,
          ...(fault === 'boot' && round >= 2 ? { bootSeconds: '2' } : {}),
          processes: pids.flatMap((pid): DarwinProcessBatch['processes'] => {
            if (pid === 30 && round >= 2 && fault !== 'terminal')
              return fault === 'missing'
                ? []
                : [
                    {
                      kind: 'unknown' as const,
                      pid,
                      error: typeof fault === 'number' ? fault : 35,
                      ...(typeof fault === 'string' && fault !== 'boot'
                        ? { uncertainty: fault }
                        : {}),
                    },
                  ];
            return [
              {
                kind: 'present' as const,
                identity: pid === 10 ? f.managerNative : pid === 20 ? f.rootNative : f.childNative,
                parentPid: pid === 10 ? 1 : pid === 20 ? 10 : 20,
                zombie: pid === 30 && fault === 'terminal' && round === 2,
              },
            ];
          }),
        };
      },
      async children(parent) {
        const native =
          parent.pid === 10 ? f.managerNative : parent.pid === 20 ? f.rootNative : f.childNative;
        return {
          ...boot,
          parentBefore: native,
          parentAfter: native,
          complete: true,
          processes:
            parent.pid === 10
              ? [{ kind: 'present' as const, identity: f.rootNative, parentPid: 10, zombie: false }]
              : parent.pid === 20 && round <= 1
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
      expect(
        await observeDarwinJournal({
          location: f.location,
          initial: f.initial,
          root: f.root,
          observer,
          monotonicNow: () => clock++,
          pause: async () => {
            round++;
          },
          endMonotonic: 1000,
          continuousWindowMilliseconds: 1000,
          maxGap: 100,
          onObservationFault: async (value) => {
            refusal = value;
            clock = 10000;
          },
        })
      ).toBe(fault === 'boot' ? 'uncertain' : 'retained');
      expect(refusal).toBe(code);
      const read = await readJournal(f.location);
      expect(read.state).toBe('valid-recorded-data');
      if (read.state === 'valid-recorded-data') {
        if (fault === 'boot') {
          // The original writer fenced the invalid commit and its later refusal commit.
          expect(read.snapshot.firstCause).toBeNull();
          expect(read.snapshot.gaps).toEqual([]);
          expect(read.snapshot.phase).toBe('observing');
        } else {
          expect(read.snapshot.firstCause?.cause).toBe('identity-unknown');
          expect(read.snapshot.gaps.some((value) => value.cause === 'identity-unknown')).toBe(true);
          expect(read.snapshot.phase).toBe('retained');
        }
        if (fault === 'boot') {
          // The original validator refused the multi-identity invalid sweep; its last actual rows remain.
          expect(read.snapshot.retainedIdentities.every((row) => row.lifecycle === 'alive')).toBe(
            true
          );
          expect(read.snapshot.retainedIdentities.some((row) => row.identity.pid === 30)).toBe(
            true
          );
        }
      }
    } finally {
      await rm(f.parentDirectory, { recursive: true, force: true });
    }
  }
);
