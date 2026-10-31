/**
 * One chat, one live agent process, across a restart (DOR-3049).
 *
 * A restart could leave a chat's old process running beside the one the next
 * boot woke for it. Both holes were in how the old process is written down and
 * found again, so these drive the ledger, the spawn seam and the boot sweep
 * together: an old process that survives a restart is ended before anything is
 * woken, two wakes for one chat start one process, and a normal wake is
 * untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import {
  WarmProcessLedger,
  reapOrphanedWarmProcesses,
  systemProcessProbe,
  type ProcessProbe,
} from '../warm-process-ledger.js';
import { createTrackedSpawn } from '../tracked-spawn.js';
import {
  SessionPumpRegistry,
  shutdownSessionPumps,
  type AcquirePumpOptions,
} from '../session-pump-registry.js';
import { FakeQuery, initMessage } from './fake-pump-query.js';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** A scriptable operating system: what is alive, when it started, what we hit. */
function fakeProbe(processes: Record<number, string>): ProcessProbe & {
  processes: Record<number, string>;
  signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }>;
} {
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  return {
    processes,
    signals,
    startTimeOf: (pid) => processes[pid] ?? null,
    processTable: () => new Map(Object.keys(processes).map((pid) => [Number(pid), 1])),
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      const alive = processes[pid] !== undefined;
      if (alive && signal !== 0) delete processes[pid];
      return alive;
    },
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

let dorkHome: string;
let spawned: SpawnedProcess | undefined;

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'one-live-process-'));
});

afterEach(async () => {
  vi.useRealTimers();
  if (spawned && spawned.exitCode === null && !spawned.killed) spawned.kill('SIGKILL');
  spawned = undefined;
  await shutdownSessionPumps();
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('restart with a surviving old process', () => {
  it('still records processes after one failed read of the server’s own start time', async () => {
    // Boot, on a loaded machine: the first `ps` of our own pid times out. That
    // used to be remembered as "cannot say" for the server's whole life.
    const probe = fakeProbe({ 4242: 'warm-a', 4343: 'warm-b' });
    const ledger = new WarmProcessLedger(dorkHome, probe);
    expect(ledger.record(4242)).toBe(false);

    // A moment later `ps` answers again, and the next chat's process is spawned.
    probe.processes[process.pid] = 'server-boot';
    expect(ledger.record(4343)).toBe(true);

    // The server is killed outright with that process still running. The next
    // boot finds it and ends it, so the chat it then wakes is the only one.
    delete probe.processes[process.pid];
    const report = await reapOrphanedWarmProcesses({
      ledger: new WarmProcessLedger(dorkHome, probe),
      probe,
      sleep: noSleep,
    });
    expect(report.reaped).toEqual([4343]);
    expect(probe.processes[4343]).toBeUndefined();
  });

  it('waits for the server it replaces to exit, then ends what it left running', async () => {
    // The predecessor gave the lock back and is still exiting; one of its
    // processes outlived its shutdown.
    const probe = fakeProbe({ 600: 'old-server', 700: 'old-warm' });
    const ledger = new WarmProcessLedger(dorkHome, probe);
    fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
    fs.writeFileSync(
      ledger.path,
      JSON.stringify({
        owner: { pid: 600, startedAt: 'old-server' },
        processes: [{ pid: 700, startedAt: 'old-warm' }],
      })
    );
    let polls = 0;
    const sleep = async (): Promise<void> => {
      polls += 1;
      if (polls === 3) delete probe.processes[600];
    };

    const report = await reapOrphanedWarmProcesses({
      ledger,
      probe,
      sleep,
      ownerExitWaitMs: 60_000,
    });

    expect(report.declined).toBeUndefined();
    expect(report.reaped).toEqual([700]);
    expect(probe.signals).toContainEqual({ pid: 700, signal: 'SIGTERM' });
    expect(probe.signals.some((entry) => entry.pid === 600 && entry.signal !== 0)).toBe(false);
  });

  it('still leaves a server that does not exit alone, and keeps its ledger', async () => {
    // With the lock switched off a live owner really can be a second server.
    const probe = fakeProbe({ 600: 'other-server', 700: 'its-warm' });
    const ledger = new WarmProcessLedger(dorkHome, probe);
    fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
    fs.writeFileSync(
      ledger.path,
      JSON.stringify({
        owner: { pid: 600, startedAt: 'other-server' },
        processes: [{ pid: 700, startedAt: 'its-warm' }],
      })
    );

    const report = await reapOrphanedWarmProcesses({
      ledger,
      probe,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ownerExitWaitMs: 250,
    });

    expect(report.declined).toBe('owner-alive');
    expect(probe.signals.filter((entry) => entry.signal !== 0)).toEqual([]);
    expect(ledger.read()?.processes).toEqual([{ pid: 700, startedAt: 'its-warm' }]);
  });
});

describe('the spawn seam records a process its first try could not', () => {
  /** The real OS, except the first read of any child's start time fails. */
  function flakyFirstRead(): ProcessProbe {
    const failed = new Set<number>();
    return {
      ...systemProcessProbe,
      startTimeOf: (pid) => {
        if (pid !== process.pid && !failed.has(pid)) {
          failed.add(pid);
          return null;
        }
        return systemProcessProbe.startTimeOf(pid);
      },
    };
  }

  function optionsFor(script: string): SpawnOptions {
    return {
      command: process.execPath,
      args: ['-e', script],
      cwd: dorkHome,
      env: { ...process.env },
      signal: new AbortController().signal,
    };
  }

  it('writes it down on a later try while it runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const ledger = new WarmProcessLedger(dorkHome, flakyFirstRead());

    spawned = createTrackedSpawn(ledger)(optionsFor('setTimeout(() => {}, 30000)'));
    expect(ledger.read()).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);

    // The seam hands back the real child; the SDK's type just does not name `pid`.
    const pid = (spawned as unknown as ChildProcess).pid ?? 0;
    const recorded = ledger.read()?.processes ?? [];
    expect(recorded.map((entry) => entry.pid)).toEqual([pid]);
    expect(recorded[0]?.startedAt).toBe(systemProcessProbe.startTimeOf(pid));
  });

  it('never writes down a child that has already exited', async () => {
    const ledger = new WarmProcessLedger(dorkHome, flakyFirstRead());

    spawned = createTrackedSpawn(ledger)(optionsFor('process.exit(0)'));
    await new Promise<void>((resolve) => spawned?.once('exit', () => resolve()));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(ledger.read()?.processes ?? []).toEqual([]);
  });
});

describe('two wakes for one chat', () => {
  function launchOpts(queries: FakeQuery[]): AcquirePumpOptions {
    return {
      maxWarmSessions: 12,
      warmIdleMs: 5 * 60 * 1000,
      slotWaitMs: 0,
      launch: () => {
        const query = new FakeQuery();
        queries.push(query);
        queueMicrotask(() => query.emit(initMessage()));
        return query;
      },
      drainGraceMs: 20,
    };
  }

  it('starts one process when the restart wake and a room seat arrive together', async () => {
    // The restart wake asks by the transcript id, the room seat by the key the
    // pump was filed under; both resolve to the same chat.
    const registry = new SessionPumpRegistry((id) => (id === 'transcript-1' ? 'key-1' : id));
    const queries: FakeQuery[] = [];

    const wake = registry.acquire('transcript-1', launchOpts(queries));
    const seat = registry.acquire('key-1', launchOpts(queries));
    await Promise.all([
      wake.dispatch([{ content: 'restart wake', messageId: 'm-wake' }]),
      seat.warm(),
    ]);

    expect(seat).toBe(wake);
    expect(queries).toHaveLength(1);
    expect(registry.liveCount()).toBe(1);
  });

  it('a normal wake still starts its process and runs the turn', async () => {
    const registry = new SessionPumpRegistry((id) => id);
    const queries: FakeQuery[] = [];

    const pump = registry.acquire('s1', launchOpts(queries));
    await pump.dispatch([{ content: 'hello', messageId: 'm-1' }]);

    expect(queries).toHaveLength(1);
    expect(registry.warmth('s1')).toBe('running');
  });
});
