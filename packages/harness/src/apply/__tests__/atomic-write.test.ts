/**
 * `writeFileAtomic` — measured against a real reader, not argued about (AP-10).
 *
 * The claim is that nobody can ever observe one of the engine's generated files
 * half-written. That is a claim about two processes, so one process cannot test
 * it: inside one Node process the write and the read are the same thread and the
 * window does not exist. This suite therefore spawns a real child that polls the
 * target in a tight loop while the parent rewrites it two hundred times, and
 * fails if the child ever saw anything but a complete version.
 *
 * The two versions are deliberately different lengths AND different bytes
 * (`A…A` vs `B…B`), so a sample is checked by length, first byte and last byte
 * together — a truncated `B` is `(k, 'B', 'B')` with `k` short, which no complete
 * version matches, and the truncate-to-zero a plain `writeFileSync` starts with
 * is `(0, '', '')`.
 *
 * **The seeded red.** Swapping `writeFileAtomic`'s body for a bare
 * `writeFileSync(target, content)` and re-running failed on the first attempt:
 * of ~1,400 samples the child caught 66 bad reads in 14 distinct shapes — 15 of
 * an EMPTY file (the truncate a plain write starts with), ten lengths of a write
 * caught in progress, and three whose head and tail came from DIFFERENT versions.
 * A real red, not a theoretical one. Nothing here is skipped when the machine is
 * busy: the child reports how many samples it took, and a run that sampled too
 * few fails rather than passing quietly.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATOMIC_TMP_SUFFIX, writeFileAtomic } from '../atomic-write.js';

/** How many times the parent rewrites the target while the child watches. */
const ROUNDS = 200;

/**
 * How large each version is.
 *
 * Big enough that a single non-atomic write is not one uninterruptible burst on
 * any filesystem this runs on. The truncate a plain `writeFileSync` performs
 * first is observable at any size; the size is what also makes a mid-write
 * PREFIX observable, so the seeded red catches both failure shapes.
 */
const CONTENT_BYTES = 256 * 1024;

/** The fewest samples a run must take for its verdict to mean anything. */
const MIN_SAMPLES = 200;

/**
 * What the child runs: announce readiness, then poll the target until the parent
 * drops the stop file, recording every distinct `<length>:<first>:<last>` it
 * sees. Plain CommonJS through `node -e`, so it needs no TypeScript loader and
 * starts in milliseconds. Every parameter arrives through the environment, so
 * nothing is interpolated into the program text.
 */
const READER_SOURCE = `
const fs = require('node:fs');
const target = process.env.TARGET_PATH;
const seen = new Map();
let samples = 0;
let missing = 0;
fs.writeFileSync(process.env.READY_PATH, 'ready');
const deadline = Date.now() + 60000;
for (;;) {
  // The stop file is checked in batches so the poll loop stays tight: one
  // extra syscall per read would halve the sampling rate.
  for (let i = 0; i < 64; i++) {
    try {
      const buf = fs.readFileSync(target);
      const key = buf.length + ':' + String.fromCharCode(buf[0]) + ':' + String.fromCharCode(buf[buf.length - 1]);
      seen.set(key, (seen.get(key) || 0) + 1);
      samples++;
    } catch {
      missing++;
    }
  }
  if (fs.existsSync(process.env.STOP_PATH) || Date.now() > deadline) break;
}
fs.writeFileSync(process.env.OUT_PATH, JSON.stringify({ samples, missing, seen: [...seen] }));
`;

/** What the child reports back. */
interface ReaderReport {
  /** How many reads succeeded. */
  samples: number;
  /** How many reads threw — the file was not there at all. */
  missing: number;
  /** Every `<length>:<first>:<last>` observed, with how many times. */
  seen: [string, number][];
}

const temps: string[] = [];

/** A fresh temp directory, realpath-resolved (macOS `/var` is a link to `/private/var`). */
function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One complete version of the file, and the sample key a reader must see for it. */
function version(letter: 'A' | 'B', bytes: number): { content: string; key: string } {
  const content = letter.repeat(bytes);
  return { content, key: `${bytes}:${letter}:${letter}` };
}

/** Resolve once the child has written its ready file, or fail loudly. */
async function waitForReady(readyPath: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(readyPath)) {
    if (Date.now() > deadline) throw new Error('the reader never became ready');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('writeFileAtomic — what a concurrent reader can see', () => {
  it('never lets a reader observe an empty or half-written file', async () => {
    const dir = makeTempDir('atomic-reader-');
    const target = join(dir, 'hooks.json');
    const readyPath = join(dir, 'ready');
    const stopPath = join(dir, 'stop');
    const outPath = join(dir, 'report.json');

    const a = version('A', CONTENT_BYTES);
    const b = version('B', CONTENT_BYTES + 4096);
    // The file exists before the reader starts, so "not there at all" can only
    // mean a gap this write opened.
    writeFileSync(target, a.content);

    const child = spawn(process.execPath, ['-e', READER_SOURCE], {
      env: {
        // eslint-disable-next-line no-restricted-syntax -- handing a child process the parent's environment, not reading a DorkOS setting
        ...process.env,
        TARGET_PATH: target,
        READY_PATH: readyPath,
        STOP_PATH: stopPath,
        OUT_PATH: outPath,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? -1));
    });

    try {
      await waitForReady(readyPath);
      for (let round = 0; round < ROUNDS; round++) {
        writeFileAtomic(target, round % 2 === 0 ? b.content : a.content);
      }
    } finally {
      writeFileSync(stopPath, 'stop');
    }

    expect(await exited, stderr).toBe(0);
    const report = JSON.parse(readFileSync(outPath, 'utf8')) as ReaderReport;

    // A run that barely sampled proves nothing, so it fails rather than passing.
    expect(report.samples).toBeGreaterThan(MIN_SAMPLES);
    // Rename never unlinks the target, so the file is never absent either.
    expect({ missing: report.missing }).toEqual({ missing: 0 });

    const badReads = report.seen.filter(([key]) => key !== a.key && key !== b.key);
    expect(
      badReads,
      `A reader polling during ${ROUNDS} rewrites saw ${badReads.length} shape(s) that are ` +
        `neither complete version (${a.key} / ${b.key}). Each entry is ` +
        `"<length>:<first byte>:<last byte>" and how often it was seen — a length of 0 is the ` +
        `truncate a non-atomic write starts with, a short length is a write caught in progress.`
    ).toEqual([]);
    // …and it really did watch both versions go by, so the clean result is not
    // a reader that slept through every write.
    expect(report.seen.map(([key]) => key).sort()).toEqual([a.key, b.key].sort());
  }, 90_000);
});

describe('writeFileAtomic — the write itself', () => {
  it('creates the parent directory and leaves no temp file behind', () => {
    const dir = makeTempDir('atomic-basic-');
    const target = join(dir, 'a', 'b', 'hooks.json');

    writeFileAtomic(target, 'hello\n');

    expect(readFileSync(target, 'utf8')).toBe('hello\n');
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['hooks.json']);
  });

  it('replaces the file in place, keeping the permission bits it had', () => {
    const dir = makeTempDir('atomic-mode-');
    const target = join(dir, 'settings.local.json');
    writeFileSync(target, 'old\n');
    chmodSync(target, 0o600);

    writeFileAtomic(target, 'new\n');

    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('writes THROUGH a live symlink, exactly as a plain write did', () => {
    const dir = makeTempDir('atomic-livelink-');
    const real = join(dir, 'dotfiles', 'settings.json');
    writeFileAtomic(real, 'original\n');
    const link = join(dir, 'settings.local.json');
    symlinkSync(real, link);

    writeFileAtomic(link, 'through\n');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('through\n');
    // …and the temp file went beside the REAL file, so the rename stayed on one
    // filesystem rather than crossing whatever the link pointed at.
    expect(readdirSync(join(dir, 'dotfiles'))).toEqual(['settings.json']);
  });

  it('replaces a DEAD symlink instead of creating a file wherever it pointed', () => {
    const dir = makeTempDir('atomic-deadlink-');
    const target = join(dir, '.codex', 'hooks.json');
    mkdirSync(join(dir, '.codex'), { recursive: true });
    symlinkSync(join(dir, 'nowhere.json'), target);

    writeFileAtomic(target, '{}\n');

    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('{}\n');
    expect(existsSync(join(dir, 'nowhere.json'))).toBe(false);
  });

  it('cleans its temp file up when the write cannot land, and rethrows', () => {
    const dir = makeTempDir('atomic-fail-');
    const target = join(dir, 'occupied');
    mkdirSync(target); // a directory where a file belongs: the rename cannot land

    expect(() => writeFileAtomic(target, 'nope\n')).toThrow();

    // The failure left nothing behind — no half-file, and no temp file to be
    // mistaken later for somebody's own content in a projection directory.
    expect(readdirSync(dir).filter((e) => e.endsWith(ATOMIC_TMP_SUFFIX))).toEqual([]);
    expect(readdirSync(dir)).toEqual(['occupied']);
  });
});
