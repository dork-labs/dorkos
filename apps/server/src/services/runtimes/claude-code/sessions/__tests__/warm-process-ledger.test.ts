import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WarmProcessLedger,
  graceSleep,
  reapOrphanedWarmProcesses,
  systemProcessProbe,
  type ProcessProbe,
} from '../warm-process-ledger.js';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** A scriptable operating system: what is alive, when it started, what we hit. */
function fakeProbe(
  processes: Record<number, { startedAt: string; ppid?: number }>
): ProcessProbe & { signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> } {
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  return {
    signals,
    startTimeOf: (pid) => processes[pid]?.startedAt ?? null,
    processTable: () => {
      const table = new Map<number, number>();
      for (const [pid, info] of Object.entries(processes)) table.set(Number(pid), info.ppid ?? 1);
      return table;
    },
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      const alive = processes[pid] !== undefined;
      // A real SIGTERM/SIGKILL ends the process, so the fake does too — which is
      // what lets the grace loop terminate.
      if (alive && signal !== 0) delete processes[pid];
      return alive;
    },
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

let dorkHome: string;

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-ledger-'));
});

afterEach(() => {
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

/** Write a ledger by hand, standing in for a server that was killed outright. */
function seedLedger(
  owner: { pid: number; startedAt: string },
  processes: Array<{ pid: number; startedAt: string }>
): WarmProcessLedger {
  const ledger = new WarmProcessLedger(dorkHome);
  fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
  fs.writeFileSync(ledger.path, JSON.stringify({ owner, processes }));
  return ledger;
}

describe('WarmProcessLedger', () => {
  it('records a spawned pid with the start time the probe reports', () => {
    const probe = fakeProbe({ [process.pid]: { startedAt: 'boot' }, 4242: { startedAt: 'then' } });
    const ledger = new WarmProcessLedger(dorkHome, probe);

    ledger.record(4242);

    expect(ledger.read()).toEqual({
      owner: { pid: process.pid, startedAt: 'boot' },
      processes: [{ pid: 4242, startedAt: 'then' }],
    });
  });

  it('does not record a pid whose start time cannot be read', () => {
    // The Windows path: no `ps`, so no proof, so no record to act on later.
    const probe = fakeProbe({ [process.pid]: { startedAt: 'boot' } });
    const ledger = new WarmProcessLedger(dorkHome, probe);

    ledger.record(4242);

    expect(ledger.read()).toBeNull();
  });

  it('forgets a pid that exited, leaving the rest', () => {
    const probe = fakeProbe({
      [process.pid]: { startedAt: 'boot' },
      1: { startedAt: 'a' },
      2: { startedAt: 'b' },
    });
    const ledger = new WarmProcessLedger(dorkHome, probe);
    ledger.record(1);
    ledger.record(2);

    ledger.forget(1);

    expect(ledger.read()?.processes).toEqual([{ pid: 2, startedAt: 'b' }]);
  });

  it('survives a truncated file by reading it as no ledger at all', () => {
    const ledger = new WarmProcessLedger(dorkHome);
    fs.mkdirSync(path.dirname(ledger.path), { recursive: true });
    fs.writeFileSync(ledger.path, '{"owner": {"pid": 1');

    expect(ledger.read()).toBeNull();
  });
});

describe('reapOrphanedWarmProcesses', () => {
  it('ends a recorded process whose start time still matches', async () => {
    const probe = fakeProbe({ 900: { startedAt: 'spawned-at-noon' } });
    const ledger = seedLedger({ pid: 800, startedAt: 'gone' }, [
      { pid: 900, startedAt: 'spawned-at-noon' },
    ]);

    const report = await reapOrphanedWarmProcesses({ ledger, probe, sleep: noSleep });

    expect(report.reaped).toEqual([900]);
    expect(probe.signals).toContainEqual({ pid: 900, signal: 'SIGTERM' });
  });

  it('leaves a recycled pid alone — the start time is the whole proof', async () => {
    // Pid 900 is alive, but it is somebody else's process now: it started after
    // the one we recorded, so its `lstart` differs.
    const probe = fakeProbe({ 900: { startedAt: 'started-much-later' } });
    const ledger = seedLedger({ pid: 800, startedAt: 'gone' }, [
      { pid: 900, startedAt: 'spawned-at-noon' },
    ]);

    const report = await reapOrphanedWarmProcesses({ ledger, probe, sleep: noSleep });

    expect(report.reaped).toEqual([]);
    expect(report.skipped).toEqual([900]);
    expect(probe.signals).toEqual([]);
  });

  it('leaves a pid alone when the platform cannot report a start time', async () => {
    const probe = fakeProbe({});
    const ledger = seedLedger({ pid: 800, startedAt: 'gone' }, [{ pid: 900, startedAt: 'noon' }]);

    const report = await reapOrphanedWarmProcesses({ ledger, probe, sleep: noSleep });

    expect(report.reaped).toEqual([]);
    expect(probe.signals).toEqual([]);
  });

  it('sweeps nothing while another live server still owns the ledger', async () => {
    const probe = fakeProbe({
      800: { startedAt: 'still-running' },
      900: { startedAt: 'noon' },
    });
    const ledger = seedLedger({ pid: 800, startedAt: 'still-running' }, [
      { pid: 900, startedAt: 'noon' },
    ]);

    const report = await reapOrphanedWarmProcesses({ ledger, probe, sleep: noSleep });

    expect(report.declined).toBe('owner-alive');
    expect(probe.signals).toEqual([]);
    // And the live owner keeps its ledger, so ITS next boot can still sweep.
    expect(ledger.read()?.processes).toEqual([{ pid: 900, startedAt: 'noon' }]);
  });

  it('never touches another data directory’s records', async () => {
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-ledger-other-'));
    try {
      const otherLedger = new WarmProcessLedger(
        otherHome,
        fakeProbe({ [process.pid]: { startedAt: 'boot' }, 900: { startedAt: 'noon' } })
      );
      otherLedger.record(900);
      const probe = fakeProbe({ 900: { startedAt: 'noon' } });

      // This home has no ledger at all, so its sweep has nothing to act on —
      // pid 900 belongs to the other home and is invisible here.
      const report = await reapOrphanedWarmProcesses({
        ledger: new WarmProcessLedger(dorkHome, probe),
        probe,
        sleep: noSleep,
      });

      expect(report.declined).toBe('no-ledger');
      expect(probe.signals).toEqual([]);
      expect(otherLedger.read()?.processes).toEqual([{ pid: 900, startedAt: 'noon' }]);
    } finally {
      fs.rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it('clears the ledger whether or not anything was reaped', async () => {
    const probe = fakeProbe({});
    const ledger = seedLedger({ pid: 800, startedAt: 'gone' }, [{ pid: 900, startedAt: 'noon' }]);

    await reapOrphanedWarmProcesses({ ledger, probe, sleep: noSleep });

    expect(ledger.read()).toBeNull();
    expect(fs.existsSync(ledger.path)).toBe(false);
  });

  it('ends the descendants of a proven-owned root, deepest first', async () => {
    const probe = fakeProbe({
      900: { startedAt: 'noon', ppid: 1 },
      901: { startedAt: 'noon', ppid: 900 },
      902: { startedAt: 'noon', ppid: 901 },
      // An unrelated process with the same start time, parented elsewhere.
      950: { startedAt: 'noon', ppid: 1 },
    });
    const ledger = seedLedger({ pid: 800, startedAt: 'gone' }, [{ pid: 900, startedAt: 'noon' }]);

    await reapOrphanedWarmProcesses({ ledger, probe, sleep: noSleep });

    const hit = probe.signals.filter((s) => s.signal !== 0).map((s) => s.pid);
    expect(hit).toContain(902);
    expect(hit).toContain(901);
    expect(hit).not.toContain(950);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const stubborn: ProcessProbe & { signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> } =
      {
        signals: [],
        startTimeOf: (pid) => (pid === 900 ? 'noon' : null),
        processTable: () => new Map([[900, 1]]),
        signal(pid, signal) {
          this.signals.push({ pid, signal });
          return true;
        },
      };
    const ledger = seedLedger({ pid: 800, startedAt: 'gone' }, [{ pid: 900, startedAt: 'noon' }]);

    await reapOrphanedWarmProcesses({ ledger, probe: stubborn, sleep: noSleep });

    expect(stubborn.signals).toContainEqual({ pid: 900, signal: 'SIGTERM' });
    expect(stubborn.signals).toContainEqual({ pid: 900, signal: 'SIGKILL' });
  });
});

describe('graceSleep', () => {
  it('holds the event loop open while it waits', async () => {
    // The sweep runs at the very top of boot, before the HTTP listener and
    // before any other handle exists. An `unref`'d timer would be the only
    // thing keeping the loop alive, and Node answers an empty loop by exiting
    // silently with status 0 — which is exactly what a first cut of this did:
    // a server with orphans to reap quit during the reap and never started.
    // `getActiveResourcesInfo` lists only resources that KEEP THE LOOP ALIVE,
    // so an unref'd timer is invisible to it and this goes red.
    const countTimers = (): number =>
      process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

    const before = countTimers();
    const waiting = graceSleep(20);
    expect(countTimers()).toBeGreaterThan(before);

    await waiting;
  });
});

describe('reapOrphanedWarmProcesses against a real process', () => {
  let child: ChildProcess | undefined;

  afterEach(() => {
    // Only ever our own child, only ever by the pid we hold.
    if (child?.pid !== undefined && child.exitCode === null) child.kill('SIGKILL');
    child = undefined;
  });

  it('kills a process this test spawned, and spares it when the ledger lies', async () => {
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    const startedAt = systemProcessProbe.startTimeOf(pid);
    expect(startedAt).not.toBeNull();

    // First, the safety property: a ledger claiming a DIFFERENT start time for
    // this very pid must leave it running. This is the guard that stands
    // between the reaper and an unrelated process wearing a recycled pid.
    const lying = seedLedger({ pid: 1, startedAt: 'a-dead-server' }, [
      { pid, startedAt: 'Mon Jan 1 00:00:00 2001' },
    ]);
    const spared = await reapOrphanedWarmProcesses({ ledger: lying, sleep: noSleep });
    expect(spared.reaped).toEqual([]);
    expect(child.exitCode).toBeNull();
    expect(systemProcessProbe.startTimeOf(pid)).not.toBeNull();

    // Now the truthful ledger: the same pid, with the start time we really read.
    const truthful = seedLedger({ pid: 1, startedAt: 'a-dead-server' }, [
      { pid, startedAt: startedAt as string },
    ]);
    const report = await reapOrphanedWarmProcesses({ ledger: truthful });

    expect(report.reaped).toEqual([pid]);
    await vi.waitFor(() => {
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    });
  }, 15_000);
});
