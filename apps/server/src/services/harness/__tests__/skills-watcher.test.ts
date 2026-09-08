/**
 * The trigger that projects a skill an agent writes, against REAL chokidar, a
 * real filesystem and the real engine (contract SRC-06, TR-06, TR-07, SK-11;
 * journey J-05's trigger half).
 *
 * Built on the harness `services/tasks/__tests__/task-file-watcher.integration.test.ts`
 * uses, for the reason that suite gives: the claim under test is precisely "what
 * does the watcher do when it sees this file", and a test that called
 * `projectWithConsent` directly would assert nothing about the watcher.
 *
 * The engine half of J-05 — what the PLAN gains when a skill appears, as an
 * exact tree diff — is
 * `packages/harness/src/__tests__/journeys/j05-agent-writes-a-skill.test.ts`.
 * This file is the other half: that the projection happens at all, in time, once,
 * and without the four hazards TR-06 names.
 *
 * Every temp directory is resolved through `realpath` up front. Every macOS temp
 * directory sits under a symlinked `/var`, and chokidar reports the path it
 * walked — so a test that built its expectations from the unresolved root would
 * compare paths that never match.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

/**
 * Every logger call is inspected — the restart caveat is an output, not a side
 * effect — and the one config leaf both the watcher and the consent seam read is
 * a switch this suite flips. Both live in `vi.hoisted` because the `vi.mock`
 * factories below are hoisted above every other statement in the file.
 */
const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  harness: { autoSync: true },
}));
const loggerMock = mocks.logger;

vi.mock('../../../lib/logger.js', () => ({ logger: mocks.logger }));
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (section: string) => {
      if (section !== 'harness') throw new Error(`unexpected config read: ${section}`);
      return { autoSync: mocks.harness.autoSync, approvedHooks: [], refusedHooks: [] };
    },
    set: () => {
      throw new Error('the skills watcher must never write config');
    },
  },
}));

import { skillsFactsFor } from '@dorkos/harness';
import {
  isAuthoredSkillFile,
  startSkillsWatcher,
  startTurnEndReprojection,
  _internal,
  type SkillsWatcherHandle,
} from '../skills-watcher.js';
import { projectLockQueueDepth, withProjectLock } from '../project-with-consent.js';

// Real chokidar on macOS reports a deletion up to two seconds after it happens
// (measured: 1.7s for an `rm -r` of a skill directory), and several cases here
// wait for two projections in a row. The default five seconds is a budget these
// tests spend on the filesystem rather than on anything under test, and a test
// that ABORTS mid-projection leaves work running into the next one — so the
// budget is raised rather than the waits shortened.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let repo = '';
let dorkHome = '';
let watcher: SkillsWatcherHandle | undefined;
let projections: ReturnType<typeof vi.spyOn>;

/** The watched directory for the staged repo. */
function skillsDir(): string {
  return join(repo, '.agents', 'skills');
}

/** Write a file, creating its parents. */
function writeAt(absPath: string, content: string): void {
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(absPath, content);
}

/** A minimal, schema-valid authored skill. */
function skillBody(name: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill\n---\n\nDo the ${name} thing.\n`;
}

/** Stage a repo that already syncs to Claude Code and Codex, with one skill in it. */
function stageRepo(harnesses: string[] = ['claude-code', 'codex']): void {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'skills-watcher-repo-')));
  dorkHome = realpathSync(mkdtempSync(join(tmpdir(), 'skills-watcher-home-')));
  writeAt(
    join(repo, '.agents', 'harness.manifest.json'),
    `${JSON.stringify({ version: 1, harnesses, claudeOnlySkills: [] }, null, 2)}\n`
  );
  writeAt(join(repo, 'AGENTS.md'), '# House rules\n');
  writeAt(join(skillsDir(), 'baseline', 'SKILL.md'), skillBody('baseline'));
}

/**
 * Unpack a project-scoped package that ships a hook and a skill.
 *
 * The hook is what hazard (c) is about — a package nobody has allowed — and the
 * skill is what hazard (e) is about: the engine links it into `.agents/skills`,
 * which is the directory being watched.
 */
function stagePackage(): void {
  const plugin = join(repo, '.dork', 'plugins', 'acme');
  writeAt(
    join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'acme',
      version: '1.0.0',
      type: 'plugin',
      description: 'A fixture package',
      layers: ['hooks', 'skills'],
    })
  );
  writeAt(
    join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'node ./hooks/guard.mjs' }] }] })
  );
  writeAt(join(plugin, 'skills', 'helper', 'SKILL.md'), skillBody('helper'));
}

/**
 * Start the watcher over the staged repo with a test-sized coalescing window,
 * and wait for chokidar's first scan.
 *
 * Waiting is not optional. Until that scan finishes chokidar treats everything
 * it finds as ALREADY THERE, and `ignoreInitial` drops it — so a test that wrote
 * a skill in the same millisecond would be asserting against an event that was
 * never delivered. Measured: the scan lands 3-20ms after the watch opens, which
 * is exactly the window a test writes into.
 */
async function start({ coalesceMs = 40, sweepMs = 60 } = {}): Promise<SkillsWatcherHandle> {
  const handle = startSkillsWatcher({
    dorkHome,
    roots: () => [repo],
    coalesceMs,
    sweepMs,
    // Long enough that no rescan ever fires mid-test; the tests that care about
    // the root set call `refreshRoots()` themselves.
    rootRescanMs: 600_000,
  });
  if (!handle) throw new Error('watcher did not start');
  watcher = handle;
  await handle.ready();
  return handle;
}

/** Poll `check` until it is true or the deadline passes. */
async function waitUntil(check: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Assert `check` stays true for `windowMs` — a bounded "and it stays that way". */
async function holdsFor(check: () => boolean, label: string, windowMs = 400): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (!check()) throw new Error(`${label} stopped holding`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A content-shaped snapshot of every path under `root`.
 *
 * Symlinks are never followed and their literal text is recorded, because a
 * projected link IS the change under test. Deliberately local rather than shared
 * with the engine's journey helper: this suite lives in another package and a
 * twenty-line walk is cheaper than an export nobody else wants.
 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (entry.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`;
      else if (entry.isDirectory()) {
        out[rel] = 'dir';
        walk(abs);
      } else out[rel] = `file:${readFileSync(abs, 'utf8').length}`;
    }
  };
  walk(root);
  return out;
}

/** The exact paths added, changed and removed between two {@link snapshot}s. */
function diff(
  before: Record<string, string>,
  after: Record<string, string>
): { added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [path, value] of Object.entries(after)) {
    if (!(path in before)) added.push(path);
    else if (before[path] !== value) changed.push(path);
  }
  for (const path of Object.keys(before)) if (!(path in after)) removed.push(path);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/** Whether something OCCUPIES a path — a dead symlink counts. */
function occupied(absPath: string): boolean {
  try {
    lstatSync(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * How many filesystem-watch handles this process is holding right now.
 *
 * `/dev/fd` was the obvious instrument and is the wrong one: measured here, a
 * `fs.watch` on macOS consumes no descriptor, so the count did not move whether
 * the watchers were closed or not — a leak detector that could not detect the
 * leak. `process.getActiveResourcesInfo()` names the handle type directly, and
 * measured against it a closed watcher drops to zero while ten open ones read
 * thirty. `StatWatcher` rides along for the polling backend.
 */
function watchHandleCount(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'FSEventWrap' || r === 'StatWatcher')
    .length;
}

/** Every structured field of every `logger.info` call, for the caveat assertions. */
function infoLogs(): { message: string; fields: Record<string, unknown> }[] {
  return loggerMock.info.mock.calls.map(([message, fields]) => ({
    message: String(message),
    fields: (fields ?? {}) as Record<string, unknown>,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.harness.autoSync = true;
  stageRepo();
  projections = vi.spyOn(_internal, 'projectWithConsent');
});

afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  await new Promise((r) => setTimeout(r, 200));
  projections.mockRestore();
  for (const dir of [repo, dorkHome]) if (dir) rmSync(dir, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

describe('a skill an agent writes reaches Claude Code (SRC-06, TR-06)', () => {
  it('links a new skill into .claude/skills within the debounce window, and nothing else', async () => {
    const handle = await start();
    // One baseline projection first, so the diff below measures ADDING A SKILL
    // rather than the scaffolds a never-projected repo also gains.
    handle.scheduleProjection(repo, 'turn-end');
    await handle.flush();
    const before = snapshot(repo);
    projections.mockClear();

    writeAt(join(skillsDir(), 'deploy-checklist', 'SKILL.md'), skillBody('deploy-checklist'));

    await waitUntil(
      () => occupied(join(repo, '.claude', 'skills', 'deploy-checklist')),
      'the Claude Code link to appear'
    );
    await handle.flush();

    expect(diff(before, snapshot(repo))).toEqual({
      added: [
        '.agents/skills/deploy-checklist',
        '.agents/skills/deploy-checklist/SKILL.md',
        '.claude/skills/deploy-checklist',
      ],
      changed: [],
      removed: [],
    });
    expect(readlinkSync(join(repo, '.claude', 'skills', 'deploy-checklist'))).toBe(
      '../../.agents/skills/deploy-checklist'
    );
  });

  it('never sweeps: a deleted skill leaves its link behind for --check to report', async () => {
    const handle = await start();
    writeAt(join(skillsDir(), 'gone-soon', 'SKILL.md'), skillBody('gone-soon'));
    const link = join(repo, '.claude', 'skills', 'gone-soon');
    await waitUntil(() => occupied(link), 'the link to appear');
    await handle.flush();

    const before = snapshot(repo);
    projections.mockClear();
    rmSync(join(skillsDir(), 'gone-soon'), { recursive: true, force: true });

    await waitUntil(() => projections.mock.calls.length > 0, 'the deletion to project');
    await handle.flush();

    // The link STAYS. A sweep at watcher frequency is HK-11's blast radius on a
    // tree that may be mid-edit, so the dead link is `--check`'s to report and
    // the next `--fix`'s to prune — never this trigger's.
    const after = diff(before, snapshot(repo));
    expect(after.removed).toEqual([
      '.agents/skills/gone-soon',
      '.agents/skills/gone-soon/SKILL.md',
    ]);
    expect(after.added).toEqual([]);
    expect(occupied(link)).toBe(true);
    expect(existsSync(link)).toBe(false); // occupied by a link that resolves nowhere
    for (const call of projections.mock.calls) {
      expect((call[1] as { sweepOrphans: boolean }).sweepOrphans).toBe(false);
    }
  });

  it('projects a renamed skill and leaves the old link, for the same reason', async () => {
    const handle = await start();
    writeAt(join(skillsDir(), 'old-name', 'SKILL.md'), skillBody('old-name'));
    await waitUntil(
      () => occupied(join(repo, '.claude', 'skills', 'old-name')),
      'the first link to appear'
    );
    await handle.flush();
    const before = snapshot(repo);

    renameSync(join(skillsDir(), 'old-name'), join(skillsDir(), 'new-name'));

    await waitUntil(
      () => occupied(join(repo, '.claude', 'skills', 'new-name')),
      'the renamed link to appear'
    );
    await handle.flush();

    expect(diff(before, snapshot(repo))).toEqual({
      added: [
        '.agents/skills/new-name',
        '.agents/skills/new-name/SKILL.md',
        '.claude/skills/new-name',
      ],
      changed: [],
      removed: ['.agents/skills/old-name', '.agents/skills/old-name/SKILL.md'],
    });
  });

  it('does not spend the skill on a bare mkdir — the link appears when SKILL.md lands', async () => {
    const handle = await start();
    mkdirSync(join(skillsDir(), 'half-written'), { recursive: true });
    const link = join(repo, '.claude', 'skills', 'half-written');

    // TR-06's first hazard: a projection that runs between the `mkdir` and the
    // write finds a directory the scanner skips, does nothing, and — if that
    // were the only event — the skill would never be projected at all. Nothing
    // is linked for an empty directory, and the trigger is not spent on it.
    await holdsFor(() => !occupied(link), 'the empty directory to stay unprojected');

    writeAt(join(skillsDir(), 'half-written', 'SKILL.md'), skillBody('half-written'));

    // The event that matters is still to come, and it still arrives.
    await waitUntil(() => occupied(link), 'the link once the SKILL.md lands');
    await handle.flush();
    expect(occupied(link)).toBe(true);
  });

  it('wires no addDir handler at all — a directory is never a trigger by itself', () => {
    // Read off the source rather than inferred from behaviour, because the
    // behaviour is not decisive: chokidar occasionally emits a spurious `change`
    // for an untouched SKILL.md when a sibling directory appears (observed here,
    // under load), so "no projection ran" is not something a mkdir can promise.
    // What CAN be promised is that a directory event is never wired to the
    // trigger, and that is exactly what this asserts.
    const source = readFileSync(new URL('../skills-watcher.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/watcher\.on\(\s*'addDir'/);
    expect(source).toMatch(/watcher\.on\(\s*'add'/);
    expect(source).toMatch(/watcher\.on\(\s*'unlinkDir'/);
  });

  it('coalesces a burst of skills into one projection', async () => {
    const handle = await start({ coalesceMs: 150, sweepMs: 250 });
    for (const name of ['alpha', 'bravo', 'charlie', 'delta']) {
      writeAt(join(skillsDir(), name, 'SKILL.md'), skillBody(name));
    }

    await waitUntil(
      () => occupied(join(repo, '.claude', 'skills', 'delta')),
      'the last link to appear'
    );
    await handle.flush();

    for (const name of ['alpha', 'bravo', 'charlie', 'delta']) {
      expect(occupied(join(repo, '.claude', 'skills', name))).toBe(true);
    }
    // Four files, one plan and one apply. The bound that matters is "fewer than
    // one per file"; the exact number depends on how chokidar batches the writes
    // and on whether the sweep or an event got there first.
    expect(projections.mock.calls.length).toBeLessThan(4);
  });
});

describe('the sweep catches what the watcher drops', () => {
  it('projects a skill whose event was never reported, and stops once it has', async () => {
    // Measured against chokidar 5 on macOS: a skill directory created and its
    // SKILL.md written in the same instant is never reported at all in 22% of
    // runs (13 of 60, `apps/server`). The sweep is what keeps the promise, so it
    // is driven here directly rather than by hoping for the miss.
    const handle = await start({ sweepMs: 0 });

    // Nothing has changed since the watch opened and recorded the shape.
    handle.projectIfSkillsChanged(repo, 'sweep');
    await handle.flush();
    expect(projections).not.toHaveBeenCalled();

    writeAt(join(skillsDir(), 'unreported', 'SKILL.md'), skillBody('unreported'));

    handle.projectIfSkillsChanged(repo, 'sweep');
    await handle.flush();
    expect(projections.mock.calls.length).toBe(1);
    expect(occupied(join(repo, '.claude', 'skills', 'unreported'))).toBe(true);

    // And it does not keep going: the shape is re-recorded around the
    // projection, so the engine's own writes are not read as a change.
    handle.projectIfSkillsChanged(repo, 'sweep');
    await handle.flush();
    expect(projections.mock.calls.length).toBe(1);
  });

  it('notices a SKILL.md written into a directory that already existed', async () => {
    // The parent's own modification time does not move for this one, which is
    // why the shape reads the entries rather than the directory.
    const handle = await start({ sweepMs: 0 });
    mkdirSync(join(skillsDir(), 'late'), { recursive: true });
    handle.projectIfSkillsChanged(repo, 'sweep');
    await handle.flush();
    projections.mockClear();

    writeAt(join(skillsDir(), 'late', 'SKILL.md'), skillBody('late'));

    handle.projectIfSkillsChanged(repo, 'sweep');
    await handle.flush();
    expect(projections.mock.calls.length).toBe(1);
    expect(occupied(join(repo, '.claude', 'skills', 'late'))).toBe(true);
  });

  it('projects a project it has never recorded, rather than assuming nothing changed', async () => {
    const handle = await start({ sweepMs: 0 });
    // A root nobody is watching: the turn-end trigger's whole case.
    const unwatched = realpathSync(mkdtempSync(join(tmpdir(), 'skills-watcher-other-')));
    try {
      writeAt(
        join(unwatched, '.agents', 'harness.manifest.json'),
        JSON.stringify({ version: 1, harnesses: ['claude-code'], claudeOnlySkills: [] })
      );
      writeAt(join(unwatched, '.agents', 'skills', 'theirs', 'SKILL.md'), skillBody('theirs'));

      handle.projectIfSkillsChanged(unwatched, 'turn-end');
      await handle.flush();

      expect(projections.mock.calls.length).toBe(1);
      expect(occupied(join(unwatched, '.claude', 'skills', 'theirs'))).toBe(true);
    } finally {
      rmSync(unwatched, { recursive: true, force: true });
    }
  });
});

describe('the trigger obeys the hook gate and never asks (hazard 2)', () => {
  it('installs no hooks for a package nobody has allowed, and raises no card', async () => {
    stagePackage();
    const handle = await start({ sweepMs: 0 });

    // Driven through the watcher's own entry point rather than a file write:
    // the claim under test is what a FIRING installs, and a test that also had
    // to wait for chokidar would be measuring the filesystem's timing on top of
    // it. The event path is pinned by the cases above and by the feedback-loop
    // suite below.
    writeAt(join(skillsDir(), 'mine', 'SKILL.md'), skillBody('mine'));
    handle.scheduleProjection(repo, 'skill-file');
    await handle.flush();
    expect(occupied(join(repo, '.claude', 'skills', 'mine'))).toBe(true);

    // The package's own skill projected — so this is a projection that ran, not
    // one that never happened.
    expect(occupied(join(repo, '.agents', 'skills', 'acme__helper'))).toBe(true);
    // Its hook did not. Neither settings file names the command, and the
    // generated Codex file — if one was written at all — does not either.
    for (const rel of [
      join('.claude', 'settings.local.json'),
      join('.claude', 'settings.json'),
      join('.codex', 'hooks.json'),
    ]) {
      const path = join(repo, rel);
      if (existsSync(path)) expect(readFileSync(path, 'utf8')).not.toContain('guard.mjs');
    }

    // Withheld, and reported as a count — never as a question. The watcher holds
    // no approval gateway at all: nothing in this run could have asked.
    const withheld = await projections.mock.results[0]?.value;
    expect((withheld as { withheld: unknown[] }).withheld.length).toBeGreaterThan(0);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('leaves a hand-written .codex/hooks.json byte-identical across a hundred firings', async () => {
    // Hand-authored, in the shape a person would write. The engine never
    // overwrites a hooks file it did not write, and a trigger that fires on
    // every file change is the one most likely to prove otherwise.
    const codexHooks = join(repo, '.codex', 'hooks.json');
    const authored = '{\n  "description": "mine",\n  "hooks": {}\n}\n';
    writeAt(codexHooks, authored);

    const handle = await start({ coalesceMs: 0, sweepMs: 0 });
    for (let i = 0; i < 100; i++) {
      handle.scheduleProjection(repo, 'turn-end');
      await handle.flush();
    }

    expect(projections.mock.calls.length).toBe(100);
    expect(readFileSync(codexHooks, 'utf8')).toBe(authored);
  });
});

describe('the watcher never re-fires on its own output (hazard 4)', () => {
  it('ignores the <pkg>__<name> links the projection writes into the watched directory', async () => {
    stagePackage();
    const handle = await start({ sweepMs: 0 });

    writeAt(join(skillsDir(), 'mine', 'SKILL.md'), skillBody('mine'));
    handle.scheduleProjection(repo, 'skill-file');
    await handle.flush();

    // The engine wrote a link INSIDE the directory being watched. chokidar
    // reports the SKILL.md reachable through it, so the exclusion is the only
    // thing between that and a projection of the projection's own output.
    const link = join(skillsDir(), 'acme__helper');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(isAuthoredSkillFile(join(link, 'SKILL.md'), skillsDir())).toBe(false);
    // The authored skill beside it is still a trigger, so the exclusion is not
    // passing by rejecting everything.
    expect(isAuthoredSkillFile(join(skillsDir(), 'mine', 'SKILL.md'), skillsDir())).toBe(true);

    // And the loop is closed at the other end too: a second projection writes
    // nothing at all, so even a spurious event could not start a cycle.
    const before = snapshot(repo);
    handle.scheduleProjection(repo, 'skill-file');
    await handle.flush();
    expect(diff(before, snapshot(repo))).toEqual({ added: [], changed: [], removed: [] });
  });

  it('still projects a real directory whose name happens to carry the marker', async () => {
    const handle = await start();
    // DOR-1844: `__` in the name is half the predicate. A real directory
    // somebody authored is theirs, and hiding it would lose a skill.
    writeAt(join(skillsDir(), 'my__helper', 'SKILL.md'), skillBody('my-helper'));

    await waitUntil(
      () => occupied(join(repo, '.claude', 'skills', 'my__helper')),
      'the authored skill to be linked'
    );
    await handle.flush();
  });
});

describe('one firing per root is ever queued (the lock bound)', () => {
  it('holds twenty events behind one queued projection, and loses none of them', async () => {
    const handle = await start({ coalesceMs: 30, sweepMs: 0 });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Somebody else's turn — a marketplace install waiting on an approval card
    // is the real shape of this, and `ApprovalService` gives a person two hours
    // to answer one.
    const holder = withProjectLock(repo, () => held);
    await waitUntil(() => projectLockQueueDepth(repo) === 1, 'the holder to take the lock');

    // One firing, which reaches the lock and waits there.
    handle.scheduleProjection(repo, 'skill-file');
    await waitUntil(
      () => projectLockQueueDepth(repo) === 2,
      'the watcher firing to queue behind the holder'
    );

    // Twenty more events arrive while it waits. Each one is a real change
    // somebody made, so none may be dropped — and none may take a queue slot.
    let peak = projectLockQueueDepth(repo);
    for (let i = 0; i < 20; i++) {
      handle.scheduleProjection(repo, 'skill-file');
      peak = Math.max(peak, projectLockQueueDepth(repo));
    }
    await new Promise((r) => setTimeout(r, 120));
    peak = Math.max(peak, projectLockQueueDepth(repo));

    // The holder plus exactly one of ours. Twenty entries here would mean twenty
    // whole projections queued behind a two-hour approval card.
    expect(peak).toBe(2);
    expect(projections).not.toHaveBeenCalled();

    release();
    await holder;
    await handle.flush();

    // The queued firing, and then exactly one more for everything that arrived
    // while it was waiting. Coalescing them away entirely would be the other
    // failure: the twenty changes would never be projected at all.
    expect(projections.mock.calls.length).toBe(2);
    expect(projectLockQueueDepth(repo)).toBe(0);
  });
});

describe('the Claude Code restart caveat (SK-11)', () => {
  it('says a restart is needed when the projection had to create .claude/skills', async () => {
    const handle = await start();
    expect(existsSync(join(repo, '.claude', 'skills'))).toBe(false);

    writeAt(join(skillsDir(), 'fresh', 'SKILL.md'), skillBody('fresh'));
    await waitUntil(() => occupied(join(repo, '.claude', 'skills', 'fresh')), 'the link');
    await handle.flush();

    const caveat = infoLogs().find((line) => line.fields.restartRequired !== undefined);
    expect(caveat?.fields.restartRequired).toBe(true);
    expect(String(caveat?.fields.hint)).toContain('restart');
    // The claim about another company's software carries the page it came from
    // and the day it was read, exactly as the Codex trust line does.
    const facts = skillsFactsFor('claude-code');
    expect(caveat?.fields.source).toBe(`${facts.source.url}, read ${facts.source.fetchedAt}`);
  });

  it('says it once per project, and softens it when the directory was already there', async () => {
    const handle = await start();
    mkdirSync(join(repo, '.claude', 'skills'), { recursive: true });

    writeAt(join(skillsDir(), 'one', 'SKILL.md'), skillBody('one'));
    await waitUntil(() => occupied(join(repo, '.claude', 'skills', 'one')), 'the first link');
    await handle.flush();

    const first = infoLogs().filter((line) => line.fields.restartRequired !== undefined);
    expect(first).toHaveLength(1);
    expect(first[0]?.fields.restartRequired).toBe(false);

    writeAt(join(skillsDir(), 'two', 'SKILL.md'), skillBody('two'));
    await waitUntil(() => occupied(join(repo, '.claude', 'skills', 'two')), 'the second link');
    await handle.flush();

    // Useful the first time, noise on every save after it.
    expect(infoLogs().filter((line) => line.fields.restartRequired !== undefined)).toHaveLength(1);
  });
});

describe('harness.autoSync gates the whole trigger', () => {
  it('starts no watcher at all when projection is switched off', () => {
    mocks.harness.autoSync = false;
    const handle = startSkillsWatcher({ dorkHome, roots: () => [repo] });
    expect(handle).toBeUndefined();
  });

  it('stops projecting when it is switched off while running', async () => {
    const handle = await start();
    mocks.harness.autoSync = false;
    handle.scheduleProjection(repo, 'turn-end');
    await handle.flush();

    expect(projections).not.toHaveBeenCalled();
  });

  it('refuses a project that has no harness manifest, and scaffolds none', async () => {
    rmSync(join(repo, '.agents', 'harness.manifest.json'));
    const handle = await start();

    writeAt(join(skillsDir(), 'orphan', 'SKILL.md'), skillBody('orphan'));
    handle.scheduleProjection(repo, 'skill-file');
    await handle.flush();

    // Nothing projected, and — the part that matters — no manifest written. An
    // unattended trigger never sets a project up for sync on its own.
    expect(projections).not.toHaveBeenCalled();
    expect(existsSync(join(repo, '.agents', 'harness.manifest.json'))).toBe(false);
    await holdsFor(() => projections.mock.calls.length === 0, 'no projection without a manifest');
  });
});

describe('stop() gives every handle back', () => {
  it('survives fifty start/stop cycles without leaking watch handles', async () => {
    const baseline = watchHandleCount();
    // One open watcher holds three handles here (the skills root and what is
    // under it), so a `stop()` that closed nothing would leave a hundred and
    // fifty behind. The reviewer of DOR-1854 hit EMFILE on this machine, which
    // is why this is measured rather than assumed.
    const open = await start();
    expect(watchHandleCount()).toBeGreaterThan(baseline);
    await open.stop();
    watcher = undefined;

    for (let i = 0; i < 50; i++) {
      const handle = await start();
      await handle.stop();
      watcher = undefined;
    }
    await waitUntil(
      () => watchHandleCount() <= baseline,
      'every watch handle to be given back',
      2000
    );
  });

  it('is deaf after stop — a skill written afterwards projects nothing', async () => {
    const handle = await start();
    await handle.stop();
    watcher = undefined;

    expect(handle.watchedRoots()).toEqual([]);
    writeAt(join(skillsDir(), 'too-late', 'SKILL.md'), skillBody('too-late'));
    await holdsFor(() => projections.mock.calls.length === 0, 'no projection after stop');
  });
});

describe('a turn that ends re-projects the project it ran in (TR-07)', () => {
  /**
   * The watcher with NO roots, plus the turn-end hook over it.
   *
   * Deliberately watching nothing: TR-07's whole value is the project the
   * watcher has no reason to watch — a person's own checkout, a room worktree —
   * so a suite that also had the watcher on this repo would not be measuring the
   * turn-end path at all.
   */
  function turnEnds(): {
    handle: SkillsWatcherHandle;
    fire: (sessionId: string, kind: 'turn_end' | 'interaction_resolved') => void;
    setRoot: (value: string | undefined) => void;
    stop: () => void;
  } {
    const handle = startSkillsWatcher({
      dorkHome,
      roots: () => [],
      coalesceMs: 10,
      rootRescanMs: 600_000,
    });
    if (!handle) throw new Error('watcher did not start');
    watcher = handle;

    let listener: ((id: string, kind: 'turn_end' | 'interaction_resolved') => void) | undefined;
    let root: string | undefined = repo;
    const hook = startTurnEndReprojection({
      watcher: handle,
      subscribe: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      rootForSession: () => root,
    });
    return {
      handle,
      fire: (id, kind) => listener?.(id, kind),
      setRoot: (value) => {
        root = value;
      },
      stop: () => hook.stop(),
    };
  }

  it('projects the first time a turn ends in a project, and not again unchanged', async () => {
    const turns = turnEnds();
    expect(turns.handle.watchedRoots()).toEqual([]);

    // DorkOS has no record of what this tree looked like before the session, so
    // the first turn projects rather than assuming nothing happened.
    turns.fire('s1', 'turn_end');
    await turns.handle.flush();
    expect(projections.mock.calls.length).toBe(1);
    expect(occupied(join(repo, '.claude', 'skills', 'baseline'))).toBe(true);

    // Nothing about the project's skills changed, so there is nothing to do.
    turns.fire('s1', 'turn_end');
    await turns.handle.flush();
    expect(projections.mock.calls.length).toBe(1);

    turns.stop();
  });

  it('projects again once a turn has changed which skills the project has', async () => {
    const turns = turnEnds();
    turns.fire('s1', 'turn_end');
    await turns.handle.flush();
    projections.mockClear();

    writeAt(join(skillsDir(), 'written-by-a-turn', 'SKILL.md'), skillBody('written-by-a-turn'));

    turns.fire('s1', 'turn_end');
    await turns.handle.flush();

    expect(projections.mock.calls.length).toBe(1);
    expect(occupied(join(repo, '.claude', 'skills', 'written-by-a-turn'))).toBe(true);
    turns.stop();
  });

  it('ignores a person answering a prompt mid-turn', async () => {
    const turns = turnEnds();

    turns.fire('s1', 'interaction_resolved');
    await turns.handle.flush();

    // The runtime is still writing at that moment, which is the one point a
    // projection must not run.
    expect(projections).not.toHaveBeenCalled();
    turns.stop();
  });

  it('does nothing for a session no runtime can place', async () => {
    const turns = turnEnds();
    turns.setRoot(undefined);

    turns.fire('s1', 'turn_end');
    await turns.handle.flush();

    expect(projections).not.toHaveBeenCalled();
    turns.stop();
  });

  it('stops listening when the hook is stopped', async () => {
    const turns = turnEnds();
    turns.stop();

    turns.fire('s1', 'turn_end');
    await turns.handle.flush();

    expect(projections).not.toHaveBeenCalled();
  });
});
