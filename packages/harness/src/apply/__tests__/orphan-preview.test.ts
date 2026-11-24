/**
 * The preview equals the sweep: `checkPlan().orphans` names exactly what the
 * next `applyPlan({ sweepOrphans: true }).swept` removes (DOR-1889).
 *
 * `applyPlan` sweeps six ways; `checkPlan` used to answer for one of them, so a
 * `--check` was silent about nine of the ten paths a `--fix` was about to delete
 * — and, with only a plugin uninstalled, called the tree clean while a sync
 * removed nine files. Both reproductions are staged here as real temp trees:
 * nothing is mocked, because the claim is about files.
 *
 * Every case builds its repo the way a person does — sync once so the
 * projections are real, then delete the source — rather than hand-writing the
 * projected paths, so the fixture cannot drift away from what the engine
 * actually writes.
 *
 * @module apply/__tests__/orphan-preview
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import type { ProjectionPlan } from '../../plan/types.js';
import { applyPlan, checkPlan, findInstalledOrphans } from '../apply.js';
import { findGeneratedOrphans } from '../generated-targets.js';
import { ATOMIC_TMP_SUFFIX, STALE_TEMP_AGE_MS } from '../atomic-write.js';
import { SWEEP_REASONS } from '../sweep-reasons.js';
import { findOrphanedAuthoredLinks } from '../authored-orphans.js';

let repo = '';
let dorkHome = '';
/** Directories a case made unreadable; restored before the tree is removed. */
const chmodded: string[] = [];
afterEach(() => {
  // A mode-000 directory defeats `rmSync -r` as thoroughly as it defeats the
  // scan under test, so the mode goes back before the cleanup runs.
  for (const abs of chmodded.splice(0)) {
    try {
      chmodSync(abs, 0o755);
    } catch {
      /* already gone */
    }
  }
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/**
 * Whether this platform can stage an unreadable directory.
 *
 * Not Windows, where POSIX modes do not mean this, and not root, who reads
 * everything regardless — in both cases the shape under test is not there and
 * asserting about it would be asserting about nothing.
 */
const CAN_STAGE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

/** Make a directory unreadable for the rest of the test. */
function makeUnreadable(abs: string): void {
  chmodSync(abs, 0o000);
  chmodded.push(abs);
}

/**
 * A repo enabling Claude Code, Codex and OpenCode with one authored skill and
 * one project-scoped plugin shipping a skill, a command and a hook — the shape
 * §2.2.1 of `specs/harness-sync-status/02-specification.md` measured.
 *
 * @returns the staged repo root and an empty dork home (no global installs).
 */
function stageRepo(): { repoRoot: string; home: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-preview-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'harness-preview-home-'));

  mkdirSync(join(repoRoot, '.agents', 'skills', 'alpha'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex', 'opencode'] }, null, 2)
  );
  writeFileSync(
    join(repoRoot, '.agents', 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: The alpha skill\n---\n\n# alpha\n'
  );

  const plugin = join(repoRoot, '.dork', 'plugins', 'acme');
  mkdirSync(join(plugin, '.dork'), { recursive: true });
  writeFileSync(
    join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'acme',
      version: '1.0.0',
      type: 'plugin',
      description: 'Acme test plugin',
      layers: ['skills', 'hooks', 'commands'],
    })
  );
  mkdirSync(join(plugin, 'skills', 'greet'), { recursive: true });
  writeFileSync(
    join(plugin, 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: The greet skill\n---\n\n# greet\n'
  );
  mkdirSync(join(plugin, 'commands'), { recursive: true });
  writeFileSync(
    join(plugin, 'commands', 'hello.md'),
    '---\ndescription: Say hello\n---\n\nSay hello.\n'
  );
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  writeFileSync(
    join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo acme' }] }] })
  );

  return { repoRoot, home };
}

/** Sync the staged repo the way `dorkos harness sync --fix` does. */
function sync(repoRoot: string, home: string): void {
  applyPlan(repoRoot, project(repoRoot, { dorkHome: home }), { sweepOrphans: true });
}

describe('checkPlan().orphans is the next applyPlan().swept', () => {
  it('AP-07, VC-01: names all ten paths when a skill is deleted and a plugin uninstalled', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);

    // The person deletes the authored skill and uninstalls the plugin.
    rmSync(join(repo, '.agents', 'skills', 'alpha'), { recursive: true, force: true });
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const plan = project(repo, { dorkHome });
    const preview = checkPlan(repo, plan).orphans;

    // The count first: an empty-versus-empty pass would satisfy set equality.
    expect(preview).toHaveLength(10);
    expect([...preview].sort()).toEqual([
      '.agents/skills/acme__greet',
      '.claude/commands/acme/.gitignore',
      '.claude/commands/acme/hello.md',
      '.claude/settings.local.json',
      '.claude/skills/acme__greet',
      '.claude/skills/alpha',
      '.codex/hooks.json',
      '.codex/hooks.json.dorkos-generated',
      '.opencode/commands/.gitignore',
      '.opencode/commands/acme-hello.md',
    ]);

    // And the sweep that follows takes exactly them — both directions, so
    // neither an undercount nor an overcount can pass.
    const swept = applyPlan(repo, plan, { sweepOrphans: true }).swept;
    expect(swept).toHaveLength(preview.length);
    expect([...swept].sort()).toEqual([...preview].sort());
  });
});

describe('every swept path says why it goes', () => {
  it('AP-07, VC-01: gives each of the ten a reason from the sweep that found it (DOR-1906)', () => {
    // Purpose: a list of ten paths under one heading says nothing about why any
    // of them goes, and the ten go for five different reasons. Seeded defect:
    // give every sweep the same generic sentence — "an orphaned projection",
    // say — and this reds on the first path, because the map below is exact
    // rather than a "has a reason" check.
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);

    rmSync(join(repo, '.agents', 'skills', 'alpha'), { recursive: true, force: true });
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const plan = project(repo, { dorkHome });
    const preview = checkPlan(repo, plan).removals;

    expect(preview).toHaveLength(10);
    expect(Object.fromEntries(preview.map(({ path, reason }) => [path, reason]))).toEqual({
      '.agents/skills/acme__greet': SWEEP_REASONS['installed-skill'],
      '.claude/skills/acme__greet': SWEEP_REASONS['installed-skill'],
      '.claude/skills/alpha': SWEEP_REASONS['authored-link'],
      '.codex/hooks.json': SWEEP_REASONS['generated-hooks'],
      '.codex/hooks.json.dorkos-generated': SWEEP_REASONS['generated-hooks'],
      '.claude/commands/acme/.gitignore': SWEEP_REASONS['command-wrapper'],
      '.claude/commands/acme/hello.md': SWEEP_REASONS['command-wrapper'],
      '.opencode/commands/.gitignore': SWEEP_REASONS['command-wrapper'],
      '.opencode/commands/acme-hello.md': SWEEP_REASONS['command-wrapper'],
      '.claude/settings.local.json': SWEEP_REASONS['settings-hooks'],
    });
    // Five distinct sentences over ten paths, asserted as a number as well as a
    // map: the map above is written in terms of `SWEEP_REASONS`, so a table
    // collapsed to one generic sentence satisfies every line of it and only the
    // count catches it.
    expect(new Set(preview.map(({ reason }) => reason)).size).toBe(5);
    // And one sentence quoted literally, because the map and the count are both
    // about the SHAPE of the table. This is the path that has always had to say
    // more than "removed": the file itself survives.
    expect(preview.find(({ path }) => path === '.claude/settings.local.json')?.reason).toBe(
      'Only the hook entries DorkOS added go; your own settings stay.'
    );

    // And the sweep that follows says the same ten things, path for path — the
    // promise before the click and the receipt after it are one list.
    const applied = applyPlan(repo, plan, { sweepOrphans: true });
    expect([...applied.removals].sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      [...preview].sort((a, b) => a.path.localeCompare(b.path))
    );
  });
});

describe('each find half, against the case its sweep owns', () => {
  it('AP-07, AP-08: findInstalledOrphans names an uninstalled plugin’s links, never a real directory', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    // A person's own directory whose NAME happens to carry `__`. Engine
    // projections are always symlinks, so this is content and stays content.
    mkdirSync(join(repo, '.claude', 'skills', 'my__helper'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'my__helper', 'SKILL.md'), '# mine\n');
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const found = findInstalledOrphans(repo, project(repo, { dorkHome }));

    expect(found.sort()).toEqual(['.agents/skills/acme__greet', '.claude/skills/acme__greet']);
  });

  it('AP-07, HK-11: findGeneratedOrphans names a hooks file it owns with its sidecar, never a hand-written one', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    // Somebody's own Cursor hooks, at one of the paths this finder considers.
    // No sidecar, so nothing proves the engine wrote it, and it is never taken.
    mkdirSync(join(repo, '.cursor'), { recursive: true });
    writeFileSync(join(repo, '.cursor', 'hooks.json'), '{ "mine": true }\n');
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const found = findGeneratedOrphans(repo, project(repo, { dorkHome }));

    expect(found).toEqual(['.codex/hooks.json', '.codex/hooks.json.dorkos-generated']);
  });

  it('AP-07, SK-10: findOrphanedAuthoredLinks names a link whose skill was deleted, not one that resolves', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    // Two authored links exist here; only one loses its source.
    mkdirSync(join(repo, '.agents', 'skills', 'beta'), { recursive: true });
    writeFileSync(
      join(repo, '.agents', 'skills', 'beta', 'SKILL.md'),
      '---\nname: beta\ndescription: The beta skill\n---\n\n# beta\n'
    );
    sync(repo, dorkHome);
    rmSync(join(repo, '.agents', 'skills', 'alpha'), { recursive: true, force: true });

    const found = findOrphanedAuthoredLinks(repo, project(repo, { dorkHome }));

    expect(found).toEqual(['.claude/skills/alpha']);
  });
});

describe('an atomic-write temp file in a swept command directory', () => {
  it('AP-07, AP-10: is named in the preview once it is debris, and never while it is live', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);

    const live = `.claude/commands/acme/.hello.md.90001.beefed${ATOMIC_TMP_SUFFIX}`;
    const stale = `.opencode/commands/.acme-hello.md.90001.beefed${ATOMIC_TMP_SUFFIX}`;
    writeFileSync(join(repo, live), '# somebody is writing this right now\n');
    writeFileSync(join(repo, stale), '# a crash left this behind\n');
    const when = (Date.now() - STALE_TEMP_AGE_MS * 2) / 1000;
    utimesSync(join(repo, stale), when, when);

    // The plan still generates both wrappers: the only orphan here is debris.
    const plan = project(repo, { dorkHome });
    const preview = checkPlan(repo, plan).orphans;

    expect(preview).toEqual([stale]);
    // And the sweep that follows agrees, in both directions.
    expect(applyPlan(repo, plan, { sweepOrphans: true }).swept).toEqual([stale]);
    expect(existsSync(join(repo, live))).toBe(true);
  });
});

describe('a wrapper directory nobody can read', () => {
  it.runIf(CAN_STAGE_UNREADABLE)('AP-07: is not tidied away as though it were empty', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    // A wrapper-shaped directory the plan does not name, which nobody may read.
    // It may hold anything; the sweep cannot know, and "could not look" is not
    // "nothing is here". Before `tryListDir` the empty-listing test said yes and
    // `rmSync` threw EACCES out of the middle of the apply.
    const ghost = join(repo, '.claude', 'commands', 'ghost');
    mkdirSync(ghost, { recursive: true });
    makeUnreadable(ghost);

    const result = applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });

    expect(existsSync(ghost)).toBe(true);
    expect(result.swept.filter((p) => p.startsWith('.claude/commands/ghost'))).toEqual([]);
  });
});

describe('applyPlan refuses to sweep a plan narrowed to one harness', () => {
  it('AP-07: throws rather than deleting the other harnesses’ live projections', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);

    const full = project(repo, { dorkHome });
    const narrowed: ProjectionPlan = {
      ...full,
      narrowedTo: 'codex',
      actions: full.actions.filter((a) => a.harness === 'codex'),
    };

    // Measured before the guard: this swept five LIVE paths, `.claude/skills/
    // acme__greet` and both command dirs among them, on a repo with no orphan
    // in it at all.
    expect(() => applyPlan(repo, narrowed, { sweepOrphans: true })).toThrow(
      /narrowed to one harness/
    );
    expect(existsSync(join(repo, '.claude', 'skills', 'acme__greet'))).toBe(true);
    expect(existsSync(join(repo, '.opencode', 'commands', 'acme-hello.md'))).toBe(true);

    // Without the sweep it is an ordinary narrowed apply, and applies.
    expect(() => applyPlan(repo, narrowed)).not.toThrow();
  });
});
