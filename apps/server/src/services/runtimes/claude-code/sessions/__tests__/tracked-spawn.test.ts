import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { createTrackedSpawn } from '../tracked-spawn.js';
import { WarmProcessLedger, systemProcessProbe } from '../warm-process-ledger.js';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let dorkHome: string;
let spawned: SpawnedProcess | undefined;

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tracked-spawn-'));
});

afterEach(() => {
  // Only ever the child this test started, only ever through its own handle.
  if (spawned && spawned.exitCode === null && !spawned.killed) spawned.kill('SIGKILL');
  spawned = undefined;
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

/** The shape the SDK hands a custom spawner, filled in for a plain node child. */
function optionsFor(script: string): SpawnOptions {
  return {
    command: process.execPath,
    args: ['-e', script],
    cwd: dorkHome,
    env: { ...process.env },
    signal: new AbortController().signal,
  };
}

describe('createTrackedSpawn', () => {
  it('records the child in the ledger before handing it back', () => {
    const ledger = new WarmProcessLedger(dorkHome);

    spawned = createTrackedSpawn(ledger)(optionsFor('setTimeout(() => {}, 30000)'));

    const recorded = ledger.read()?.processes ?? [];
    expect(recorded).toHaveLength(1);
    // The recorded proof is the real start time of the real process, not a
    // timestamp we invented — that equality is what the reaper stands on.
    expect(recorded[0]?.startedAt).toBe(systemProcessProbe.startTimeOf(recorded[0]?.pid ?? 0));
  });

  it('forgets the child when it exits, so the ledger shrinks as processes go', async () => {
    const ledger = new WarmProcessLedger(dorkHome);

    spawned = createTrackedSpawn(ledger)(optionsFor('process.exit(0)'));

    await vi.waitFor(() => {
      expect(ledger.read()?.processes ?? []).toEqual([]);
    });
  });

  it('says when the child starts and when that child exits, cleanly or killed (DOR-4209)', async () => {
    const ledger = new WarmProcessLedger(dorkHome);
    const cleanExit = vi.fn();
    const started = vi.fn(() => cleanExit);
    createTrackedSpawn(ledger, started)(optionsFor('process.exit(0)'));
    expect(started).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(cleanExit).toHaveBeenCalledTimes(1));

    const killed = vi.fn();
    spawned = createTrackedSpawn(ledger, () => killed)(optionsFor('setTimeout(() => {}, 30000)'));
    expect(killed).not.toHaveBeenCalled();
    spawned.kill('SIGKILL');
    await vi.waitFor(() => expect(killed).toHaveBeenCalledTimes(1));
  });

  it('never lets a lifecycle callback that throws break the spawn or the exit', async () => {
    const ledger = new WarmProcessLedger(dorkHome);
    const { logger } = await import('../../../../../lib/logger.js');
    vi.mocked(logger.warn).mockClear();
    // Throws at spawn: the child is still handed back, recorded, and forgotten on exit.
    const child = createTrackedSpawn(ledger, () => {
      throw new Error('/secret/path at spawn');
    })(optionsFor('process.exit(0)'));
    expect(child.pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(ledger.read()?.processes ?? []).toEqual([]));
    // Throws at exit: the exit still forgets the child.
    createTrackedSpawn(ledger, () => () => {
      throw new Error('/secret/path at exit');
    })(optionsFor('process.exit(0)'));
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        '[tracked-spawn] a process lifecycle callback failed',
        {
          when: 'exit',
          error: 'Error',
        }
      )
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[tracked-spawn] a process lifecycle callback failed',
      {
        when: 'spawn',
        error: 'Error',
      }
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toMatch(/secret/);
    await vi.waitFor(() => expect(ledger.read()?.processes ?? []).toEqual([]));
  });

  it('gives the SDK a usable process: stdin, stdout, exit and kill all work', async () => {
    const ledger = new WarmProcessLedger(dorkHome);
    spawned = createTrackedSpawn(ledger)(
      optionsFor('process.stdin.on("data", (d) => process.stdout.write("echo:" + d))')
    );

    const seen = await new Promise<string>((resolve) => {
      spawned?.stdout.on('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
      spawned?.stdin.write('ping');
    });
    expect(seen).toBe('echo:ping');

    const exited = new Promise<void>((resolve) => spawned?.once('exit', () => resolve()));
    expect(spawned.kill('SIGKILL')).toBe(true);
    await exited;
    expect(spawned.killed).toBe(true);
  });

  it('drains the child’s stderr rather than letting a full pipe block it', async () => {
    const ledger = new WarmProcessLedger(dorkHome);
    // Far more than the 64 KB pipe buffer, written SYNCHRONOUSLY — `fs.writeSync`
    // rather than `console.error`, because writes to a pipe are async in Node
    // and would be discarded at exit instead of ever filling it. A spawner that
    // never reads stderr wedges the child here, and the exit never arrives.
    spawned = createTrackedSpawn(ledger)(
      optionsFor(
        'const fs = require("fs"); for (let i = 0; i < 4000; i++) fs.writeSync(2, "x".repeat(100) + "\\n");'
      )
    );

    const code = await new Promise<number | null>((resolve) => {
      spawned?.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(0);
  }, 15_000);
});
