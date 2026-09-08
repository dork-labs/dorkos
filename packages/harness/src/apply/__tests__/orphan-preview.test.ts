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
import {
  applyPlan,
  checkPlan,
  findGeneratedCommandOrphans,
  findInstalledOrphans,
  findOpencodeCommandOrphans,
  findSettingsHooksOrphan,
} from '../apply.js';
import { findOrphanedAuthoredLinks } from '../authored-orphans.js';
import { findGeneratedOrphans } from '../generated-targets.js';
import { ATOMIC_TMP_SUFFIX, STALE_TEMP_AGE_MS } from '../atomic-write.js';

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
  it('names all ten paths when a skill is deleted and a plugin uninstalled', () => {
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

  it('is not clean when only the plugin is uninstalled, and names the nine paths', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);

    // Only the plugin goes. The authored skill and its link are untouched, so
    // nothing drifts — and the tree used to read clean while a sync deleted nine.
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const plan = project(repo, { dorkHome });
    const drift = checkPlan(repo, plan);

    expect(drift.clean).toBe(false);
    expect(drift.orphans).toHaveLength(9);
    expect([...drift.orphans].sort()).toEqual([
      '.agents/skills/acme__greet',
      '.claude/commands/acme/.gitignore',
      '.claude/commands/acme/hello.md',
      '.claude/settings.local.json',
      '.claude/skills/acme__greet',
      '.codex/hooks.json',
      '.codex/hooks.json.dorkos-generated',
      '.opencode/commands/.gitignore',
      '.opencode/commands/acme-hello.md',
    ]);

    const swept = applyPlan(repo, plan, { sweepOrphans: true }).swept;
    expect(swept).toHaveLength(drift.orphans.length);
    expect([...swept].sort()).toEqual([...drift.orphans].sort());
  });
});

describe('each find half, against the case its sweep owns', () => {
  it('findInstalledOrphans names an uninstalled plugin’s links, never a real directory', () => {
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

  it('findOrphanedAuthoredLinks names a link whose skill was deleted, not one that resolves', () => {
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

  it('findGeneratedOrphans names a hooks file it owns with its sidecar, never a hand-written one', () => {
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

  it('findGeneratedCommandOrphans names the wrapper and its .gitignore, never an authored file', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    // An authored command sharing the wrapper dir: no marker, so not ours.
    writeFileSync(join(repo, '.claude', 'commands', 'acme', 'mine.md'), '# my own command\n');
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const found = findGeneratedCommandOrphans(repo, project(repo, { dorkHome }));

    expect(found.sort()).toEqual([
      '.claude/commands/acme/.gitignore',
      '.claude/commands/acme/hello.md',
    ]);
  });

  it('findOpencodeCommandOrphans names the wrapper and its .gitignore, never an authored file', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    // The OpenCode command dir is shared and flat, so an authored command sits
    // beside the wrappers and must survive on its missing marker alone.
    writeFileSync(join(repo, '.opencode', 'commands', 'mine.md'), '# my own command\n');
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const found = findOpencodeCommandOrphans(repo, project(repo, { dorkHome }));

    expect(found.sort()).toEqual([
      '.opencode/commands/.gitignore',
      '.opencode/commands/acme-hello.md',
    ]);
  });

  it('findSettingsHooksOrphan names the settings file only while managed hooks are in it', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const plan = project(repo, { dorkHome });
    expect(findSettingsHooksOrphan(repo, plan)).toEqual(['.claude/settings.local.json']);

    // After the sweep the person's own file is still there — only the managed
    // groups went — so asking again answers nothing, and a second `--check` is
    // clean rather than naming a path forever.
    applyPlan(repo, plan, { sweepOrphans: true });
    expect(existsSync(join(repo, '.claude', 'settings.local.json'))).toBe(true);
    expect(findSettingsHooksOrphan(repo, project(repo, { dorkHome }))).toEqual([]);
  });
});

describe('an atomic-write temp file in a swept command directory', () => {
  it('is named in the preview once it is debris, and never while it is live', () => {
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

describe('a plan narrowed to one harness', () => {
  it('reports no orphans, because a --fix on it sweeps nothing', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const full = project(repo, { dorkHome });
    // The narrowing `planWithConsent` does, reduced to what this claim needs.
    const narrowed: ProjectionPlan = {
      ...full,
      narrowedTo: 'codex',
      actions: full.actions.filter((a) => a.harness === 'codex'),
    };

    // Same tree, same instant: the full plan names the nine the plugin left
    // behind, and the narrowed one names none — a Codex-only plan cannot tell a
    // live Claude projection from an orphan, and the `--fix --harness codex` it
    // would recommend refuses to sweep anything at all.
    expect(checkPlan(repo, full).orphans).toHaveLength(9);
    expect(checkPlan(repo, narrowed).orphans).toEqual([]);
    expect(checkPlan(repo, narrowed).clean).toBe(true);
  });
});

describe('a command directory that cannot be listed', () => {
  // Every one of these threw out of `checkPlan` when the command sweeps first
  // gained find halves: `existsSync` says yes to a FILE and to a directory
  // nobody may read, and the bare `readdirSync` behind it then raised ENOTDIR or
  // EACCES — out of the middle of the one command a person runs to be TOLD what
  // is wrong with their tree (`apply.ts`'s own invariant, and AP-05).
  it('is nothing to list rather than an exception, when it is a file', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    // No sync first: a stray file at each path, and nothing projected.
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'commands'), 'a note somebody left here\n');
    mkdirSync(join(repo, '.opencode'), { recursive: true });
    writeFileSync(join(repo, '.opencode', 'commands'), 'and another\n');

    const plan = project(repo, { dorkHome });

    expect(() => checkPlan(repo, plan)).not.toThrow();
    expect(checkPlan(repo, plan).orphans).toEqual([]);
  });

  it.runIf(CAN_STAGE_UNREADABLE)('is nothing to list when nobody may read it', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    makeUnreadable(join(repo, '.claude', 'commands'));
    makeUnreadable(join(repo, '.opencode', 'commands'));

    expect(() => checkPlan(repo, project(repo, { dorkHome }))).not.toThrow();
  });

  it.runIf(CAN_STAGE_UNREADABLE)('is nothing to list when one wrapper dir is unreadable', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    // The dir itself lists fine; the per-package walk inside it is the one that
    // cannot read, which is a second bare `readdirSync` and a second throw.
    makeUnreadable(join(repo, '.claude', 'commands', 'acme'));

    const drift = checkPlan(repo, project(repo, { dorkHome }));

    // Nothing was read there, so nothing is claimed about it: the wrapper files
    // are neither named as orphans nor mistaken for gone.
    expect(drift.orphans.filter((p) => p.startsWith('.claude/commands/'))).toEqual([]);
  });
});

describe('a wrapper directory nobody can read', () => {
  it.runIf(CAN_STAGE_UNREADABLE)('is not tidied away as though it were empty', () => {
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

  it('is still tidied away when it really is empty', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    // The discriminating half: a readable empty wrapper dir still goes, so the
    // fix above is a narrower predicate rather than a disabled one.
    const empty = join(repo, '.claude', 'commands', 'leftover');
    mkdirSync(empty, { recursive: true });

    applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });

    expect(existsSync(empty)).toBe(false);
  });
});

describe('applyPlan refuses to sweep a plan narrowed to one harness', () => {
  it('throws rather than deleting the other harnesses’ live projections', () => {
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

describe('the orphan list is sorted and unique as it leaves the engine', () => {
  it('needs no sorting by its reader', () => {
    const built = stageRepo();
    repo = built.repoRoot;
    dorkHome = built.home;
    sync(repo, dorkHome);
    rmSync(join(repo, '.agents', 'skills', 'alpha'), { recursive: true, force: true });
    rmSync(join(repo, '.dork', 'plugins', 'acme'), { recursive: true, force: true });

    const orphans = checkPlan(repo, project(repo, { dorkHome })).orphans;

    // Compared WITHOUT re-sorting: the six finders run in their own order and
    // the union is what fixes it, so a reader — the CLI, the status endpoint —
    // can print the list as it comes.
    expect(orphans).toEqual([
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
    expect(new Set(orphans).size).toBe(orphans.length);
  });
});
