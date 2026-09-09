/**
 * Property tests for the apply stage's ownership rules (T0 P3 + P4).
 *
 * The generator lives in `arb-repo.ts` — a whole small repository with authored
 * skills, plugins, authored hooks, a random enabled-harness subset, and hostile
 * occupants (a hand-written file at a generated hook target, a real directory at
 * a skill link target, a dead symlink at one of the engine's targets). Each
 * generated repo is materialised into a real temp dir, projected, and applied for
 * real; nothing here is mocked.
 *
 * - **P3 — a conflict never destroys.** Every occupant the person staged holds
 *   the same bytes after apply, and every one of them is named: as a `conflict`
 *   when the plan wanted to write that path and could not, and as `leftAlone`
 *   when the plan never wanted it.
 * - **P3b — a hostile write PATH is answered, not thrown over.** A plain file
 *   where a folder belongs — at any depth of any target — used to raise ENOTDIR,
 *   EEXIST or EACCES out of the middle of the action loop, leaving a half-applied
 *   tree and the six sweeps unreached (AP-11, DOR-1882). Every projection through
 *   it is now a `conflict` whose reason names the folder, and nothing else in the
 *   plan is disturbed. This is the property the generator's narrowing used to
 *   stand in the way of.
 * - **P4 — the sweep touches only what the engine wrote.** After an apply, some
 *   sources are deleted and the repo is re-projected and applied with the sweep
 *   on: every path the sweep removed was written by an earlier apply in this
 *   run, no unowned file is ever removed, and a generated file and its
 *   `.dorkos-generated` sidecar are swept together or not at all. Ownership —
 *   not the manifest — is the whole guard, so an OWNED file whose harness has
 *   left the manifest is swept; that named case lives in
 *   `apply/__tests__/generated-ownership.test.ts`.
 *
 * P2 (no orphan survives) and P2b (`checkPlan` never throws) run off the same
 * generator in `orphaned-links.property.test.ts`. P4 is the other half of
 * DOR-1882's claim — "never deletes anything it did not write" — and it runs
 * over the hostile write paths too, since the generator is shared.
 *
 * The seed is fixed so a failure is reproducible; fast-check prints it (and the
 * shrunk counterexample) in the failure message.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../../apply/apply.js';
import { applyGlobalPlan } from '../../apply/global-apply.js';
import { globalSkillsDir, projectGlobal } from '../../plan/global-projector.js';
import { COPILOT_HOOKS_TARGET } from '../../generate/hooks.js';
import {
  diffSnapshots,
  existsOnDisk,
  readText,
  snapshotTree,
  writeFileAt,
} from '../journeys/stage.js';
import {
  arbRepo,
  HOSTILE_FILE_BYTES,
  isAdoptableLegacy,
  occupantContent,
  PERSON_LINK_PATH,
  PROPERTY_TIMEOUT_MS,
  RUNS,
  SIDECAR_SUFFIX,
  TARGET_HARNESS,
  withRepo,
} from './arb-repo.js';

describe('P3 — a conflict never destroys what somebody else wrote', () => {
  it(
    'leaves every staged occupant byte-identical and names it in conflicts',
    () => {
      fc.assert(
        fc.property(arbRepo(), (spec) => {
          withRepo(spec, ({ repoRoot, dorkHome, occupantAbs }) => {
            const plan = project(repoRoot, { dorkHome });
            const { conflicts, applied, leftAlone } = applyPlan(repoRoot, plan, {
              sweepOrphans: true,
            });
            const conflictTargets = new Set(conflicts.map((c) => c.target));
            const leftAloneTargets = new Set(leftAlone);

            if (
              spec.occupant &&
              occupantAbs &&
              spec.occupant.sidecar !== 'matching' &&
              !isAdoptableLegacy(spec.occupant)
            ) {
              // Unowned and not the engine's own legacy output: the file is the
              // person's. Untouched, and reported — as a conflict when the plan
              // wanted that path, as left alone when not.
              const target = spec.occupant.target;
              expect(readText(occupantAbs)).toBe(occupantContent(target, spec.occupant.shape));
              expect(applied.some((a) => a.target === target)).toBe(false);
              const planned = plan.actions.some(
                (a) => a.kind === 'generate' && a.target === target
              );
              expect({ target, planned, named: true }).toEqual({
                target,
                planned,
                named: planned ? conflictTargets.has(target) : leftAloneTargets.has(target),
              });
              // Never both, so a person is told one thing about one file.
              expect(conflictTargets.has(target) && leftAloneTargets.has(target)).toBe(false);
            }

            if (
              spec.dirOccupant &&
              spec.skills.length > 0 &&
              spec.harnesses.includes('claude-code')
            ) {
              const rel = `.claude/skills/${spec.skills[0]}`;
              expect(readText(join(repoRoot, rel, 'precious.md'))).toBe('# do not delete\n');
              expect(conflictTargets.has(rel)).toBe(true);
            }
          });
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});

describe('P3b — applyPlan answers for a hostile write path, and never throws over one', () => {
  it(
    'AP-11: names every projection a file-where-a-folder-belongs blocks, and writes none of them',
    () => {
      let staged = 0;
      let blockedTargets = 0;
      fc.assert(
        fc.property(arbRepo(), (spec) => {
          withRepo(spec, ({ repoRoot, dorkHome, hostile }) => {
            const plan = project(repoRoot, { dorkHome });
            // The claim, in full: whatever is in the way, this returns.
            const { conflicts, applied } = applyPlan(repoRoot, plan, { sweepOrphans: true });
            if (hostile === undefined) return;
            staged += 1;

            // Every action whose write goes THROUGH the staged file is a named
            // conflict rather than an exception, and none of them was applied.
            const through = plan.actions.filter(
              (a) =>
                a.kind !== 'native' &&
                a.kind !== 'drop' &&
                a.target !== undefined &&
                a.target.startsWith(`${hostile}/`)
            );
            const conflicted = new Map(conflicts.map((a) => [a.target, a.reason]));
            const appliedTargets = new Set(applied.map((a) => a.target));
            for (const action of through) {
              blockedTargets += 1;
              const target = action.target as string;
              expect({ target, named: conflicted.has(target) }).toEqual({ target, named: true });
              expect({
                target,
                reason: conflicted.get(target)?.includes(`\`${hostile}\``),
              }).toEqual({ target, reason: true });
              expect({ target, applied: appliedTargets.has(target) }).toEqual({
                target,
                applied: false,
              });
            }

            // And the file is still a file: nothing wrote through it, and
            // nothing replaced it with the folder it was standing in for.
            expect({ hostile, bytes: readText(join(repoRoot, hostile)) }).toEqual({
              hostile,
              bytes: HOSTILE_FILE_BYTES,
            });
          });
        }),
        RUNS
      );
      // Both floors matter: the first says the generator really staged the
      // shape, the second that a plan really wrote through it. Either at zero
      // and the property above is a green over nothing.
      // Both floors, and both carry the live counters so the next reader can
      // see how much slack there is. They are not decoration: with the hostile
      // file placed by a bare `constantFrom` it kept landing on `.cursor` and
      // `.gemini`, where a generated repo plans nothing — 7 repos staged one and
      // exactly ONE projection was ever blocked, which a floor of `> 0` was
      // perfectly happy with. Choosing from the folders THIS spec's plan writes
      // into took the same 40 runs to 33 and 11.
      const counters = `staged=${staged} blockedTargets=${blockedTargets} over ${RUNS.numRuns} runs`;
      expect(staged, counters).toBeGreaterThanOrEqual(10);
      expect(blockedTargets, counters).toBeGreaterThanOrEqual(5);
    },
    PROPERTY_TIMEOUT_MS
  );
});

/**
 * The skill folders P4b breaks after the links are already on disk, and how.
 *
 * A FILE works on every platform and is the shape a person actually produces (a
 * note saved where a folder belongs, a checkout that could not make a link);
 * mode 000 needs POSIX and a non-root user. The package folder is separated from
 * the authored one because they reach the keep-set by different paths — the
 * package scan and `listAuthoredSkills` — and one fix could easily cover only one.
 */
const SKILL_ROOT_BREAKS = [
  { root: '.agents/skills', how: 'file' },
  { root: '.dork/plugins/acme/skills', how: 'file' },
  ...(process.platform !== 'win32' && process.getuid?.() !== 0
    ? ([
        { root: '.agents/skills', how: 'unreadable' },
        { root: '.dork/plugins/acme/skills', how: 'unreadable' },
      ] as const)
    : []),
] as const;

describe('P4b — a sweep never removes a link whose source folder was unlistable', () => {
  it(
    'AP-07: leaves every projection alone while a skill folder cannot be read',
    () => {
      // P4 itself cannot catch this, and the reason is worth stating: the links
      // WERE written by an earlier apply, so they are in its ledger and the
      // sweep is entitled to them by that rule. What makes deleting them wrong
      // is that the plan stopped naming them for a reason that is not "their
      // source is gone" — nobody could look. So this is a separate claim, run
      // over the same generated repositories.
      let broken = 0;
      let linksAtRisk = 0;
      fc.assert(
        fc.property(arbRepo(), fc.nat(), (spec, pick) => {
          withRepo(spec, ({ repoRoot, dorkHome }) => {
            applyPlan(repoRoot, project(repoRoot, { dorkHome }), { sweepOrphans: true });

            const chosen = SKILL_ROOT_BREAKS[pick % SKILL_ROOT_BREAKS.length];
            const abs = join(repoRoot, chosen.root);
            if (!existsOnDisk(abs)) return; // that folder is not in this repo
            // A generated repo may already hold a plain FILE at this root (the
            // `hostile` arbitrary stages one) — that is P3b's subject, not this
            // one's, and a mode-000 FILE would only defeat `snapshotTree`. Break
            // folders, and only folders.
            if (!lstatSync(abs).isDirectory()) return;

            // A mode-000 folder defeats `withRepo`'s `rmSync -r` as thoroughly
            // as it defeats the scan under test, so the mode goes back before
            // this body returns however it returns.
            let madeUnreadable: string | undefined;
            try {
              if (chosen.how === 'file') {
                rmSync(abs, { recursive: true, force: true });
                writeFileAt(abs, 'not a folder\n');
              } else {
                chmodSync(abs, 0o000);
                madeUnreadable = abs;
              }

              // The links at risk are the ones that are there WHEN THE SWEEP
              // RUNS, so the subject is measured after the break rather than
              // before it. Replacing `.agents/skills` with a file removes the
              // links inside it as a matter of arithmetic, and counting those as
              // losses would make this property fail for its own staging —
              // measured, on the first run.
              const beforeSweep = snapshotTree(repoRoot);
              const links = [...beforeSweep.keys()].filter(
                (path) =>
                  beforeSweep.get(path)?.kind === 'symlink' &&
                  (path.startsWith('.claude/skills/') || path.startsWith('.agents/skills/'))
              );
              if (links.length === 0) return; // nothing at risk: nothing to claim
              broken += 1;
              linksAtRisk += links.length;

              const brokenPlan = project(repoRoot, { dorkHome });
              expect(brokenPlan.unreadableSkillRoots).toContain(chosen.root);

              const { swept } = applyPlan(repoRoot, brokenPlan, { sweepOrphans: true });

              // Not one skill link goes while a skill folder is unreadable…
              expect(
                swept.filter(
                  (p) => p.startsWith('.claude/skills/') || p.startsWith('.agents/skills/')
                )
              ).toEqual([]);
              // …and every one that was there is still there, unchanged.
              const after = snapshotTree(repoRoot);
              for (const link of links) {
                expect({ link, entry: after.get(link) }).toEqual({
                  link,
                  entry: beforeSweep.get(link),
                });
              }
              // `--check` says the same, and does not call the tree clean.
              const drift = checkPlan(repoRoot, brokenPlan);
              expect(drift.orphans).toEqual([]);
              expect(drift.clean).toBe(false);
            } finally {
              if (madeUnreadable !== undefined) {
                try {
                  chmodSync(madeUnreadable, 0o755);
                } catch {
                  /* already gone */
                }
              }
            }
          });
        }),
        RUNS
      );
      // Both floors, because either at zero makes the property a green over
      // nothing: one says a folder was really broken, the other that there were
      // really links to lose when it was.
      expect(broken, 'no generated repo had a skill folder to break').toBeGreaterThan(0);
      expect(linksAtRisk, 'no link was ever at risk when one was broken').toBeGreaterThan(0);
    },
    PROPERTY_TIMEOUT_MS
  );
});

describe('P4 — the sweep removes only what an earlier apply wrote', () => {
  it(
    'never sweeps a path it did not write, a disabled harness, or a file without its sidecar',
    () => {
      fc.assert(
        fc.property(arbRepo(), fc.boolean(), (spec, dropPlugins) => {
          withRepo(spec, ({ repoRoot, dorkHome }) => {
            const before = snapshotTree(repoRoot);
            const firstPlan = project(repoRoot, { dorkHome });
            applyPlan(repoRoot, firstPlan, { sweepOrphans: true });
            const afterFirst = snapshotTree(repoRoot);

            // The ledger: everything the first apply created or rewrote, plus any
            // occupant the generator staged as already engine-owned (a matching
            // sidecar) — the engine may legitimately sweep its own file, and a
            // no-op rewrite leaves no trace in the diff.
            const { added, changed } = diffSnapshots(before, afterFirst);
            const ledger = new Set([...added, ...changed]);
            if (spec.occupant?.sidecar === 'matching') {
              ledger.add(spec.occupant.target);
              ledger.add(`${spec.occupant.target}${SIDECAR_SUFFIX}`);
            }
            if (spec.widowedSidecar) ledger.add(`${COPILOT_HOOKS_TARGET}${SIDECAR_SUFFIX}`);
            // Deliberately NO exception for the generated dead `.claude/skills`
            // link: the FIRST apply sweeps it, so it can never appear in the second
            // apply's `swept` and an entry for it would be a licence nothing uses.
            // The person's own dead link gets no exception either — that is the
            // point of staging it.

            // Remove sources, so the second pass has orphans to sweep.
            if (dropPlugins) {
              rmSync(join(repoRoot, '.dork', 'plugins'), { recursive: true, force: true });
            } else if (spec.skills.length > 0) {
              rmSync(join(repoRoot, '.agents', 'skills', spec.skills[0]), {
                recursive: true,
                force: true,
              });
            }

            const secondPlan = project(repoRoot, { dorkHome });
            const { swept } = applyPlan(repoRoot, secondPlan, { sweepOrphans: true });
            const sweptSet = new Set(swept);
            // The one path the generator guarantees the engine does NOT own — and
            // may not adopt either, so it must survive every sweep.
            const unowned =
              spec.occupant &&
              spec.occupant.sidecar !== 'matching' &&
              !isAdoptableLegacy(spec.occupant)
                ? spec.occupant.target
                : undefined;

            for (const path of swept) {
              expect({ path, inLedger: ledger.has(path) }).toEqual({ path, inLedger: true });

              const base = path.endsWith(SIDECAR_SUFFIX)
                ? path.slice(0, -SIDECAR_SUFFIX.length)
                : path;
              if (!TARGET_HARNESS[base]) continue;

              // Ownership is the whole guard: an unowned file is never swept.
              expect({ path, unowned }).not.toEqual({ path, unowned: base });

              // A generated file and its sidecar go together — except a widowed
              // sidecar, which the sweep may take on its own precisely because
              // there is no file left to pair it with.
              expect(sweptSet.has(`${base}${SIDECAR_SUFFIX}`)).toBe(true);
              const filePresent = existsOnDisk(join(repoRoot, base));
              expect({ base, fileSwept: sweptSet.has(base) }).toEqual({
                base,
                fileSwept: sweptSet.has(base) || !filePresent,
              });
            }

            // Nothing the person owns is ever gone, and it still holds their bytes.
            if (
              spec.occupant &&
              spec.occupant.sidecar !== 'matching' &&
              !isAdoptableLegacy(spec.occupant)
            ) {
              const abs = join(repoRoot, spec.occupant.target);
              expect({ path: spec.occupant.target, present: existsOnDisk(abs) }).toEqual({
                path: spec.occupant.target,
                present: true,
              });
              expect(readText(abs)).toBe(
                occupantContent(spec.occupant.target, spec.occupant.shape)
              );
            }

            // Their own dead link is dead, is a symlink, and sits in a projection
            // dir — and points somewhere DorkOS has no claim over, so it stays.
            if (spec.personLink) {
              expect({
                path: PERSON_LINK_PATH,
                present: existsOnDisk(join(repoRoot, PERSON_LINK_PATH)),
              }).toEqual({ path: PERSON_LINK_PATH, present: true });
            }
          });
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});

/**
 * One generated dork home: some globally installed packages, and the hostile
 * shapes a person's own home directory really holds.
 *
 * The three that matter are all `__`-named entries the two-clause repository
 * predicate would happily remove: a real DIRECTORY somebody wrote, a SYMLINK
 * somebody made into a directory they wrote (the operator's own shape), and a
 * link into a directory whose name merely starts with `plugins`. Clause 3 is the
 * only thing standing between any of them and the sweep.
 */
interface GlobalHomeSpec {
  packages: { name: string; skills: string[] }[];
  personDir: boolean;
  personLink: boolean;
  neighbourLink: boolean;
  nestedLink: boolean;
  /**
   * A person's own shortcut INTO an installed package, named without `__`.
   *
   * The one hostile shape clause 2 alone protects: the package it points at is
   * installed and enumerated, so clause 4 would call the link an orphan, and
   * only the missing `__` keeps it. Without it in the generator, deleting clause
   * 2 left the whole property green.
   */
  plainLink: boolean;
  uninstall: string[];
}

/** A generated dork home, and the temp directory it was written into. */
interface StagedHome {
  dorkHome: string;
  spec: GlobalHomeSpec;
}

/** A kebab-case package or skill name. */
const arbGlobalName = fc.stringMatching(/^[a-z][a-z0-9]{0,5}(-[a-z0-9]{1,5})?$/);

/** The generator: packages, the person's own shapes, and which packages go away. */
function arbGlobalHome(): fc.Arbitrary<GlobalHomeSpec> {
  return fc
    .record({
      packages: fc.uniqueArray(
        fc.record({
          name: arbGlobalName,
          skills: fc.uniqueArray(arbGlobalName, { minLength: 1, maxLength: 3 }),
        }),
        { selector: (p) => p.name, minLength: 1, maxLength: 3 }
      ),
      personDir: fc.boolean(),
      personLink: fc.boolean(),
      neighbourLink: fc.boolean(),
      nestedLink: fc.boolean(),
      plainLink: fc.boolean(),
      uninstallCount: fc.integer({ min: 0, max: 3 }),
    })
    .map(({ packages, uninstallCount, ...rest }) => ({
      packages,
      ...rest,
      uninstall: packages.slice(0, uninstallCount).map((p) => p.name),
    }));
}

/** Write a generated dork home to disk. */
function stageGlobalHome(spec: GlobalHomeSpec): StagedHome {
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-global-prop-'));
  for (const pkg of spec.packages) {
    const dir = join(dorkHome, 'plugins', pkg.name);
    writeFileAt(
      join(dir, '.dork', 'manifest.json'),
      JSON.stringify({ name: pkg.name, version: '1.0.0', type: 'plugin', description: pkg.name })
    );
    for (const skill of pkg.skills) {
      writeFileAt(
        join(dir, 'skills', skill, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: A skill named ${skill}\n---\nBody.\n`
      );
    }
  }

  const skillsRoot = globalSkillsDir(dorkHome);
  mkdirSync(skillsRoot, { recursive: true });
  if (spec.personDir) {
    writeFileAt(join(skillsRoot, 'mine__helper', 'SKILL.md'), '# mine\n');
  }
  if (spec.personLink) {
    writeFileAt(join(dorkHome, 'mine', 'handmade', 'SKILL.md'), '# handmade\n');
    symlinkSync('../mine/handmade', join(skillsRoot, 'hand__made'));
  }
  if (spec.neighbourLink) {
    writeFileAt(join(dorkHome, 'plugins-elsewhere', 'other', 'SKILL.md'), '# neighbour\n');
    symlinkSync('../plugins-elsewhere/other', join(skillsRoot, 'other__thing'));
  }
  if (spec.plainLink && spec.packages[0]) {
    const pkg = spec.packages[0];
    symlinkSync(
      `../plugins/${pkg.name}/skills/${pkg.skills[0] as string}`,
      join(skillsRoot, 'my-shortcut')
    );
  }
  if (spec.nestedLink && spec.packages[0]) {
    const pkg = spec.packages[0];
    mkdirSync(join(skillsRoot, 'nested'), { recursive: true });
    symlinkSync(
      `../../plugins/${pkg.name}/skills/${pkg.skills[0] as string}`,
      join(skillsRoot, 'nested', 'deep__link')
    );
  }
  return { dorkHome, spec };
}

/** The entries a person owns that must survive every sweep, repo-relative to the dork home. */
function personOwned(spec: GlobalHomeSpec): string[] {
  return [
    ...(spec.personDir ? ['skills/mine__helper'] : []),
    ...(spec.personLink ? ['skills/hand__made'] : []),
    ...(spec.neighbourLink ? ['skills/other__thing'] : []),
    ...(spec.nestedLink && spec.packages[0] ? ['skills/nested/deep__link'] : []),
    ...(spec.plainLink && spec.packages[0] ? ['skills/my-shortcut'] : []),
  ];
}

describe('P4 global — the sweep removes only links whose own text points into our plugins dir', () => {
  it(
    'never sweeps a path an earlier apply did not write, and never one that fails clause 3',
    () => {
      fc.assert(
        fc.property(arbGlobalHome(), (spec) => {
          const { dorkHome } = stageGlobalHome(spec);
          const roots = { dorkHome };
          try {
            const before = snapshotTree(dorkHome);
            applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, {
              sweepOrphans: true,
            });
            const afterFirst = snapshotTree(dorkHome);

            // The ledger: everything the first apply put there. The person's own
            // shapes were staged BEFORE the snapshot, so none of them is in it.
            const { added, changed } = diffSnapshots(before, afterFirst);
            const ledger = new Set([...added, ...changed]);

            for (const name of spec.uninstall) {
              rmSync(join(dorkHome, 'plugins', name), { recursive: true, force: true });
            }

            // Clause 3 is judged on the link's OWN TEXT, so it has to be read
            // before the sweep removes the link. A dangling link — which every
            // uninstalled package leaves behind — still answers.
            const textBySweptPath = new Map<string, string>();
            for (const entry of readdirSync(globalSkillsDir(dorkHome))) {
              const abs = join(globalSkillsDir(dorkHome), entry);
              try {
                textBySweptPath.set(abs, readlinkSync(abs));
              } catch {
                /* not a link: it can never be swept, and needs no text */
              }
            }

            const secondPlan = projectGlobal({ roots, harnesses: [] });
            const { swept } = applyGlobalPlan(secondPlan, roots, { sweepOrphans: true });

            const pluginsRoot = resolve(dorkHome, 'plugins');
            for (const abs of swept) {
              const rel = relative(dorkHome, abs).split(sep).join('/');
              expect({ rel, inLedger: ledger.has(rel) }).toEqual({ rel, inLedger: true });

              // Clause 3, restated as the property: a removal is only allowed
              // when the link's own text resolved lexically was inside our
              // plugins directory.
              const text = textBySweptPath.get(abs);
              const resolved = text === undefined ? '' : resolve(dirname(abs), text);
              expect({
                rel,
                ours: resolved === pluginsRoot || resolved.startsWith(pluginsRoot + sep),
              }).toEqual({ rel, ours: true });
            }

            // Everything the person put there is still there, and still theirs.
            for (const owned of personOwned(spec)) {
              expect({ owned, present: existsOnDisk(join(dorkHome, owned)) }).toEqual({
                owned,
                present: true,
              });
            }
          } finally {
            rmSync(dorkHome, { recursive: true, force: true });
          }
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});
