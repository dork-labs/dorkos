/**
 * Property tests for the apply stage's ownership rules (T0 P3 + P4).
 *
 * `arbRepo()` generates a whole small repository — authored skills, plugins,
 * authored hooks, a random enabled-harness subset, and **hostile occupants**: a
 * file somebody wrote by hand at a generated hook target, and a real directory
 * at a skill link target. Each generated repo is materialised into a real temp
 * dir, projected, and applied for real; nothing here is mocked.
 *
 * - **P3 — a conflict never destroys.** Every occupant the person staged holds
 *   the same bytes after apply, and every one of them is named in `conflicts`.
 * - **P4 — the sweep touches only what the engine wrote.** After an apply, some
 *   sources are deleted and the repo is re-projected and applied with the sweep
 *   on: every path the sweep removed was written by an earlier apply in this
 *   run, never belongs to a harness the manifest does not enable, and a
 *   generated file and its `.dorkos-generated` sidecar are swept together or not
 *   at all.
 *
 * The seed is fixed so a failure is reproducible; fast-check prints it (and the
 * shrunk counterexample) in the failure message.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan } from '../../apply/apply.js';
import { HARNESS_IDS, type HarnessId } from '../../manifest/schema.js';
import {
  CODEX_HOOKS_TARGET,
  CURSOR_HOOKS_TARGET,
  COPILOT_HOOKS_TARGET,
} from '../../generate/hooks.js';
import {
  diffSnapshots,
  existsOnDisk,
  readText,
  snapshotTree,
  writeFileAt,
  writeJsonAt,
} from '../journeys/stage.js';

/** The sidecar suffix the engine writes beside a generated hook file. */
const SIDECAR_SUFFIX = '.dorkos-generated';

/** Which harness owns each generated hook target — the map the sweep must respect. */
const TARGET_HARNESS: Record<string, HarnessId> = {
  [CODEX_HOOKS_TARGET]: 'codex',
  [CURSOR_HOOKS_TARGET]: 'cursor',
  [COPILOT_HOOKS_TARGET]: 'copilot',
};

/** How a staged occupant's sidecar relates to the file beside it. */
type SidecarState = 'none' | 'matching' | 'stale';

/** One generated repository, before it is written to disk. */
interface RepoSpec {
  /** Authored skill names under `.agents/skills`. */
  skills: string[];
  /** Project-scoped installed plugins. */
  plugins: { name: string; skills: string[]; hooks: boolean }[];
  /** Whether `.claude/settings.json` carries authored hooks. */
  authoredHooks: boolean;
  /** The manifest's enabled harnesses (may be empty). */
  harnesses: HarnessId[];
  /** A hand-written file at one generated hook target, or none. */
  occupant: { target: string; sidecar: SidecarState } | null;
  /** Whether a real directory occupies a Claude skill link target. */
  dirOccupant: boolean;
}

/** A small name alphabet, so collisions between authored and plugin skills happen. */
const SKILL_NAMES = ['a', 'b', 'c', 'd'] as const;

/** The generator: a whole small repo, hostile occupants included. */
function arbRepo(): fc.Arbitrary<RepoSpec> {
  return fc.record({
    skills: fc.uniqueArray(fc.constantFrom(...SKILL_NAMES), { maxLength: 4 }),
    plugins: fc.uniqueArray(
      fc.record({
        name: fc.constantFrom('acme', 'flow'),
        skills: fc.uniqueArray(fc.constantFrom(...SKILL_NAMES), { maxLength: 2 }),
        hooks: fc.boolean(),
      }),
      { maxLength: 2, selector: (p) => p.name }
    ),
    authoredHooks: fc.boolean(),
    harnesses: fc.subarray([...HARNESS_IDS]),
    occupant: fc.option(
      fc.record({
        target: fc.constantFrom(CODEX_HOOKS_TARGET, CURSOR_HOOKS_TARGET, COPILOT_HOOKS_TARGET),
        sidecar: fc.constantFrom<SidecarState>('none', 'matching', 'stale'),
      }),
      { nil: null }
    ),
    dirOccupant: fc.boolean(),
  });
}

/**
 * The bytes a hand-written occupant holds. Deliberately NOT the legacy bare
 * event map: this file is unmistakably somebody's own, in the vendor-documented
 * wrapper shape, so the engine has no licence to adopt or rewrite it.
 */
function occupantContent(target: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      description: `hand-written ${target}`,
      hooks: { stop: [{ type: 'command', command: `echo MINE ${target}` }] },
    },
    null,
    2
  )}\n`;
}

/** Materialise a generated repo spec into a fresh temp dir. */
function materialise(spec: RepoSpec): { repoRoot: string; dorkHome: string; occupantAbs?: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-prop-repo-'));
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-prop-home-'));

  writeJsonAt(join(repoRoot, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: spec.harnesses,
  });
  writeFileAt(join(repoRoot, 'AGENTS.md'), '# Project\n');
  for (const name of spec.skills) {
    writeFileAt(join(repoRoot, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  if (spec.authoredHooks) {
    writeJsonAt(join(repoRoot, '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo authored' }] }] },
    });
  }
  for (const plugin of spec.plugins) {
    const dir = join(repoRoot, '.dork', 'plugins', plugin.name);
    writeJsonAt(join(dir, '.dork', 'manifest.json'), {
      schemaVersion: 1,
      name: plugin.name,
      version: '1.0.0',
      type: 'plugin',
      description: `${plugin.name} plugin`,
      layers: ['skills', 'hooks'],
    });
    for (const skill of plugin.skills) {
      writeFileAt(join(dir, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
    }
    if (plugin.hooks) {
      writeJsonAt(join(dir, 'hooks', 'hooks.json'), {
        Stop: [{ hooks: [{ type: 'command', command: `echo ${plugin.name}` }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'echo unmappable' }] }],
      });
    }
  }

  let occupantAbs: string | undefined;
  if (spec.occupant) {
    occupantAbs = join(repoRoot, spec.occupant.target);
    const content = occupantContent(spec.occupant.target);
    writeFileAt(occupantAbs, content);
    if (spec.occupant.sidecar !== 'none') {
      const digested = spec.occupant.sidecar === 'matching' ? content : 'something else';
      writeFileAt(
        `${occupantAbs}${SIDECAR_SUFFIX}`,
        `${createHash('sha256').update(digested).digest('hex')}\n`
      );
    }
  }

  if (spec.dirOccupant && spec.skills.length > 0 && spec.harnesses.includes('claude-code')) {
    writeFileAt(
      join(repoRoot, '.claude', 'skills', spec.skills[0], 'precious.md'),
      '# do not delete\n'
    );
  }

  return { repoRoot, dorkHome, occupantAbs };
}

/** Run `body` against a materialised repo, always cleaning both temp dirs up. */
function withRepo(spec: RepoSpec, body: (dirs: ReturnType<typeof materialise>) => void): void {
  const dirs = materialise(spec);
  try {
    body(dirs);
  } finally {
    for (const d of [dirs.repoRoot, dirs.dorkHome]) rmSync(d, { recursive: true, force: true });
  }
}

/** fast-check settings: modest run count, fixed seed so a failure is reproducible. */
const RUNS = { numRuns: 40, seed: 20260907 } as const;

describe('P3 — a conflict never destroys what somebody else wrote', () => {
  it('leaves every staged occupant byte-identical and names it in conflicts', () => {
    fc.assert(
      fc.property(arbRepo(), (spec) => {
        withRepo(spec, ({ repoRoot, dorkHome, occupantAbs }) => {
          const plan = project(repoRoot, { dorkHome });
          const { conflicts, applied } = applyPlan(repoRoot, plan, { sweepOrphans: true });
          const conflictTargets = new Set(conflicts.map((c) => c.target));

          if (spec.occupant && occupantAbs && spec.occupant.sidecar !== 'matching') {
            // Unowned: the file is the person's. Untouched, and reported.
            expect(readText(occupantAbs)).toBe(occupantContent(spec.occupant.target));
            expect(conflictTargets.has(spec.occupant.target)).toBe(true);
            expect(applied.some((a) => a.target === spec.occupant?.target)).toBe(false);
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
  });
});

describe('P4 — the sweep removes only what an earlier apply wrote', () => {
  it('never sweeps a path it did not write, a disabled harness, or a file without its sidecar', () => {
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
          const enabled = new Set(spec.harnesses);
          const sweptSet = new Set(swept);

          for (const path of swept) {
            expect({ path, inLedger: ledger.has(path) }).toEqual({ path, inLedger: true });

            const base = path.endsWith(SIDECAR_SUFFIX)
              ? path.slice(0, -SIDECAR_SUFFIX.length)
              : path;
            const harness = TARGET_HARNESS[base];
            if (harness) {
              // Scoped to the manifest: a harness nobody enabled is not ours to prune.
              expect({ path, harness, enabled: enabled.has(harness) }).toEqual({
                path,
                harness,
                enabled: true,
              });
              // File and sidecar go together, or not at all.
              expect(sweptSet.has(base)).toBe(true);
              expect(sweptSet.has(`${base}${SIDECAR_SUFFIX}`)).toBe(true);
            }
          }

          // Nothing the person owns is ever gone, and it still holds their bytes.
          if (spec.occupant && spec.occupant.sidecar !== 'matching') {
            const abs = join(repoRoot, spec.occupant.target);
            expect({ path: spec.occupant.target, present: existsOnDisk(abs) }).toEqual({
              path: spec.occupant.target,
              present: true,
            });
            expect(readText(abs)).toBe(occupantContent(spec.occupant.target));
          }
        });
      }),
      RUNS
    );
  });
});
