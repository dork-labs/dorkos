/**
 * The engine's own sweeps must not delete the engine's own in-flight writes.
 *
 * `writeFileAtomic` writes to `.<name>.<pid>.<random>.dorkos-tmp` beside its
 * target and renames it over. In the two COMMAND directories that temp is
 * visible to a wildcard scan — and it holds the whole wrapper, including the
 * generated-command marker the sweeps own things by. So one process's sweep
 * looked at another process's half-second-old write, said "mine, and the plan
 * does not name it", and unlinked it; the writer's `chmod`/`rename` then died
 * with ENOENT out of the middle of `applyPlan`. The same file made
 * `findBlockedWrapperDirs` report the engine's OWN wrapper directory as blocked
 * by foreign content, because an entry renamed away between the listing and the
 * read is unreadable, and unreadable was being read as "somebody else's".
 *
 * Every case below is staged rather than raced, because the race is a
 * three-syscall window and a test that has to win it is a coin flip. Staging a
 * temp file IS what a concurrent writer looks like from the other process, and
 * `__tests__/journeys/j12-two-writers.test.ts` runs the real thing on top.
 *
 * The rule these pin, in one line: a temp younger than `STALE_TEMP_AGE_MS` is
 * untouchable, an older one is debris the command sweeps take, and a temp
 * anywhere else is inert and left alone.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan } from '../apply.js';
import { ATOMIC_TMP_SUFFIX, STALE_TEMP_AGE_MS } from '../atomic-write.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

/** The wrapper the engine generates for `task-0`, in each of the two dirs. */
const CLAUDE_WRAPPER = '.claude/commands/acme/task-0.md';
const OPENCODE_WRAPPER = '.opencode/commands/acme-task-0.md';

/** Where a concurrent writer's temp for each of those sits. */
const CLAUDE_TEMP = `.claude/commands/acme/.task-0.md.90001.beefed${ATOMIC_TMP_SUFFIX}`;
const OPENCODE_TEMP = `.opencode/commands/.acme-task-0.md.90001.beefed${ATOMIC_TMP_SUFFIX}`;

/** A temp beside a generated hooks file — a directory nothing scans. */
const CODEX_TEMP = `.codex/.hooks.json.90001.beefed${ATOMIC_TMP_SUFFIX}`;

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A projected repo with one plugin shipping three slash commands. */
function stageProjectedRepo(): { repo: string; dorkHome: string } {
  const repo = mkdtempSync(join(tmpdir(), 'temp-sweep-repo-'));
  const dorkHome = mkdtempSync(join(tmpdir(), 'temp-sweep-home-'));
  temps.push(repo, dorkHome);

  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code', 'codex', 'opencode'],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# Project\n');
  const plugin = join(repo, '.dork', 'plugins', 'acme');
  writeJsonAt(join(plugin, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    name: 'acme',
    version: '1.0.0',
    type: 'plugin',
    description: 'the acme plugin',
    layers: ['hooks', 'commands'],
  });
  writeJsonAt(join(plugin, 'hooks', 'hooks.json'), {
    Stop: [{ hooks: [{ type: 'command', command: 'echo acme' }] }],
  });
  for (let i = 0; i < 3; i++) {
    writeFileAt(
      join(plugin, 'commands', `task-${i}.md`),
      `---\ndescription: acme task ${i}\n---\n\nDo task ${i}.\n`
    );
  }

  const { conflicts } = applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });
  expect(conflicts).toEqual([]);
  expect(existsSync(join(repo, CLAUDE_WRAPPER))).toBe(true);
  expect(existsSync(join(repo, OPENCODE_WRAPPER))).toBe(true);
  return { repo, dorkHome };
}

/**
 * Stage what a concurrent `writeFileAtomic` looks like from another process: a
 * temp file holding the exact bytes of the wrapper it is about to become.
 */
function stageTemp(repo: string, tempRel: string, fromRel: string, ageMs = 0): void {
  const abs = join(repo, tempRel);
  writeFileSync(abs, readFileSync(join(repo, fromRel), 'utf8'));
  if (ageMs > 0) {
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(abs, when, when);
  }
}

/** Apply the current plan with the orphan sweep on. */
function resync(repo: string, dorkHome: string): ReturnType<typeof applyPlan> {
  return applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });
}

describe('a live temp file is somebody else’s write in progress', () => {
  it('AP-10, AP-07: survives the Claude wrapper sweep and the OpenCode sweep', () => {
    const { repo, dorkHome } = stageProjectedRepo();
    stageTemp(repo, CLAUDE_TEMP, CLAUDE_WRAPPER);
    stageTemp(repo, OPENCODE_TEMP, OPENCODE_WRAPPER);

    const { swept } = resync(repo, dorkHome);

    // Before DOR-1854's review round both of these came back false and both
    // paths were in `swept` — the sweep deleting another process's in-flight
    // write, whose rename then failed with ENOENT.
    expect({
      claude: existsSync(join(repo, CLAUDE_TEMP)),
      opencode: existsSync(join(repo, OPENCODE_TEMP)),
    }).toEqual({ claude: true, opencode: true });
    expect(swept.filter((p) => p.endsWith(ATOMIC_TMP_SUFFIX))).toEqual([]);
  });

  it('AP-10, AP-07: does not make the engine’s own wrapper directory look foreign', () => {
    const { repo, dorkHome } = stageProjectedRepo();
    stageTemp(repo, CLAUDE_TEMP, CLAUDE_WRAPPER);

    const { conflicts, applied } = resync(repo, dorkHome);

    // The whole dir used to come back blocked — every wrapper in it reported as
    // "left untouched" over a file DorkOS wrote itself moments earlier.
    expect(conflicts).toEqual([]);
    expect(applied.some((a) => a.target === CLAUDE_WRAPPER)).toBe(true);
  });

  it('AP-10, AP-07: is not foreign when it has already been renamed away mid-scan', () => {
    const { repo, dorkHome } = stageProjectedRepo();
    // `readdirSync` hands back a snapshot; the writer renames its temp onto the
    // target a moment later, so the per-entry read finds nothing. A dead link
    // is the same shape, staged deterministically: an entry that is listed and
    // cannot be read.
    symlinkSync(join(repo, 'gone.md'), join(repo, '.claude', 'commands', 'acme', 'vanished.md'));

    const { conflicts } = resync(repo, dorkHome);

    expect(conflicts).toEqual([]);
  });
});

describe('a stranded temp file is debris, and only the command dirs take it', () => {
  it('AP-10, AP-07: sweeps one older than the threshold, in both command directories', () => {
    const { repo, dorkHome } = stageProjectedRepo();
    stageTemp(repo, CLAUDE_TEMP, CLAUDE_WRAPPER, STALE_TEMP_AGE_MS * 2);
    stageTemp(repo, OPENCODE_TEMP, OPENCODE_WRAPPER, STALE_TEMP_AGE_MS * 2);

    const { swept } = resync(repo, dorkHome);

    expect({
      claude: existsSync(join(repo, CLAUDE_TEMP)),
      opencode: existsSync(join(repo, OPENCODE_TEMP)),
    }).toEqual({ claude: false, opencode: false });
    expect(swept.filter((p) => p.endsWith(ATOMIC_TMP_SUFFIX)).sort()).toEqual(
      [CLAUDE_TEMP, OPENCODE_TEMP].sort()
    );
  });

  it('AP-10, AP-07: leaves a stranded one alone where nothing scans by wildcard', () => {
    const { repo, dorkHome } = stageProjectedRepo();
    // `.codex/` is read by name, never enumerated, so debris there is inert —
    // and sweeping it would mean walking directories the engine has no other
    // reason to walk. Stated in `atomic-write.ts`, pinned here.
    writeFileAt(join(repo, CODEX_TEMP), '{}\n');
    const when = (Date.now() - STALE_TEMP_AGE_MS * 2) / 1000;
    utimesSync(join(repo, CODEX_TEMP), when, when);

    const { swept } = resync(repo, dorkHome);

    expect(existsSync(join(repo, CODEX_TEMP))).toBe(true);
    expect(swept.filter((p) => p.endsWith(ATOMIC_TMP_SUFFIX))).toEqual([]);
  });

  it('AP-10, AP-07: never takes one that is merely a moment old', () => {
    const { repo, dorkHome } = stageProjectedRepo();
    // Half the threshold: old enough that a naive mtime check might round it
    // away, nowhere near old enough to be debris.
    stageTemp(repo, CLAUDE_TEMP, CLAUDE_WRAPPER, STALE_TEMP_AGE_MS / 2);

    resync(repo, dorkHome);

    expect(existsSync(join(repo, CLAUDE_TEMP))).toBe(true);
  });
});
