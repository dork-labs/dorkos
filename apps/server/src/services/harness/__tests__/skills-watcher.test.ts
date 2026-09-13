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
 * One property here is deliberately NOT pinned by a test: that two overlapping
 * root passes cannot interleave (`syncRoots` chains them, and swaps its root set
 * in synchronously). Provoking the overlap needs control of when the boundary
 * check resolves for each root, which would mean asserting against a stub rather
 * than against the real validator every other case here runs through — and the
 * failure it guards against is a transiently empty root set, which is invisible
 * from outside. It is argued in the code instead.
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
  harness: { autoSync: true, throwOnRead: false },
}));
const loggerMock = mocks.logger;

vi.mock('../../../lib/logger.js', () => ({ logger: mocks.logger }));
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (section: string) => {
      if (section !== 'harness') throw new Error(`unexpected config read: ${section}`);
      // `conf` can throw on read — a corrupt or unreadable `config.json` (the
      // shape DOR-584 hit). The trigger has to survive it.
      if (mocks.harness.throwOnRead) throw new Error('config.json is unreadable');
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
  type ProjectionTrigger,
  type SkillsWatcherHandle,
} from '../skills-watcher.js';
import { projectLockQueueDepth, withProjectLock } from '../project-with-consent.js';
import { initBoundary } from '../../../lib/boundary.js';
import chokidar, { type FSWatcher } from 'chokidar';
import { loadCeilingMs, loadScaledMs } from '@dorkos/shared/test-budget';

// Real chokidar on macOS reports a deletion up to two seconds after it happens
// (measured: 1.7s for an `rm -r` of a skill directory), and several cases here
// wait for two projections in a row. The default five seconds is a budget these
// tests spend on the filesystem rather than on anything under test, and a test
// that ABORTS mid-projection leaves work running into the next one — so the
// budget is raised rather than the waits shortened.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** How often the one polling watch re-stats, and how long its case waits. */
const LIVE_POLL_MS = 50;
const LIVE_WAIT_BASE_MS = 10_000;

/**
 * Make `chokidar.watch()` use its POLLING backend, for one case, until restored.
 *
 * The twin of `watchWithPolling` in `packages/relay/src/__tests__/fake-watcher.ts`
 * — a separate copy because each package spies on its own resolved `chokidar`
 * module object, so a shared one would patch the wrong instance.
 *
 * Everything about the path under test stays real: a real tree on disk, real
 * chokidar, the real `armWatch` wiring and the real projector. The only
 * substitution is how chokidar NOTICES a change — `stat` on an interval instead
 * of FSEvents — and the events it then emits, their names and the paths they
 * carry come from the same chokidar code either way.
 *
 * That substitution is what makes the one case below a fact rather than a wager.
 * macOS drops filesystem events silently: measured on this machine on
 * 2026-09-12/13, five fresh skills written under a live native watch delivered
 * NOTHING and reported no error, in a full-suite run of healthy code, and the
 * case that read that as "the watch is broken" went red. Widening it to three
 * fresh watches did not settle it either — on a machine whose FSEvents is
 * flapping, one window reports EMFILE and the next says nothing at all, and any
 * rule that has to tell those two apart is guessing. Polling removes the
 * question: a `stat` on an interval does not drop anything, so a projection that
 * did not happen did not happen (DOR-2012).
 *
 * @param intervalMs - How often chokidar re-stats.
 * @returns A handle whose `restore()` puts the untouched `chokidar.watch` back.
 */
function watchWithPolling(intervalMs: number): { restore(): void } {
  const real = chokidar.watch.bind(chokidar) as typeof chokidar.watch;
  const spy = vi
    .spyOn(chokidar, 'watch')
    .mockImplementation((paths: unknown, options?: unknown): FSWatcher =>
      real(paths as string, {
        ...((options ?? {}) as Record<string, unknown>),
        usePolling: true,
        interval: intervalMs,
        binaryInterval: intervalMs,
      })
    );
  return {
    restore: () => spy.mockRestore(),
  };
}

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
async function start({
  coalesceMs = 40,
  sweepMs = 60,
  rearmMs = 0,
  roots = (): string[] => [repo],
}: {
  coalesceMs?: number;
  sweepMs?: number;
  rearmMs?: number;
  roots?: () => string[];
} = {}): Promise<SkillsWatcherHandle> {
  const handle = startSkillsWatcher({
    dorkHome,
    roots,
    coalesceMs,
    sweepMs,
    rearmMs,
    // The settle is what makes `ready()` an honest barrier; the production
    // default is a tenth of a second and every case here waits on it.
    settleMs: 60,
    // Long enough that no rescan ever fires mid-test; the tests that care about
    // the root set call `refreshRoots()` themselves.
    rootRescanMs: 600_000,
  });
  if (!handle) throw new Error('watcher did not start');
  watcher = handle;
  await handle.ready();
  return handle;
}

/**
 * A watcher with no roots, for the cases that count projections exactly.
 *
 * chokidar occasionally emits an event nobody caused (see the module docs), and
 * a live watch over the staged repo therefore adds an idempotent projection now
 * and then. That is harmless in production and fatal to an exact count, so the
 * cases whose claim is "how many" drive {@link SkillsWatcherHandle.scheduleProjection}
 * and {@link SkillsWatcherHandle.projectIfSkillsChanged} directly, with nothing
 * else able to fire. The cases whose claim is the WATCHER keep their watch and
 * assert on the tree instead.
 */
async function startWithoutWatching(): Promise<SkillsWatcherHandle> {
  return start({ sweepMs: 0, roots: () => [] });
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

/**
 * Every projection the logs attribute to one trigger.
 *
 * The counting spy cannot separate a projection the SWEEP decided on from one
 * the live watch caused — and the watch causes them unbidden, because chokidar
 * emits a `change` for an untouched file now and then (the module docs measure
 * it). Every firing logs the trigger that caused it, whether it applied anything
 * or not, so this is how a claim about the comparison's DECISION is asserted
 * without a global count that the watcher can move underneath it.
 */
function projectionsTriggeredBy(trigger: ProjectionTrigger): string[] {
  return [
    ...loggerMock.info.mock.calls,
    ...loggerMock.debug.mock.calls,
    ...loggerMock.warn.mock.calls,
  ]
    .filter(([, fields]) => (fields as { trigger?: string } | undefined)?.trigger === trigger)
    .map(([message]) => String(message));
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.harness.autoSync = true;
  mocks.harness.throwOnRead = false;
  stageRepo();
  // The REAL boundary, set to the temp tree, so the default
  // `validateBoundaryOrDorkHome` path is what every case here runs through —
  // the boundary cases below narrow it and assert the refusal.
  await initBoundary(realpathSync(tmpdir()));
  projections = vi.spyOn(_internal, 'projectWithConsent');
});

afterEach(async () => {
  delete process.env.DORK_HOME;
  await watcher?.stop();
  watcher = undefined;
  await new Promise((r) => setTimeout(r, 200));
  projections.mockRestore();
  for (const dir of [repo, dorkHome]) if (dir) rmSync(dir, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

describe('a skill an agent writes reaches Claude Code (SRC-06, TR-06)', () => {
  it('SRC-06, TR-06, J-05: links a new skill into .claude/skills within the debounce window, and nothing else', async () => {
    // The backstop stays ON for the three outcome cases below, and that is a
    // decision rather than a convenience. Their claim is the PROMISE — the skill
    // reaches Claude Code — which the system keeps by the watch when it delivers
    // and by the comparison when it does not. Disabling the comparison asserts a
    // guarantee the system explicitly does not make: measured on this machine, a
    // twenty-run loop exhausts the kernel's watch descriptors (EMFILE, which is
    // why `armWatch` installs an error handler at all) and the watch simply
    // stops reporting. That is not a bug the test should be red for; it is the
    // condition the backstop was built for. The WATCH path has its own case
    // below, and the predicate and handler wiring are asserted directly.
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

  it('TR-06: never sweeps — a deleted skill leaves its link behind for --check to report', async () => {
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

  it('TR-06: projects a renamed skill and leaves the old link, for the same reason', async () => {
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

  it('TR-06: does not spend the skill on a bare mkdir — the link appears when SKILL.md lands', async () => {
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

  it('is a skill only one level down — a nested SKILL.md is not one', () => {
    const dir = skillsDir();
    // `<skills>/<name>/SKILL.md` is a skill. `<skills>/<a>/<b>/SKILL.md` is a
    // file inside somebody's skill, and projecting `<a>/<b>` as though it were
    // one would put a link in `.claude/skills` pointing at half a skill.
    expect(isAuthoredSkillFile(join(dir, 'ok', 'SKILL.md'), dir)).toBe(true);
    expect(isAuthoredSkillFile(join(dir, 'a', 'b', 'SKILL.md'), dir)).toBe(false);
    expect(isAuthoredSkillFile(join(dir, 'SKILL.md'), dir)).toBe(false);
    // And not a file that merely lives beside one.
    expect(isAuthoredSkillFile(join(dir, 'ok', 'README.md'), dir)).toBe(false);
    // Nor a dot-directory, which is where editors and DorkOS keep their own things.
    expect(isAuthoredSkillFile(join(dir, '.hidden', 'SKILL.md'), dir)).toBe(false);
  });

  it(
    'SRC-06: is the WATCH that projects, not the backstop',
    async () => {
      // The one case that depends on chokidar actually delivering, so "a green
      // suite that only proves the backstop works" is not true of this file. The
      // backstop is OFF (`sweepMs: 0`), and the assertion is on the TRIGGER the
      // firing carries, so nothing but the watch can satisfy it.
      //
      // THE WATCH POLLS — see `watchWithPolling` for why, and for what that gives
      // up. In short: under a native watch this case had to decide whether five
      // silent writes meant a broken watch or a platform that dropped five events,
      // and there is no honest way to tell. It reddened healthy code on exactly
      // that (DOR-2012). Polling removes the question without removing anything
      // the case claims: `armWatch`, the handlers it wires and the projector are
      // all the real ones.
      const polling = watchWithPolling(LIVE_POLL_MS);
      try {
        const handle = await start({ sweepMs: 0, coalesceMs: 20 });

        // Counted before the write, not cumulatively: a firing left over from
        // earlier in this test would otherwise satisfy the wait without this
        // file having been seen at all.
        const before = projectionsTriggeredBy('skill-file').length;
        writeAt(join(skillsDir(), 'live', 'SKILL.md'), skillBody('live'));
        await waitUntil(
          () => projectionsTriggeredBy('skill-file').length > before,
          'the watch to deliver an event',
          loadScaledMs(LIVE_WAIT_BASE_MS)
        );
        await handle.flush();
        expect(occupied(join(repo, '.claude', 'skills', 'live'))).toBe(true);
      } finally {
        polling.restore();
      }
    },
    Math.min(60_000, loadCeilingMs(LIVE_WAIT_BASE_MS) + 20_000)
  );

  it('TR-06: wires no addDir handler at all — a directory is never a trigger by itself', () => {
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

describe('nothing is written outside the directory boundary', () => {
  it('refuses a project the boundary does not cover, and writes nothing there', async () => {
    // A repo the operator fenced off. The manifest is there, so the ONLY thing
    // between DorkOS and an unattended write into it is the boundary.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'skills-watcher-outside-')));
    try {
      writeAt(
        join(outside, '.agents', 'harness.manifest.json'),
        JSON.stringify({ version: 1, harnesses: ['claude-code'], claudeOnlySkills: [] })
      );
      writeAt(join(outside, '.agents', 'skills', 'theirs', 'SKILL.md'), skillBody('theirs'));

      // The boundary is this repo, and nothing else.
      await initBoundary(repo);
      const handle = await startWithoutWatching();

      // The turn-end path: a session bound to that directory. `routes/tasks.ts`
      // can create one with no boundary call at all, so this input is exactly as
      // unchecked as it looks.
      handle.projectIfSkillsChanged(outside, 'turn-end');
      handle.scheduleProjection(outside, 'skill-file');
      await handle.flush();

      expect(projections).not.toHaveBeenCalled();
      expect(existsSync(join(outside, '.claude'))).toBe(false);
      expect(existsSync(join(outside, '.claude', 'skills', 'theirs'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not even watch a default project outside the boundary', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'skills-watcher-outside-')));
    try {
      mkdirSync(join(outside, '.agents', 'skills'), { recursive: true });
      await initBoundary(repo);

      const handle = await start({ sweepMs: 0, roots: () => [repo, outside] });

      // Watched: the one in bounds. Not watched: the one that is not — a watch
      // is surveillance of a directory the operator fenced off, and it costs a
      // handle DorkOS has no business holding.
      expect(handle.watchedRoots()).toEqual([repo]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('still covers the agent homes DorkOS owns, which sit outside a scoped boundary', async () => {
    // `validateBoundaryOrDorkHome`, not `validateBoundary`: DorkBot and every
    // marketplace-installed agent live under `<dorkHome>/agents/*` by design, and
    // a Docker deployment scoped to /workspace would otherwise refuse the very
    // homes this trigger keeps current.
    const agentHome = join(dorkHome, 'agents', 'dorkbot');
    writeAt(
      join(agentHome, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code'], claudeOnlySkills: [] })
    );
    writeAt(join(agentHome, '.agents', 'skills', 'self-use', 'SKILL.md'), skillBody('self-use'));

    // Cleared in `afterEach`, not here: a failure below would otherwise leak it
    // into every test that ran afterwards.
    process.env.DORK_HOME = dorkHome;
    await initBoundary(repo);
    const handle = await startWithoutWatching();

    handle.scheduleProjection(agentHome, 'sweep');
    await handle.flush();

    // The link is the decisive evidence: nothing else in this test could have
    // created it, and the boundary is the only thing that could have stopped it.
    expect(projections).toHaveBeenCalled();
    expect(occupied(join(agentHome, '.claude', 'skills', 'self-use'))).toBe(true);
  });
});

describe('a root whose .agents/skills does not exist yet', () => {
  it('SRC-06: is not deaf for the life of the process — the watch opens when the directory does', async () => {
    // chokidar cannot watch a path that is not there: pointed at an absent
    // directory it silently watches an ancestor and never picks the directory
    // up. Measured — `getWatched()` holds no entry for it ten seconds later. So
    // this root has NO watcher, and the re-arm is what rescues it.
    rmSync(skillsDir(), { recursive: true, force: true });
    const handle = await start({ sweepMs: 0, rearmMs: 50 });
    expect(handle.watchedRoots()).toEqual([]);

    const started = Date.now();
    writeAt(join(skillsDir(), 'first-ever', 'SKILL.md'), skillBody('first-ever'));

    await waitUntil(
      () => occupied(join(repo, '.claude', 'skills', 'first-ever')),
      'the first skill of a project to be linked'
    );
    const elapsed = Date.now() - started;

    // Seconds, not the ten the backstop alone would have cost.
    expect(elapsed).toBeLessThan(2000);
    // And the root is a properly watched one from here on.
    expect(handle.watchedRoots()).toEqual([repo]);
  });

  it('does not project a root that already had skills just because a watch opened', async () => {
    // The shape is written down when the root is TAKEN ON, so the first
    // comparison after boot finds nothing new. Without that, every root DorkOS
    // watches would be projected once per start — duplicating the boot backfill
    // and printing a line about work nobody asked for.
    const handle = await start({ coalesceMs: 0, sweepMs: 0, rearmMs: 0 });
    expect(handle.watchedRoots()).toEqual([repo]);

    // Asserted on the trigger, never on a count: the live watch adds idempotent
    // projections of its own at unpredictable moments, and one landing inside
    // this test's own `flush()` is what made a delta count flaky (red 2 runs in
    // 5). `turn-end` is the trigger used deliberately, because the watcher only
    // ever stamps `skill-file` or `skill-dir` — so a `turn-end` line can only
    // have come from a call made here.
    //
    // The claim that stands is precisely that: when the shape is unchanged, this
    // path RETURNS before scheduling, so there is no firing for a later event to
    // be folded into. It is not that a stamp cannot be overwritten — inside a
    // coalescing window the trigger is last-writer-wins (`schedule` says so), so
    // a firing this path DID start could be re-stamped by an event arriving
    // behind it. That is why the negative half writes no files.
    handle.projectIfSkillsChanged(repo, 'turn-end');
    await handle.flush();

    expect(projectionsTriggeredBy('turn-end')).toEqual([]);

    // Non-vacuity, proved on a root nothing has recorded AND nothing is
    // watching — so the positive half cannot be confused by an event either.
    const unrecorded = realpathSync(mkdtempSync(join(tmpdir(), 'skills-watcher-other-')));
    try {
      writeAt(
        join(unrecorded, '.agents', 'harness.manifest.json'),
        JSON.stringify({ version: 1, harnesses: ['claude-code'], claudeOnlySkills: [] })
      );
      writeAt(join(unrecorded, '.agents', 'skills', 'theirs', 'SKILL.md'), skillBody('theirs'));

      handle.projectIfSkillsChanged(unrecorded, 'turn-end');
      await handle.flush();

      expect(projectionsTriggeredBy('turn-end')).not.toEqual([]);
      expect(occupied(join(unrecorded, '.claude', 'skills', 'theirs'))).toBe(true);
    } finally {
      rmSync(unrecorded, { recursive: true, force: true });
    }
  });

  it('re-arms without projecting a root whose directory is still absent', async () => {
    rmSync(skillsDir(), { recursive: true, force: true });
    const handle = await start({ sweepMs: 0, rearmMs: 30 });

    await holdsFor(() => projections.mock.calls.length === 0, 'nothing to project yet', 300);
    expect(handle.watchedRoots()).toEqual([]);
  });
});

describe('the sweep catches what the watcher drops', () => {
  it('SRC-06: projects a skill whose event was never reported, and stops once it has', async () => {
    // Two measured ways a real event never arrives: a root whose `.agents/skills`
    // did not exist when the watch opened is deaf until the re-arm reaches it,
    // and a file written in the moments after `ready` is dropped 13-40% of the
    // time. The comparison is what keeps the promise either way, so it is driven
    // here directly rather than by hoping for the miss.
    const handle = await startWithoutWatching();

    // The first look at a project nothing has recorded: DorkOS has no picture to
    // compare against, so it projects and writes one down.
    handle.projectIfSkillsChanged(repo, 'sweep');
    await handle.flush();
    expect(projections.mock.calls.length).toBe(1);
    projections.mockClear();

    // Nothing has changed since.
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
    const handle = await startWithoutWatching();
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
    const handle = await startWithoutWatching();
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
  it('TR-06: installs no hooks for a package nobody has allowed, and raises no card', async () => {
    stagePackage();
    const handle = await startWithoutWatching();

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

  it('TR-06: leaves a hand-written .codex/hooks.json byte-identical across a hundred firings', async () => {
    // Hand-authored, in the shape a person would write. The engine never
    // overwrites a hooks file it did not write, and a trigger that fires on
    // every file change is the one most likely to prove otherwise.
    const codexHooks = join(repo, '.codex', 'hooks.json');
    const authored = '{\n  "description": "mine",\n  "hooks": {}\n}\n';
    writeAt(codexHooks, authored);

    const handle = await start({ coalesceMs: 0, sweepMs: 0, roots: () => [] });
    for (let i = 0; i < 100; i++) {
      handle.scheduleProjection(repo, 'turn-end');
      await handle.flush();
    }

    // At least a hundred: chokidar occasionally adds a spurious `change` of its
    // own (see the module docs), and the claim under test is the file's bytes,
    // not the exact number of times the engine was asked.
    expect(projections.mock.calls.length).toBeGreaterThanOrEqual(100);
    expect(readFileSync(codexHooks, 'utf8')).toBe(authored);
  });
});

describe('the watcher never re-fires on its own output (hazard 4)', () => {
  it('TR-06: ignores the <pkg>__<name> links the projection writes into the watched directory', async () => {
    stagePackage();
    const handle = await startWithoutWatching();

    writeAt(join(skillsDir(), 'mine', 'SKILL.md'), skillBody('mine'));
    handle.scheduleProjection(repo, 'skill-file');
    await handle.flush();

    // The engine wrote a link INSIDE the directory a watch would cover. chokidar
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
    // DOR-1844: `__` in the name is half the predicate, and a real directory
    // somebody authored is theirs. Asserted on the predicate rather than on a
    // delivered event, because the predicate IS the claim — driving it through
    // chokidar would add a dependency on event delivery that says nothing about
    // whether the marker rule is right.
    const handle = await startWithoutWatching();
    writeAt(join(skillsDir(), 'my__helper', 'SKILL.md'), skillBody('my-helper'));

    expect(isAuthoredSkillFile(join(skillsDir(), 'my__helper', 'SKILL.md'), skillsDir())).toBe(
      true
    );

    handle.scheduleProjection(repo, 'skill-file');
    await handle.flush();
    expect(occupied(join(repo, '.claude', 'skills', 'my__helper'))).toBe(true);
  });
});

describe('a change is only written off once it has actually been projected', () => {
  it('retries a projection that threw, instead of recording the change as dealt with', async () => {
    const handle = await startWithoutWatching();
    // Establish a record first, so the retry below is about the failure rather
    // than about this being a project DorkOS has never seen.
    handle.projectIfSkillsChanged(repo, 'sweep');
    await handle.flush();
    projections.mockClear();
    projections.mockImplementationOnce(() => {
      throw new Error('disk went away mid-plan');
    });

    writeAt(join(skillsDir(), 'flaky', 'SKILL.md'), skillBody('flaky'));
    handle.projectIfSkillsChanged(repo, 'sweep');
    await handle.flush();

    expect(projections.mock.calls.length).toBe(1);
    expect(occupied(join(repo, '.claude', 'skills', 'flaky'))).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalled();

    // The failure must not have retired the change. Recording what it merely
    // NOTICED would have: the next comparison would find nothing new and this
    // skill would never be projected by anything.
    handle.projectIfSkillsChanged(repo, 'sweep');
    await handle.flush();

    expect(projections.mock.calls.length).toBe(2);
    expect(occupied(join(repo, '.claude', 'skills', 'flaky'))).toBe(true);
  });

  it('projects a skill that landed WHILE a projection was running', async () => {
    const handle = await startWithoutWatching();
    const real = projections.getMockImplementation();
    // The plan is built from the tree as it is when the engine is called, so a
    // file that arrives after that is not in it. Recording the tree AFTERWARDS
    // would write this skill off as seen without anything ever planning it.
    projections.mockImplementationOnce(
      (...args: Parameters<typeof _internal.projectWithConsent>) => {
        const result = (real ?? _internal.projectWithConsent)(...args);
        // AFTER the plan was built and applied — the agent kept working while
        // the projection ran, which is the ordinary case, not an exotic one.
        writeAt(join(skillsDir(), 'slipped-in', 'SKILL.md'), skillBody('slipped-in'));
        return result;
      }
    );

    writeAt(join(skillsDir(), 'first', 'SKILL.md'), skillBody('first'));
    handle.projectIfSkillsChanged(repo, 'sweep');
    await handle.flush();

    expect(occupied(join(repo, '.claude', 'skills', 'first'))).toBe(true);
    expect(occupied(join(repo, '.claude', 'skills', 'slipped-in'))).toBe(false);

    // The next comparison still sees it as new, because the shape that was
    // recorded is the one the projection PLANNED from.
    handle.projectIfSkillsChanged(repo, 'sweep');
    await handle.flush();

    expect(occupied(join(repo, '.claude', 'skills', 'slipped-in'))).toBe(true);
  });

  it('does not re-project for ever over its own <pkg>__<name> links', async () => {
    stagePackage();
    const handle = await startWithoutWatching();

    handle.scheduleProjection(repo, 'skill-file');
    await handle.flush();
    expect(occupied(join(skillsDir(), 'acme__helper'))).toBe(true);
    const settled = projections.mock.calls.length;

    // The engine wrote into the very directory the shape is read from. If those
    // links counted, every comparison from here on would see a change.
    for (let i = 0; i < 3; i++) {
      handle.projectIfSkillsChanged(repo, 'sweep');
      await handle.flush();
    }
    expect(projections.mock.calls.length).toBe(settled);
  });
});

describe('one bad read does not wedge a repository', () => {
  it('survives a config store that throws, and keeps projecting afterwards', async () => {
    const handle = await startWithoutWatching();
    // `conf` throws on a corrupt or unreadable `config.json` (DOR-584). The read
    // sits at the top of a firing, so a throw there used to escape as an
    // unhandled rejection AND leave the root's in-flight marker set for ever.
    mocks.harness.throwOnRead = true;

    writeAt(join(skillsDir(), 'after-the-throw', 'SKILL.md'), skillBody('after-the-throw'));
    handle.scheduleProjection(repo, 'skill-file');
    await handle.flush();

    expect(projections).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalled();

    // The root is still alive: the next firing runs rather than coalescing into
    // a projection that can never start.
    mocks.harness.throwOnRead = false;
    handle.scheduleProjection(repo, 'skill-file');
    await handle.flush();

    expect(projections.mock.calls.length).toBe(1);
    expect(occupied(join(repo, '.claude', 'skills', 'after-the-throw'))).toBe(true);
  });
});

describe('one firing per root is ever queued (the lock bound)', () => {
  it('holds twenty events behind one queued projection, and loses none of them', async () => {
    const handle = await start({ coalesceMs: 30, sweepMs: 0, roots: () => [] });
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
  it('SK-11: says a restart is needed when the projection had to create .claude/skills', async () => {
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

  it('SK-11: says nothing when the projection never reached .claude/skills', async () => {
    // A Codex-only project that genuinely APPLIES something: its own hooks are
    // generated into `.codex/hooks.json`. So this is not the empty case — work
    // landed, and none of it landed where Claude Code reads, which is exactly
    // when a line about restarting Claude Code would be about nothing.
    stageRepo(['codex']);
    writeAt(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } })
    );
    const handle = await startWithoutWatching();

    writeAt(join(skillsDir(), 'codex-only', 'SKILL.md'), skillBody('codex-only'));
    handle.scheduleProjection(repo, 'skill-file');
    await handle.flush();

    const applied = (await (projections.mock.results[0]?.value as Promise<{ applied: unknown[] }>))
      .applied;
    expect(applied.length).toBeGreaterThan(0);
    expect(existsSync(join(repo, '.codex', 'hooks.json'))).toBe(true);
    expect(existsSync(join(repo, '.claude', 'skills'))).toBe(false);
    expect(infoLogs().filter((line) => line.fields.restartRequired !== undefined)).toEqual([]);
  });

  it('SK-11: says it once per project, and softens it when the directory was already there', async () => {
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
    const handle = await startWithoutWatching();
    mocks.harness.autoSync = false;
    handle.scheduleProjection(repo, 'turn-end');
    await handle.flush();

    expect(projections).not.toHaveBeenCalled();
  });

  it('refuses a project that has no harness manifest, and scaffolds none', async () => {
    rmSync(join(repo, '.agents', 'harness.manifest.json'));
    const handle = await startWithoutWatching();

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
  /** The most cycles worth running, and the fewest that still says "repeated". */
  const MAX_LEAK_CYCLES = 50;
  const MIN_LEAK_CYCLES = 5;
  /**
   * How long the cycling half gets before it stops and measures what it has.
   *
   * The count is not what the assertion rests on: the handle count is compared
   * against the baseline taken before the FIRST watcher, so a single leaked
   * handle already reds. Measured twice with `stop()` seeded to close nothing:
   * one handle over baseline after fifty cycles on one machine, three on
   * another — nowhere near fifty, because every cycle re-opens the same path.
   * Fifty cycles were never the detector, only
   * amplification, and at a load average of 40+ they cost ninety-eight seconds
   * against a thirty-second limit (DOR-2012) — a red that said nothing about the
   * watcher. So the loop is bounded by time and the leak is asserted on however
   * many cycles ran. `cycles` is reported in the failure message rather than
   * asserted: the loop condition already guarantees the floor, so an assertion
   * on it could not fail.
   */

  it(
    'survives repeated start/stop cycles without leaking watch handles',
    async () => {
      const baseline = watchHandleCount();
      const open = await start();
      expect(watchHandleCount()).toBeGreaterThan(baseline);
      await open.stop();
      watcher = undefined;

      const deadline = Date.now() + loadScaledMs(12_000);
      let cycles = 0;
      while (cycles < MAX_LEAK_CYCLES && (cycles < MIN_LEAK_CYCLES || Date.now() < deadline)) {
        const handle = await start();
        await handle.stop();
        watcher = undefined;
        cycles++;
      }

      try {
        await waitUntil(
          () => watchHandleCount() <= baseline,
          'every watch handle to be given back',
          loadScaledMs(4_000)
        );
      } catch {
        // Counted AFTER the wait, so the number in the message is the number
        // that was still held when the budget ran out.
        expect.fail(
          `after ${cycles} start/stop cycles the process still holds ` +
            `${watchHandleCount()} watch handles; the baseline before any watcher was ${baseline}`
        );
      }
    },
    // Sized from the WORST the waits above can grow to, because a runner fixes a
    // test's timeout when the test is defined and cannot resample the load later.
    Math.min(90_000, loadCeilingMs(12_000) + loadCeilingMs(4_000) + 20_000)
  );

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
  function turnEnds(rootFor?: () => string | undefined): {
    handle: SkillsWatcherHandle;
    fire: (sessionId: string, kind: 'turn_end' | 'interaction_resolved') => Promise<void>;
    setRoot: (value: string | undefined) => void;
    stop: () => void;
  } {
    const handle = startSkillsWatcher({
      dorkHome,
      roots: () => [],
      coalesceMs: 10,
      sweepMs: 0,
      rearmMs: 0,
      settleMs: 0,
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
      rootForSession: () => Promise.resolve(rootFor ? rootFor() : root),
    });
    return {
      handle,
      // The listener detaches its own work so the projector's ingest is never
      // held up, which makes "the turn ended" and "the projection was scheduled"
      // two different moments. Waited on through the hook's own barrier rather
      // than by counting ticks: production awaits `resolveForSession`, so how
      // many turns of the event loop that takes is not a fixed number.
      fire: async (id, kind) => {
        listener?.(id, kind);
        await hook.settled();
      },
      setRoot: (value) => {
        root = value;
      },
      stop: () => hook.stop(),
    };
  }

  it('TR-07: projects the first time a turn ends in a project, and not again unchanged', async () => {
    const turns = turnEnds();
    expect(turns.handle.watchedRoots()).toEqual([]);

    // DorkOS has no record of what this tree looked like before the session, so
    // the first turn projects rather than assuming nothing happened.
    await turns.fire('s1', 'turn_end');
    await turns.handle.flush();
    expect(projections.mock.calls.length).toBe(1);
    expect(occupied(join(repo, '.claude', 'skills', 'baseline'))).toBe(true);

    // Nothing about the project's skills changed, so there is nothing to do.
    await turns.fire('s1', 'turn_end');
    await turns.handle.flush();
    expect(projections.mock.calls.length).toBe(1);

    turns.stop();
  });

  it('TR-07: projects again once a turn has changed which skills the project has', async () => {
    const turns = turnEnds();
    await turns.fire('s1', 'turn_end');
    await turns.handle.flush();
    projections.mockClear();

    writeAt(join(skillsDir(), 'written-by-a-turn', 'SKILL.md'), skillBody('written-by-a-turn'));

    await turns.fire('s1', 'turn_end');
    await turns.handle.flush();

    expect(projections.mock.calls.length).toBe(1);
    expect(occupied(join(repo, '.claude', 'skills', 'written-by-a-turn'))).toBe(true);
    turns.stop();
  });

  it('TR-07: ignores a person answering a prompt mid-turn', async () => {
    const turns = turnEnds();

    await turns.fire('s1', 'interaction_resolved');
    await turns.handle.flush();

    // The runtime is still writing at that moment, which is the one point a
    // projection must not run.
    expect(projections).not.toHaveBeenCalled();
    turns.stop();
  });

  it('TR-07: does nothing for a session no runtime can place', async () => {
    const turns = turnEnds();
    turns.setRoot(undefined);

    await turns.fire('s1', 'turn_end');
    await turns.handle.flush();

    expect(projections).not.toHaveBeenCalled();
    turns.stop();
  });

  it('TR-07: writes nothing when the session ran outside the boundary, and says why', async () => {
    // The whole shape of the hazard, driven through the REAL path rather than
    // through `projectIfSkillsChanged` directly: a session whose working
    // directory a scheduled task bound with no boundary call at all
    // (`routes/tasks.ts`), in a repo that carries an old manifest — so the
    // manifest gate lets it through and only the boundary does not.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'skills-watcher-outside-')));
    try {
      writeAt(
        join(outside, '.agents', 'harness.manifest.json'),
        JSON.stringify({ version: 1, harnesses: ['claude-code'], claudeOnlySkills: [] })
      );
      writeAt(join(outside, '.agents', 'skills', 'theirs', 'SKILL.md'), skillBody('theirs'));
      await initBoundary(repo);

      const turns = turnEnds(() => outside);
      await turns.fire('s1', 'turn_end');
      await turns.handle.flush();

      expect(projections).not.toHaveBeenCalled();
      expect(existsSync(join(outside, '.claude'))).toBe(false);
      // And it is not silent about it — once, so a boundary that is refusing
      // every turn is findable rather than merely quiet.
      expect(
        loggerMock.debug.mock.calls.filter(([message]) =>
          String(message).includes('outside the directory boundary')
        )
      ).toHaveLength(1);

      // Said once per root, not once per turn.
      await turns.fire('s2', 'turn_end');
      await turns.handle.flush();
      expect(
        loggerMock.debug.mock.calls.filter(([message]) =>
          String(message).includes('outside the directory boundary')
        )
      ).toHaveLength(1);
      turns.stop();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('TR-07: stops listening when the hook is stopped', async () => {
    const turns = turnEnds();
    turns.stop();

    await turns.fire('s1', 'turn_end');
    await turns.handle.flush();

    expect(projections).not.toHaveBeenCalled();
  });
});
