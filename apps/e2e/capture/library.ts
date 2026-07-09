import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  DESKTOP_VIEWPORT,
  DEVICE_SCALE_FACTOR,
  LIBRARY_ROOT,
  MOBILE_SCALE_FACTOR,
  MOBILE_VIEWPORT,
  REPO_ROOT,
  type Theme,
} from './config.js';

/**
 * The capture media library — the record phase's raw sink and the process
 * phase's source. Like an editor's source bins, every record run lands its
 * untouched recordings and screenshots under `library/<run-id>/raw/` next to a
 * `run.json` provenance manifest; processing never mutates raws, so editing
 * changes (trim, seam, encode) are re-process-only and need no re-recording.
 * The library is gitignored (raws are heavy and regenerable); only its README
 * is committed.
 *
 * @module capture/library
 */

/** How many record runs the library retains; older runs are pruned. */
export const RETAINED_RUNS = 3;

/** Name of the symlink pointing at the newest run. */
const LATEST_LINK = 'latest';

/** Run directories look like `20260706-203000` (a second-resolution timestamp). */
const RUN_ID_PATTERN = /^\d{8}-\d{6}(-\d+)?$/;

/** A raw asset recorded into a run. */
export type RawAsset =
  | {
      kind: 'still';
      /** File name inside the run's `raw/` dir. */
      file: string;
      surface: string;
      theme: Theme;
    }
  | {
      kind: 'loop';
      /** File name inside the run's `raw/` dir. */
      file: string;
      surface: string;
      /** Loops are recorded dark-only. */
      theme: 'dark';
      /** Recorded (and target) pixel width. */
      width: number;
      /** Recorded (and target) pixel height. */
      height: number;
      /** Trim marker: ms of pre-action footage to cut at process time. */
      headTrimMs: number;
    };

/** `run.json` — full provenance for one record run. */
export interface RunManifest {
  runId: string;
  recordedAt: string;
  /** Git HEAD of the app that was on film. */
  appGitSha: string;
  /** Content hashes of the files that define what the scenarios showed. */
  sources: Record<string, string>;
  /** Capture settings the run was recorded with. */
  settings: {
    desktopViewport: { width: number; height: number };
    deviceScaleFactor: number;
    mobileViewport: { width: number; height: number };
    mobileScaleFactor: number;
  };
  assets: RawAsset[];
}

/** Files hashed into `run.json` for provenance (paths relative to the repo root). */
const PROVENANCE_SOURCES = [
  'apps/e2e/capture/config.ts',
  'apps/server/src/services/runtimes/test-mode/demo-scenarios.ts',
] as const;

/** The record phase's raw sink for one run. */
export interface RunRecorder {
  readonly runId: string;
  /** Save a raw screenshot buffer, untouched. */
  saveStill(buffer: Buffer, surface: string, theme: Theme): Promise<void>;
  /** Copy a raw Playwright recording into the run, untouched. */
  saveLoop(
    sourcePath: string,
    options: { surface: string; width: number; height: number; headTrimMs: number }
  ): Promise<void>;
  /** Write `run.json`, point `latest` at this run, and prune old runs. */
  finalize(): Promise<void>;
}

/** Mint a unique run id from the wall clock, suffixing on same-second collision. */
export async function mintRunId(): Promise<string> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const base =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let candidate = base;
  for (let seq = 2; ; seq++) {
    try {
      await fs.access(path.join(LIBRARY_ROOT, candidate));
      candidate = `${base}-${seq}`;
    } catch {
      return candidate;
    }
  }
}

/** SHA-256 hex of a repo file's content. */
async function hashSource(relPath: string): Promise<string> {
  const content = await fs.readFile(path.join(REPO_ROOT, relPath));
  return createHash('sha256').update(content).digest('hex');
}

/** List run directories in the library, newest first (ids sort lexically). */
async function listRuns(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(LIBRARY_ROOT);
  } catch {
    return [];
  }
  return entries.filter((e) => RUN_ID_PATTERN.test(e)).sort((a, b) => b.localeCompare(a));
}

/** Delete runs beyond {@link RETAINED_RUNS} and report what was pruned. */
async function pruneOldRuns(): Promise<void> {
  const runs = await listRuns();
  const stale = runs.slice(RETAINED_RUNS);
  for (const runId of stale) {
    await fs.rm(path.join(LIBRARY_ROOT, runId), { recursive: true, force: true });
  }
  if (stale.length > 0) {
    process.stdout.write(
      `  · library: pruned ${stale.length} old run(s) (${stale.join(', ')}); keeping last ${RETAINED_RUNS}\n`
    );
  }
}

/** Point the `latest` symlink at `runId` (relative, replacing any existing link). */
async function updateLatestLink(runId: string): Promise<void> {
  const link = path.join(LIBRARY_ROOT, LATEST_LINK);
  await fs.rm(link, { force: true });
  await fs.symlink(runId, link);
}

/** A raw sink writing into `rawDir` and accumulating its asset records. */
interface RawSink {
  readonly assets: RawAsset[];
  saveStill(buffer: Buffer, surface: string, theme: Theme): Promise<void>;
  saveLoop(
    sourcePath: string,
    options: { surface: string; width: number; height: number; headTrimMs: number }
  ): Promise<void>;
}

/** Build a raw sink over `rawDir` — the shared write path for serial and shard recorders. */
function makeRawSink(rawDir: string): RawSink {
  const assets: RawAsset[] = [];
  return {
    assets,
    async saveStill(buffer, surface, theme) {
      const file = `${surface}-${theme}.png`;
      await fs.writeFile(path.join(rawDir, file), buffer);
      assets.push({ kind: 'still', file, surface, theme });
    },
    async saveLoop(sourcePath, options) {
      const file = `${options.surface}-dark.webm`;
      await fs.copyFile(sourcePath, path.join(rawDir, file));
      assets.push({ kind: 'loop', file, theme: 'dark', ...options });
    },
  };
}

/** Write `run.json` for a completed run, point `latest` at it, and prune old runs. */
async function writeRunManifest(runId: string, runDir: string, assets: RawAsset[]): Promise<void> {
  const sources: Record<string, string> = {};
  for (const rel of PROVENANCE_SOURCES) sources[rel] = await hashSource(rel);
  const manifest: RunManifest = {
    runId,
    recordedAt: new Date().toISOString(),
    appGitSha: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim(),
    sources,
    settings: {
      desktopViewport: DESKTOP_VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      mobileViewport: MOBILE_VIEWPORT,
      mobileScaleFactor: MOBILE_SCALE_FACTOR,
    },
    assets,
  };
  await fs.writeFile(path.join(runDir, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await updateLatestLink(runId);
  await pruneOldRuns();
  process.stdout.write(`  · library: run ${runId} recorded (${assets.length} raw assets)\n`);
}

/** Open a new run in the library and return its raw sink (the serial-record path). */
export async function createRunRecorder(): Promise<RunRecorder> {
  const runId = await mintRunId();
  const runDir = path.join(LIBRARY_ROOT, runId);
  const rawDir = path.join(runDir, 'raw');
  await fs.mkdir(rawDir, { recursive: true });
  const sink = makeRawSink(rawDir);
  return {
    runId,
    saveStill: sink.saveStill,
    saveLoop: sink.saveLoop,
    finalize: () => writeRunManifest(runId, runDir, sink.assets),
  };
}

/** Subdirectory under a run holding one partial-manifest file per shard. */
const SHARDS_DIR = 'shards';

/**
 * Create the shared run directory for a parallel record and return its path.
 * The orchestrator mints the run id once, then every shard worker writes its
 * raws into `<runDir>/raw/` (their file names never collide — each shard owns a
 * disjoint set of shots) and its partial manifest into `<runDir>/shards/`.
 */
export async function createRunDir(runId: string): Promise<string> {
  const runDir = path.join(LIBRARY_ROOT, runId);
  await fs.mkdir(path.join(runDir, SHARDS_DIR), { recursive: true });
  await fs.mkdir(path.join(runDir, 'raw'), { recursive: true });
  return runDir;
}

/**
 * A raw sink for one shard of a parallel record. It writes raws into the shared
 * run's `raw/` dir and, on `finalize`, drops just its asset records into
 * `shards/<index>.json` — never touching `run.json`, `latest`, or retention,
 * which the orchestrator owns once every shard has finished.
 *
 * @param runId - The shared run id minted by the orchestrator.
 * @param runDir - The shared run directory (from {@link createRunDir}).
 * @param shardIndex - This shard's index, naming its partial file.
 */
export async function createShardRecorder(
  runId: string,
  runDir: string,
  shardIndex: number
): Promise<RunRecorder> {
  const sink = makeRawSink(path.join(runDir, 'raw'));
  return {
    runId,
    saveStill: sink.saveStill,
    saveLoop: sink.saveLoop,
    async finalize() {
      const partial = path.join(runDir, SHARDS_DIR, `${shardIndex}.json`);
      await fs.writeFile(partial, `${JSON.stringify(sink.assets, null, 2)}\n`);
      process.stdout.write(
        `  · shard ${shardIndex}: recorded ${sink.assets.length} raw asset(s)\n`
      );
    },
  };
}

/**
 * Merge every shard's partial manifest into the run's single `run.json`, point
 * `latest` at it, and prune old runs — the orchestrator's final step after all
 * shard workers exit. Assets are sorted by file name so the merged manifest is
 * deterministic regardless of shard timing.
 */
export async function finalizeShardedRun(runId: string, runDir: string): Promise<void> {
  const shardsDir = path.join(runDir, SHARDS_DIR);
  const partials = (await fs.readdir(shardsDir)).filter((f) => f.endsWith('.json'));
  const assets: RawAsset[] = [];
  for (const file of partials) {
    const parsed = JSON.parse(await fs.readFile(path.join(shardsDir, file), 'utf8')) as RawAsset[];
    assets.push(...parsed);
  }
  assets.sort((a, b) => a.file.localeCompare(b.file));
  await writeRunManifest(runId, runDir, assets);
  await fs.rm(shardsDir, { recursive: true, force: true });
}

/** A loaded run: its directory plus the parsed `run.json`. */
export interface LoadedRun {
  runDir: string;
  manifest: RunManifest;
}

/**
 * Load a run for processing. `runId` may be an explicit id or omitted for the
 * newest run (via the `latest` symlink, falling back to a directory scan).
 */
export async function loadRun(runId?: string): Promise<LoadedRun> {
  let resolved = runId;
  if (!resolved) {
    try {
      resolved = await fs.readlink(path.join(LIBRARY_ROOT, LATEST_LINK));
    } catch {
      resolved = (await listRuns())[0];
    }
  }
  if (!resolved) {
    throw new Error(
      `no recorded runs in ${LIBRARY_ROOT} — run \`pnpm --filter @dorkos/e2e capture:record\` first`
    );
  }
  const runDir = path.join(LIBRARY_ROOT, resolved);
  const manifest = JSON.parse(
    await fs.readFile(path.join(runDir, 'run.json'), 'utf8')
  ) as RunManifest;
  return { runDir, manifest };
}
