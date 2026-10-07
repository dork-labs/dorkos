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
  hasOriginalLeafTerminal,
  openDarwinLeafEventOwner,
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
    holdReturn?: boolean;
    onEnd?(): void;
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
    stdout.write(JSON.stringify({ kind, slot, result }) + '\n');
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      const fields = chunk.toString().trim().split(' ');
      if (fields[0] === 'W') {
        if (options.beforeAck) row('event', Number(fields[1]), options.beforeAck);
        row('watch', Number(fields[1]), options.admitted === false ? 'refused' : 'leaf');
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
  return { owner, row, release, stdout, stdin };
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

for (const fault of ['exit', 'fork-then-reparent', 'unknown-inspect', 'retained-orphan'] as const)
  it(`runs genuine durable journal leaf transition ${fault}`, async () => {
    const f = await durableFixture();
    const events = await fixture();
    let round = 0,
      clock = 10;
    const checkpoints: JournalSnapshot[] = [];
    const boot = { version: 1 as const, bootSeconds: '1', bootMicroseconds: '0' };
    const observer: DarwinProcessObserver = {
      async inspect(pids) {
        return {
          ...boot,
          processes: pids.map((pid) => {
            if (round >= 4) return { kind: 'absent' as const, pid };
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
        const identity = parent.pid === 20 ? f.rootNative : f.childNative;
        if (parent.pid === 30 && round === 3) return failedCensus();
        if (parent.pid === 30 && round === 2 && fault === 'retained-orphan')
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
          if (round === 3 && fault !== 'retained-orphan') {
            if (fault === 'fork-then-reparent') events.row('event', 1, 'fork');
            events.row('event', 1, 'exit');
          }
          if (round > 5) clock = 1001;
        },
      });
      const read = await readJournal(f.location);
      expect(read.state).toBe('valid-recorded-data');
      if (read.state !== 'valid-recorded-data') throw new Error('original-journal-missing');
      if (fault === 'exit') {
        expect(read.snapshot.gaps).toEqual([]);
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
      } else
        expect(
          read.snapshot.gaps.some(
            (gap) =>
              gap.cause ===
              (fault === 'unknown-inspect' ? 'identity-unknown' : 'association-missing')
          )
        ).toBe(true);
    } finally {
      events.release();
      try {
        await events.owner.close();
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
