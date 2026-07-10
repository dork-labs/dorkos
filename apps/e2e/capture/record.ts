import path from 'path';
import fs from 'fs/promises';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { chromium, type Browser } from '@playwright/test';
import { bootStack, buildServerDeps, teardownAll } from './boot.js';
import { REPO_ROOT } from './config.js';
import { prepareFilesystem, seedData } from './seed.js';
import {
  createRunDir,
  createRunRecorder,
  finalizeShardedRun,
  mintRunId,
  type RunRecorder,
} from './library.js';
import { autoSkippedShotIds } from './overrides.js';
import { partitionShots, SHOTS } from './shots.js';
import { setAutoSkip, sleep } from './lib.js';
import { captureAgentDiscovery, captureLightStills, captureLoops } from './surfaces-desktop.js';
import { captureMobile } from './surfaces-mobile.js';

/**
 * The RECORD phase: boot a test-mode DorkOS stack, seed deterministic demo
 * data, drive the real UI through every money state, and save RAW, untouched
 * recordings and screenshots into the media library (`library/<run-id>/raw/` +
 * `run.json`). No editing happens here — the process phase (`process.ts`) owns
 * trim, seam, encode, and poster, so editing changes never require re-recording.
 *
 * With `--shards N` (N > 1) the shots are partitioned across N fully isolated
 * stacks — each its own server, Vite, ports, and `DORK_HOME` — recorded in
 * parallel, then merged into one run. Serial (`--shards 1`, the default) is the
 * historical single-stack path, unchanged.
 *
 * Run with: `pnpm --filter @dorkos/e2e capture:record [--shards N]`.
 *
 * @module capture/record
 */

/**
 * Drive every desktop and mobile surface into `rec`. Ordering is load-bearing:
 * mobile runs after the desktop loops (so the multi-session drives have filled
 * the sidebar), and agent-discovery runs dead last (it flips global onboarding
 * state, which every other shot needs left dismissed). A shard captures only its
 * assigned shots; the rest are skipped in place, preserving this ordering.
 */
export async function driveCaptures(browser: Browser, rec: RunRecorder): Promise<void> {
  await captureLightStills(browser, rec);
  await captureLoops(browser, rec);
  await captureMobile(browser, rec);
  await captureAgentDiscovery(browser, rec);
}

/**
 * Boot one stack, seed it, open the run recorder, and drive the assigned
 * captures into it, tearing the stack down afterwards. Shared by the serial
 * path and each shard worker; the caller supplies the recorder factory (called
 * only after boot + seed succeed, so a boot failure never leaves an empty run
 * dir) and owns finalization of the returned recorder.
 *
 * The spawned server/Vite live in their own process groups (see `boot.ts`), so
 * a terminal Ctrl-C no longer reaches them directly — SIGINT/SIGTERM handlers
 * installed for the duration of the boot-drive window tear everything down
 * (`teardownAll`) and exit non-zero, on the serial path and in shard workers
 * alike.
 */
export async function bootSeedAndDrive(
  makeRecorder: () => Promise<RunRecorder>
): Promise<RunRecorder> {
  const onSignal = () => {
    teardownAll();
    process.exit(1);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const stack = await bootStack();
  let browser: Browser | undefined;
  try {
    process.stdout.write('▸ Seeding demo data…\n');
    await seedData();
    const rec = await makeRecorder();
    process.stdout.write(`▸ Recording raws (run ${rec.runId})…\n`);
    browser = await chromium.launch();
    await driveCaptures(browser, rec);
    return rec;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (browser) await browser.close();
    stack.teardown();
    // Give child processes a moment to exit before the event loop drains.
    await sleep(500);
  }
}

/** The single-stack record path (serial `--shards 1`, the historical behavior). */
async function runSerialRecord(): Promise<string> {
  process.stdout.write('▸ Preparing filesystem…\n');
  await prepareFilesystem();

  // Shots whose media a human override supplies (skipAuto) are never driven.
  const skip = await autoSkippedShotIds();
  setAutoSkip(skip);
  if (skip.size > 0) {
    process.stdout.write(
      `▸ Skipping ${skip.size} shot(s) supplied by overrides: ${[...skip].join(', ')}\n`
    );
  }

  process.stdout.write('▸ Building server deps…\n');
  await buildServerDeps();
  process.stdout.write('▸ Booting test-mode stack…\n');
  const rec = await bootSeedAndDrive(createRunRecorder);
  await rec.finalize();
  return rec.runId;
}

/** A spawned shard worker plus a promise for its completion and a group kill. */
interface ShardProcess {
  readonly done: Promise<void>;
  kill(): void;
}

/** Spawn one shard worker (`record-shard.ts`) for `shotIds` on shard `index`. */
function spawnShard(index: number, runId: string, runDir: string, shotIds: string[]): ShardProcess {
  const child: ChildProcess = spawn(
    'pnpm',
    ['--filter', '@dorkos/e2e', 'exec', 'tsx', 'capture/record-shard.ts'],
    {
      cwd: REPO_ROOT,
      // Own process group so kill() can signal the whole shard subtree.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        // eslint-disable-next-line no-restricted-syntax -- the shard worker needs the inherited environment; the capture harness has no env.ts
        ...process.env,
        CAPTURE_SHARD: String(index),
        CAPTURE_RUN_ID: runId,
        CAPTURE_RUN_DIR: runDir,
        CAPTURE_SHOTS: shotIds.join(','),
      },
    }
  );
  prefixShardLogs(child, index);

  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`shard ${index} failed (exit ${code ?? 'signal'})`))
    );
  });

  return {
    done,
    kill() {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    },
  };
}

/** Stream a shard's stdout/stderr to ours, one prefixed line at a time. */
function prefixShardLogs(child: ChildProcess, index: number): void {
  const tag = `[s${index}] `;
  const pipe = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream) => {
    let buffer = '';
    stream?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) sink.write(`${tag}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
}

/**
 * The parallel record path: build once, partition the shots across `shardCount`
 * isolated stacks, record them in parallel, then merge every shard's raws into a
 * single run. On any failure — or on the way out regardless — every shard
 * process (and its stack) is torn down, so nothing is left holding a port.
 */
async function runShardedRecord(shardCount: number): Promise<string> {
  const skip = await autoSkippedShotIds();
  const shots = SHOTS.filter((s) => !skip.has(s.id));
  const partition = partitionShots(shots, shardCount);

  const runId = await mintRunId();
  const runDir = await createRunDir(runId);
  process.stdout.write(`▸ Sharded record (run ${runId}, ${shardCount} shards)…\n`);
  partition.forEach((ids, i) => process.stdout.write(`  · shard ${i}: ${ids.join(', ') || '—'}\n`));

  process.stdout.write('▸ Building server deps (once)…\n');
  await buildServerDeps();

  const shards = partition.map((ids, i) => spawnShard(i, runId, runDir, ids));
  const killAll = () => {
    for (const s of shards) s.kill();
  };
  // A Ctrl-C (SIGINT) or SIGTERM kills this process without running the finally
  // below; the shard workers run in their own process groups, so without this
  // they would orphan. Signal them explicitly, then exit non-zero.
  const onSignal = () => {
    killAll();
    process.exit(1);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await Promise.all(shards.map((s) => s.done));
  } catch (err) {
    // A failed record must not leave a partial run (no run.json) in the
    // library — it would shadow real runs in listings and confuse retention.
    // Stop the surviving shards first so nothing is mid-write during the rm.
    killAll();
    await sleep(1000);
    await fs.rm(runDir, { recursive: true, force: true });
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    killAll();
  }

  process.stdout.write('▸ Merging shard raws…\n');
  await finalizeShardedRun(runId, runDir);
  return runId;
}

/**
 * Record one full run into the library and return its run id. `shardCount > 1`
 * runs the parallel path; otherwise the serial single-stack path.
 */
export async function runRecordPhase(shardCount = 1): Promise<string> {
  return shardCount > 1 ? runShardedRecord(shardCount) : runSerialRecord();
}

/** Parse `--shards N` from argv (default 1, floored at 1). */
export function parseShardCount(argv: string[]): number {
  const i = argv.indexOf('--shards');
  if (i === -1) return 1;
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runRecordPhase(parseShardCount(process.argv.slice(2))).catch((err) => {
    process.stderr.write(`Record failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}
