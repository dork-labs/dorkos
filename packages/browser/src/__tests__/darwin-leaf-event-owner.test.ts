import {
  createOriginalObserverFailureSink,
  projectOriginalObserverFailure,
  readOriginalObserverFailure,
} from '../runtime/journal/unknown-diagnostic.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeDarwinJournal } from '../runtime/darwin-journal-observer.js';
import {
  observeJournalDirectory,
  readJournal,
  type JournalSnapshot,
} from '../lifecycle/process-journal.js';
import { darwinBirth, type DarwinProcessObserver } from '../runtime/darwin-process-observer.js';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  consumeOriginalLeafTerminal,
  originalLeafDiagnostic,
  hasOriginalLeafTerminal,
  openDarwinLeafEventOwner,
  originalLeafBaselineRefusal,
} from '../runtime/darwin-leaf-event-owner.js';
import type { DarwinChildrenBatch } from '../runtime/darwin-process-observer.js';
const captured = vi.hoisted(() => ({ launch: vi.fn(), accepts: vi.fn() }));
vi.mock('../runtime/darwin-owned-child.js', () => ({
  createDarwinOwnedChildLauncher: () => ({ launch: captured.launch }),
  acceptsDarwinOwnedChildReturn: captured.accepts,
}));
beforeEach(() => {
  captured.launch.mockReset();
  captured.accepts.mockReset().mockReturnValue(true);
});
const identity = Object.freeze({ pid: 42, birth: 'darwin-bsd-start:10:2' });
const failedCensus = (): DarwinChildrenBatch => ({
  version: 1,
  bootSeconds: '1',
  bootMicroseconds: '0',
  processes: [],
  parentBefore: null,
  parentAfter: null,
  complete: false,
  parentObservation: {
    beforeError: 3,
    afterError: 3,
    beforeZombie: null,
    afterZombie: null,
    identityChanged: null,
  },
});
async function fixture(
  options: {
    beforeAck?: 'fork' | 'exit';
    admitted?: boolean;
    refusal?: Readonly<{ reason: string; error: number }>;
    holdReturn?: boolean;
    holdAck?: boolean;
    holdWrite?: boolean;
    onEnd?(): void;
    baseline?(identity: {
      pid: number;
      seconds: string;
      microseconds: string;
    }): DarwinChildrenBatch;
    omitBaseline?: boolean;
    afterWatchAck?(slot: number): void;
  } = {}
) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  let release!: () => void;
  const completion = new Promise<{ firstCause: null }>((yes) => {
    release = () => yes({ firstCause: null });
  });
  const row = (kind: string, slot: number, result: string) =>
    stdout.write(
      JSON.stringify({
        kind,
        slot,
        result,
        ...(kind === 'watch' && result === 'refused' && options.refusal ? options.refusal : {}),
      }) + '\n'
    );
  let releaseAck: () => void = () => {};
  let releaseWrite: () => void = () => {};
  let entered!: () => void;
  const baselineEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      const fields = chunk.toString().trim().split(' ');
      if (fields[0] === 'W') {
        const parent = { pid: Number(fields[2]), seconds: fields[3], microseconds: fields[4] };
        const baseline = options.baseline?.(parent) ?? {
          version: 1 as const,
          bootSeconds: '1',
          bootMicroseconds: '0',
          parentBefore: parent,
          parentAfter: parent,
          complete: true,
          processes: [],
        };
        if (options.beforeAck) row('event', Number(fields[1]), options.beforeAck);
        if (!options.omitBaseline)
          stdout.write(
            JSON.stringify({ kind: 'baseline', slot: Number(fields[1]), batch: baseline }) + '\n'
          );
        entered();
        let ackReleased = false,
          writeReleased = false;
        releaseAck = () => {
          if (ackReleased) return;
          ackReleased = true;
          row(
            'watch',
            Number(fields[1]),
            options.admitted === false || !!options.beforeAck || !baseline.complete
              ? 'refused'
              : baseline.processes.length
                ? 'nonleaf'
                : 'leaf'
          );
          options.afterWatchAck?.(Number(fields[1]));
        };
        releaseWrite = () => {
          if (writeReleased) return;
          writeReleased = true;
          done();
        };
        if (!options.holdAck) releaseAck();
        if (!options.holdWrite) releaseWrite();
        return;
      } else row('barrier', Number(fields[1]), 'settled');
      done();
    },
    final(done) {
      options.onEnd?.();
      stdout.end();
      stderr.end();
      if (!options.holdReturn) release();
      done();
    },
  });
  captured.launch.mockResolvedValue({
    child: Object.assign(child, { stdin, stdout, stderr }),
    identity: async () => ({ pid: 84, birth: 'darwin-bsd-start:10:3' }),
    completion: () => completion,
    returned: async () => {
      await completion;
      return Object.freeze({});
    },
  });
  const owner = await openDarwinLeafEventOwner({
    artifact: { path: '/private/owned-helper', sha256: 'a'.repeat(64) },
    manager: { pid: 7, birth: 'darwin-bsd-start:1:1' },
    boot: { seconds: '1', microseconds: '0' },
  });
  return {
    owner,
    row,
    release,
    stdout,
    stdin,
    baselineEntered,
    releaseAck: () => releaseAck(),
    releaseWrite: () => releaseWrite(),
  };
}
it('consumes one exact never-forked leaf exit epoch; never reports physical death', async () => {
  const f = await fixture();
  try {
    await f.owner.enroll(identity, 2);
    f.row('event', 1, 'exit');
    expect(await consumeOriginalLeafTerminal(f.owner, identity, 3, failedCensus())).toBe(true);
    expect(hasOriginalLeafTerminal(f.owner, identity)).toBe(true);
    expect(await consumeOriginalLeafTerminal(f.owner, identity, 4, failedCensus())).toBe(false);
  } finally {
    f.release();
    await f.owner.close();
  }
});
it('never rearms fork dirt through another enrollment request', async () => {
  const f = await fixture();
  try {
    await f.owner.enroll(identity, 2);
    f.row('event', 1, 'fork');
    await f.owner.enroll(identity, 4); // Same original cannot acquire a new clean epoch.
    f.row('event', 1, 'exit');
    expect(await consumeOriginalLeafTerminal(f.owner, identity, 5, failedCensus())).toBe(false);
    expect(hasOriginalLeafTerminal(f.owner, identity)).toBe(false);
  } finally {
    f.release();
    await f.owner.close();
  }
});
for (const beforeAck of ['fork', 'exit'] as const)
  it(`refuses ${beforeAck} at original watch enrollment`, async () => {
    const f = await fixture({ beforeAck });
    try {
      await f.owner.enroll(identity, 1);
      if (beforeAck === 'fork') f.row('event', 1, 'exit');
      expect(await consumeOriginalLeafTerminal(f.owner, identity, 2, failedCensus())).toBe(false);
    } finally {
      f.release();
      await f.owner.close();
    }
  });
it('requires exact birth, later epoch, original boot and both ESRCH reads', async () => {
  const f = await fixture();
  try {
    await f.owner.enroll(identity, 2);
    f.row('event', 1, 'exit');
    expect(
      await consumeOriginalLeafTerminal(
        f.owner,
        { ...identity, birth: 'darwin-bsd-start:10:3' },
        3,
        failedCensus()
      )
    ).toBe(false);
    for (const epoch of [NaN, Infinity, -1, 2.5])
      expect(await consumeOriginalLeafTerminal(f.owner, identity, epoch, failedCensus())).toBe(
        false
      );
    expect(await consumeOriginalLeafTerminal(f.owner, identity, 2, failedCensus())).toBe(false);
    expect(
      await consumeOriginalLeafTerminal(f.owner, identity, 3, {
        ...failedCensus(),
        bootSeconds: '2',
      })
    ).toBe(false);
    expect(
      await consumeOriginalLeafTerminal(f.owner, identity, 3, {
        ...failedCensus(),
        parentObservation: { ...failedCensus().parentObservation!, afterError: 1 },
      })
    ).toBe(false);
    expect(await consumeOriginalLeafTerminal(f.owner, identity, 3, failedCensus())).toBe(true);
  } finally {
    f.release();
    await f.owner.close();
  }
});
it('joins the same original event child return after stdin close, without an invented timeout', async () => {
  const f = await fixture({ holdReturn: true });
  let returned = false;
  const closing = f.owner.close();
  void closing.then(() => {
    returned = true;
  });
  try {
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(f.owner.close()).toBe(closing);
  } finally {
    f.release();
    await closing;
  }
});
for (const cause of [false, undefined])
  it(`retains exact pipe failure ${String(cause)} through original close`, async () => {
    const f = await fixture();
    f.stdout.emit('error', cause);
    try {
      await expect(f.owner.enroll(identity, 1)).rejects.toBe(cause);
    } finally {
      f.release();
      await expect(f.owner.close()).rejects.toBe(cause);
    }
  });
it('refuses a structural foreign event owner before reading its barrier or methods', async () => {
  const getter = vi.fn(() => {
    throw new Error('not an original');
  });
  const foreign = Object.defineProperty({}, 'close', { get: getter });
  await expect(
    consumeOriginalLeafTerminal(foreign as never, identity, 3, failedCensus())
  ).rejects.toThrow('LEAF_EVENT_OWNER_UNAVAILABLE');
  expect(getter).not.toHaveBeenCalled();
});

async function durableFixture() {
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

for (const fault of [
  'exit',
  'early-exit',
  'baseline-exit',
  'fork-then-reparent',
  'unknown-inspect',
  'retained-orphan',
  'changed-boot',
  'initial-nonleaf',
  'appended-window-expired',
] as const)
  it(`runs genuine durable journal leaf transition ${fault}`, async () => {
    const f = await durableFixture();
    let publishExit: ((slot: number) => void) | undefined;
    const events = await fixture({
      admitted: fault === 'changed-boot' ? false : undefined,
      afterWatchAck: (slot) => {
        publishExit?.(slot);
      },
      baseline: (parent) => {
        const nonleaf = parent.pid === 30 && fault === 'initial-nonleaf';
        return {
          version: 1,
          bootSeconds: fault === 'changed-boot' ? '2' : '1',
          bootMicroseconds: '0',
          parentBefore: parent,
          parentAfter: parent,
          complete: true,
          processes: nonleaf
            ? [
                {
                  kind: 'present',
                  identity: { pid: 31, seconds: '301', microseconds: '0' },
                  parentPid: 30,
                  zombie: false,
                },
              ]
            : [],
        };
      },
    });
    if (fault === 'baseline-exit')
      publishExit = (slot) => {
        events.row('event', slot, 'exit');
      };
    let round = 0,
      clock = 10;
    const checkpoints: JournalSnapshot[] = [];
    let initialNonleafEnrolled: boolean | undefined;
    let childQueries = 0;
    const childQueryRounds: number[] = [];
    const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
    const observer: DarwinProcessObserver = {
      async inspect(pids) {
        return {
          ...boot,
          processes: pids.map((pid) => {
            if (
              round >= 4 ||
              (pid === 30 && (fault === 'early-exit' || fault === 'baseline-exit') && round >= 3)
            )
              return { kind: 'absent' as const, pid };
            if (pid === 30 && round === 3 && fault === 'unknown-inspect')
              return { kind: 'unknown' as const, pid, error: 3 };
            return {
              kind: 'present' as const,
              identity:
                pid === 10
                  ? f.managerNative
                  : pid === 20
                    ? f.rootNative
                    : pid === 30
                      ? f.childNative
                      : { pid: 31, seconds: '301', microseconds: '0' },
              parentPid: pid === 10 ? 1 : pid === 20 ? 10 : pid === 31 && round < 3 ? 30 : 20,
              zombie: false,
            };
          }),
        };
      },
      async children(parent) {
        if (parent.pid === 30) {
          childQueries++;
          childQueryRounds.push(round);
        }
        const identity =
          parent.pid === 20
            ? f.rootNative
            : parent.pid === 30
              ? f.childNative
              : { pid: 31, seconds: '301', microseconds: '0' };
        if (
          parent.pid === 30 &&
          (round === 3 ||
            (round === 2 && fault === 'early-exit') ||
            (round === 1 && fault === 'baseline-exit'))
        )
          return failedCensus();
        if (parent.pid === 30 && round === 1 && fault === 'changed-boot')
          return {
            ...boot,
            bootSeconds: '2',
            parentBefore: identity,
            parentAfter: identity,
            complete: true,
            processes: [],
          };
        if (
          parent.pid === 30 &&
          ((round === 2 && fault === 'retained-orphan') ||
            ((round === 1 || round === 2) && fault === 'initial-nonleaf'))
        )
          return {
            ...boot,
            parentBefore: identity,
            parentAfter: identity,
            complete: true,
            processes: [
              {
                kind: 'present' as const,
                identity: { pid: 31, seconds: '301', microseconds: '0' },
                parentPid: 30,
                zombie: false,
              },
            ],
          };
        if (parent.pid === 20 && round === 1 && fault === 'appended-window-expired') clock = 1000;
        return {
          ...boot,
          parentBefore: identity,
          parentAfter: identity,
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
      await observeDarwinJournal({
        location: f.location,
        initial: f.initial,
        root: f.root,
        observer,
        leafEvents: events.owner,
        monotonicNow: () => clock++,
        endMonotonic: 1000,
        maxGap: 1000,
        pause: async () => {
          const read = await readJournal(f.location);
          if (read.state === 'valid-recorded-data') checkpoints.push(read.snapshot);
          round++;
          if (round === 2 && fault === 'initial-nonleaf')
            initialNonleafEnrolled = originalLeafDiagnostic(
              events.owner,
              darwinBirth(f.childNative)
            ).enrolled;
          if (round === 2 && fault === 'early-exit') {
            const state = originalLeafDiagnostic(events.owner, darwinBirth(f.childNative));
            // Old delayed enumeration has no watch here; never fabricate its event slot.
            if (state.watched) events.row('event', 1, 'exit');
          }
          if (
            round === 3 &&
            fault !== 'retained-orphan' &&
            fault !== 'early-exit' &&
            fault !== 'baseline-exit' &&
            fault !== 'changed-boot' &&
            fault !== 'initial-nonleaf' &&
            fault !== 'appended-window-expired'
          ) {
            if (fault === 'fork-then-reparent') events.row('event', 1, 'fork');
            events.row('event', 1, 'exit');
          }
          if (round > 5) clock = 1001;
        },
      });
      const read = await readJournal(f.location);
      expect(read.state).toBe('valid-recorded-data');
      if (read.state !== 'valid-recorded-data') throw new Error('original-journal-missing');
      if (fault === 'exit' || fault === 'early-exit' || fault === 'baseline-exit') {
        if (fault === 'baseline-exit')
          expect(childQueryRounds, 'REDUNDANT_CHILD_QUERY_AFTER_ORIGINAL_W_BASELINE').toEqual([2]);
        expect(read.snapshot.gaps).toEqual([]);
        if (fault === 'early-exit') {
          const first = checkpoints.find((snapshot) =>
            snapshot.retainedIdentities.some((row) => row.identity.pid === 30)
          );
          expect(
            first?.retainedIdentities.find((row) => row.identity.pid === 30)?.firstSeenSequence
          ).toBe(2);
          expect(originalLeafDiagnostic(events.owner, darwinBirth(f.childNative)).consumed).toBe(
            true
          );
        }
        expect(
          checkpoints.some((snapshot) =>
            snapshot.retainedIdentities.some(
              (row) => row.identity.pid === 30 && row.lifecycle === 'alive'
            )
          )
        ).toBe(true);
        expect(
          read.snapshot.retainedIdentities.find((row) => row.identity.pid === 30)?.lifecycle
        ).toBe('dead'); // Only later actual absence.
      } else {
        if (fault === 'initial-nonleaf') expect(initialNonleafEnrolled).toBe(false);
        if (fault === 'changed-boot' || fault === 'appended-window-expired') {
          expect(originalLeafDiagnostic(events.owner, darwinBirth(f.childNative)).enrolled).toBe(
            false
          );
          expect(read.snapshot.firstCause?.sequence).toBe(2);
        }
        if (fault === 'appended-window-expired') {
          expect(childQueries).toBe(0);
          expect(read.snapshot.firstCause?.cause).toBe('observer-lost');
        }
        expect(
          read.snapshot.gaps.some(
            (gap) =>
              gap.cause ===
              (fault === 'unknown-inspect'
                ? 'identity-unknown'
                : fault === 'appended-window-expired' || fault === 'changed-boot'
                  ? 'observer-lost'
                  : 'association-missing')
          )
        ).toBe(true);
      }
    } finally {
      events.release();
      try {
        if (fault === 'changed-boot')
          await expect(events.owner.close()).rejects.toThrow('LEAF_EVENT_BASELINE_UNAVAILABLE');
        else await events.owner.close();
      } finally {
        await rm(f.parentDirectory, { recursive: true, force: true });
      }
    }
  });

it('refuses unadmitted native watch even with a later exact exit event', async () => {
  const f = await fixture({ admitted: false });
  try {
    await f.owner.enroll(identity, 1);
    f.row('event', 1, 'exit');
    expect(await consumeOriginalLeafTerminal(f.owner, identity, 2, failedCensus())).toBe(false);
  } finally {
    f.release();
    await f.owner.close();
  }
});
it('retains original pipe overflow uncertainty rather than accepting a prior exit', async () => {
  const f = await fixture();
  try {
    await f.owner.enroll(identity, 1);
    f.row('event', 1, 'exit');
    f.stdout.write(Buffer.alloc(256 * 1024));
    await expect(consumeOriginalLeafTerminal(f.owner, identity, 2, failedCensus())).rejects.toThrow(
      'LEAF_EVENT_OVERFLOW'
    );
  } finally {
    f.release();
    await expect(f.owner.close()).rejects.toThrow('LEAF_EVENT_OVERFLOW');
  }
});
it('refuses an unqualified original helper return after joining its same terminal', async () => {
  const f = await fixture();
  captured.accepts.mockReturnValue(false);
  f.release();
  await expect(f.owner.close()).rejects.toThrow('LEAF_EVENT_RETURN_UNCERTAIN');
});

it('publishes the same original close before reentrant writable final and joins held return once', async () => {
  let reentered: Promise<void> | undefined;
  const f = await fixture({
    holdReturn: true,
    onEnd: () => {
      reentered = f.owner.close();
    },
  });
  const stop = vi.spyOn(f.stdin, 'end');
  const closing = f.owner.close();
  let settled = false;
  void closing.then(
    () => {
      settled = true;
    },
    () => {}
  );
  try {
    expect(reentered).toBe(closing);
    expect(stop).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    f.release();
    try {
      await closing;
    } finally {
      stop.mockRestore();
    }
  }
});

it('snapshots exact retained leaf facts without barrier, consumption or authority', async () => {
  const f = await fixture();
  try {
    expect(originalLeafDiagnostic(f.owner, identity).watched).toBe(false);
    await f.owner.enroll(identity, 2);
    f.row('event', 1, 'fork');
    f.row('event', 1, 'exit');
    const diagnostic = originalLeafDiagnostic(f.owner, identity);
    expect(diagnostic).toEqual({
      watched: true,
      enrolled: true,
      forked: true,
      exited: true,
      consumed: false,
      receiverFailed: false,
      receiverClosed: false,
    });
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(hasOriginalLeafTerminal(f.owner, identity)).toBe(false);
    expect(await consumeOriginalLeafTerminal(f.owner, identity, 3, failedCensus())).toBe(false);
  } finally {
    f.release();
    await f.owner.close();
  }
});

it('retains actual nonzero watch baseline grandchildren without granting a leaf', async () => {
  const f = await fixture({
    baseline: (parent) => ({
      version: 1,
      bootSeconds: '1',
      bootMicroseconds: '0',
      parentBefore: parent,
      parentAfter: parent,
      complete: true,
      processes: [
        {
          kind: 'present',
          identity: { pid: 43, seconds: '11', microseconds: '0' },
          parentPid: parent.pid,
          zombie: false,
        },
      ],
    }),
  });
  try {
    const batch = await f.owner.enrollBaseline!(identity, 2);
    expect(batch?.processes).toEqual([
      {
        kind: 'present',
        identity: { pid: 43, seconds: '11', microseconds: '0' },
        parentPid: 42,
        zombie: false,
      },
    ]);
    expect(await f.owner.enrollBaseline!(identity, 2)).toBeUndefined();
    expect(await f.owner.enrollBaseline!(identity, 3)).toBeUndefined();
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch?.processes[0])).toBe(true);
    expect(originalLeafDiagnostic(f.owner, identity).enrolled).toBe(false);
    f.row('event', 1, 'exit');
    expect(await consumeOriginalLeafTerminal(f.owner, identity, 3, failedCensus())).toBe(false);
  } finally {
    f.release();
    await f.owner.close();
  }
});
it('never publishes a baseline capability on missing original watch protocol', async () => {
  const f = await fixture({ omitBaseline: true });
  try {
    await expect(f.owner.enrollBaseline!(identity, 2)).rejects.toThrow(
      'LEAF_EVENT_OWNER_UNAVAILABLE'
    );
  } finally {
    f.release();
    await expect(f.owner.close()).rejects.toThrow('LEAF_EVENT_OWNER_UNAVAILABLE');
  }
});
it('keeps a same-epoch exit unconsumable after the original baseline', async () => {
  const f = await fixture();
  try {
    expect((await f.owner.enrollBaseline!(identity, 2))?.complete).toBe(true);
    f.row('event', 1, 'exit');
    expect(await consumeOriginalLeafTerminal(f.owner, identity, 2, failedCensus())).toBe(false);
    expect(await consumeOriginalLeafTerminal(f.owner, identity, 3, failedCensus())).toBe(true);
  } finally {
    f.release();
    await f.owner.close();
  }
});
it('reserves full baseline reply and all possible events before original command entry', async () => {
  const f = await fixture();
  const write = vi.spyOn(f.stdin, 'write');
  try {
    const maximum = JSON.stringify({
      kind: 'present',
      identity: {
        pid: 2147483647,
        seconds: '18446744073709551615',
        microseconds: '18446744073709551615',
      },
      parentPid: 2147483647,
      zombie: false,
    });
    expect(Buffer.byteLength(maximum) + 1).toBeLessThanOrEqual(160);
    expect(512 * 160 + 1024 + 128 + 512 * 2 * 80).toBeLessThan(256 * 1024);
    for (let i = 0; i < 2500; i++)
      expect(await consumeOriginalLeafTerminal(f.owner, identity, 2, failedCensus())).toBe(false);
    write.mockClear();
    await expect(f.owner.enrollBaseline!(identity, 2)).rejects.toThrow('LEAF_EVENT_OVERFLOW');
    expect(write).not.toHaveBeenCalled();
  } finally {
    f.release();
    await expect(f.owner.close()).rejects.toThrow('LEAF_EVENT_OVERFLOW');
  }
});

for (const held of ['ack', 'write'] as const)
  it(`joins concurrent original baseline enrollment while ${held} is held`, async () => {
    const f = await fixture({ holdAck: held === 'ack', holdWrite: held === 'write' });
    const writing = vi.spyOn(f.stdin, 'write');
    const first = f.owner.enrollBaseline!(identity, 2);
    const originals: Promise<unknown>[] = [first];
    let firstSettled = false,
      repeatedSettled = false;
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      }
    );
    try {
      await f.baselineEntered;
      const repeated = f.owner.enrollBaseline!(identity, 2);
      const enrolled = f.owner.enroll(identity, 2);
      originals.push(repeated, enrolled);
      void repeated.then(
        () => {
          repeatedSettled = true;
        },
        () => {
          repeatedSettled = true;
        }
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(firstSettled).toBe(false);
      expect(repeatedSettled).toBe(false);
      expect(writing).toHaveBeenCalledTimes(1);
      await expect(
        f.owner.enroll({ ...identity, birth: 'darwin-bsd-start:11:2' }, 2)
      ).rejects.toThrow('LEAF_EVENT_OWNER_UNAVAILABLE');
      if (held === 'ack') f.releaseAck();
      else f.releaseWrite();
      expect((await first)?.complete).toBe(true);
      expect(await repeated).toBeUndefined();
      await enrolled;
      expect(await f.owner.enrollBaseline!(identity, 3)).toBeUndefined();
    } finally {
      if (held === 'ack') f.releaseAck();
      else f.releaseWrite();
      await Promise.allSettled(originals);
      f.release();
      await f.owner.close();
      writing.mockRestore();
    }
  });
it('never retries or returns a baseline after the entered native watch refuses', async () => {
  const f = await fixture({ admitted: false });
  const writing = vi.spyOn(f.stdin, 'write');
  let first: unknown;
  try {
    try {
      await f.owner.enrollBaseline!(identity, 2);
    } catch (value) {
      first = value;
    }
    expect(first).toBeInstanceOf(Error);
    if (!(first instanceof Error)) throw new Error('original-watch-refusal-missing');
    expect(first.message).toBe('LEAF_EVENT_BASELINE_UNAVAILABLE');
    expect(writing).toHaveBeenCalledTimes(1);
  } finally {
    f.release();
    await expect(f.owner.close()).rejects.toBe(first);
    writing.mockRestore();
  }
});

it.each([false, undefined])(
  'retains exact native watch refusal while original diagnostic writer throws %s',
  async (failure) => {
    const f = await fixture({ admitted: false, refusal: { reason: 'fork', error: 0 } });
    let originalFailure: unknown;
    try {
      try {
        await f.owner.enrollBaseline!(identity, 2);
      } catch (value) {
        originalFailure = value;
      }
      expect(originalFailure).toBeInstanceOf(Error);
      expect(originalFailure).toMatchObject({ message: 'LEAF_EVENT_BASELINE_UNAVAILABLE' });
      expect(originalLeafBaselineRefusal(originalFailure)).toEqual({ reason: 'fork', error: 0 });
      const row = projectOriginalObserverFailure(1, 'leaf-baseline', originalFailure);
      expect(row.leafRefusal).toEqual({ reason: 'fork', error: 0 });
      expect(Object.isFrozen(row.leafRefusal)).toBe(true);
      const sink = createOriginalObserverFailureSink(() => {
        throw failure;
      });
      expect(
        await sink(row).then(
          () => ({ ok: true }),
          (value) => ({ value })
        )
      ).toEqual({ value: failure });
      expect(originalLeafBaselineRefusal(originalFailure)).toEqual({ reason: 'fork', error: 0 });
      await expect(f.owner.enrollBaseline!(identity, 2)).rejects.toBe(originalFailure);
    } finally {
      f.release();
      await expect(f.owner.close()).rejects.toBe(originalFailure);
    }
  }
);
for (const refusal of [
  { reason: 'secret path', error: 0 },
  { reason: 'fork', error: -1 },
  { reason: 'exit', error: 2147483648 },
])
  it('refuses malformed native refusal ' + JSON.stringify(refusal), async () => {
    const f = await fixture({ admitted: false, refusal });
    try {
      await expect(f.owner.enrollBaseline!(identity, 2)).rejects.toThrow(
        'LEAF_EVENT_OWNER_UNAVAILABLE'
      );
    } finally {
      f.release();
      await expect(f.owner.close()).rejects.toThrow('LEAF_EVENT_OWNER_UNAVAILABLE');
    }
  });
it('bounds the longest refused ACK within the original reserved frame', () => {
  for (const reason of [
    'registration-return',
    'registration-flags',
    'registration-error',
    'census-incomplete',
  ])
    expect(
      Buffer.byteLength(
        JSON.stringify({ kind: 'watch', slot: 512, result: 'refused', reason, error: 2147483647 }) +
          '\n'
      )
    ).toBeLessThanOrEqual(128);
});
it('joins held native refusal ACK and write before exposing original reason', async () => {
  const f = await fixture({
    admitted: false,
    refusal: { reason: 'registration-error', error: 1 },
    holdAck: true,
    holdWrite: true,
  });
  const original = f.owner.enrollBaseline!(identity, 2);
  const observed = original.then(
    () => ({ ok: true }),
    (value) => ({ value })
  );
  let settled = false;
  void observed.then(() => {
    settled = true;
  });
  try {
    await f.baselineEntered;
    expect(settled).toBe(false);
    f.releaseAck();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    f.releaseWrite();
    const returned = await observed;
    if (!('value' in returned)) throw new Error('Original refusal missing');
    expect(originalLeafBaselineRefusal(returned.value)).toEqual({
      reason: 'registration-error',
      error: 1,
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify(projectOriginalObserverFailure(1, 'leaf-baseline', returned.value)) + '\n'
    );
    const row = readOriginalObserverFailure(bytes);
    expect(row?.leafRefusal).toEqual({ reason: 'registration-error', error: 1 });
    expect(Object.isFrozen(row?.leafRefusal)).toBe(true);
  } finally {
    f.releaseAck();
    f.releaseWrite();
    f.release();
    await Promise.allSettled([original, f.owner.close()]);
  }
});
