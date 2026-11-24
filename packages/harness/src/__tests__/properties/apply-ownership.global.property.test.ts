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
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { applyGlobalPlan } from '../../apply/global-apply.js';
import { globalSkillsDir, projectGlobal } from '../../plan/global-projector.js';
import { diffSnapshots, existsOnDisk, snapshotTree, writeFileAt } from '../journeys/stage.js';
import { PROPERTY_TIMEOUT_MS, RUNS } from './arb-repo.js';

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
