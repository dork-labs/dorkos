/**
 * P9b — a `native` action's source is somewhere that harness actually looks.
 *
 * P9a asks whether the file exists. This asks the harder half: **would the
 * harness find it?** `harnessCoverage()` (`vendor-facts/coverage.ts`, DOR-1846)
 * walks a real tree the way each vendor's own documentation says that harness
 * walks it, and knows nothing about the projector — so it is an oracle the
 * engine cannot agree with by construction.
 *
 * The defect it is aimed at is the one a file-existence check cannot see. With
 * `harnesses: ['opencode']`, the plan called every installed skill `native`
 * "via the Codex namespaced symlink" — and the source it named, the plugin's own
 * directory under `.dork/plugins`, existed the whole time. P9a passes on that.
 * Nothing linked the skill into `.agents/skills`, so nothing OpenCode reads ever
 * held it, and the coverage walk finds nothing at all.
 *
 * **Two tiers, because the vendors themselves are two different amounts of
 * clear**, and `contributing/harness-sync.md` §5 is explicit that a projected
 * tree does not have an empty `uncertain` list:
 *
 * - **Authored skills — the strict shape §5 prescribes.** The source is in
 *   `discovered`, and any `uncertain` entry about an authored skill is a symlink
 *   reason for a skill that is also discovered by another path. Anything else is
 *   a real finding.
 * - **Installed skills — reachability.** A `<pkg>__<name>` directory breaks
 *   OpenCode's and Cursor's documented name rules twice over (charset, and
 *   must-match-the-directory), and four harnesses do not document whether they
 *   follow a symlink — so on those, an installed skill is legitimately
 *   `uncertain`, and the contract says so (SK-09, SK-12, both unverified until
 *   the H tier runs a real binary). What is NOT legitimate, and is what this
 *   tier pins, is the walk never reaching the skill at all: every installed
 *   `native` source must be somewhere the harness looks, and every reason it is
 *   uncertain must be one of the vendor's own documented unknowns.
 *
 * Both tiers run against a tree that has really been projected and applied, so
 * the links under test are on disk.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan } from '../../apply/apply.js';
import { harnessCoverage, type CoverageResult } from '../../vendor-facts/coverage.js';
import type { HarnessId } from '../../manifest/schema.js';
import type { ProjectionAction } from '../../plan/types.js';
import { arbRepo, withRepo, RUNS } from './arb-repo.js';

/** Resolve through symlinks so a link and its target compare equal. */
function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The vendor-documented unknowns an installed `<pkg>__<name>` skill may legitimately hit. */
const DOCUMENTED_UNKNOWNS = [
  'does not document whether it follows one',
  'does not document whether a skill is keyed by',
  'does not document what it does with such a skill',
  'does not document whether it must',
  'does not document whether it loads once or twice',
  'keys a skill by its frontmatter name',
  'must match its directory, and this SKILL.md has no name',
];

/** Whether every reason given for a path is one of the vendor's documented unknowns. */
function onlyDocumentedUnknowns(coverage: CoverageResult, target: string): boolean {
  return coverage.uncertain
    .filter((u) => realpath(u.path) === target)
    .every((u) => DOCUMENTED_UNKNOWNS.some((known) => u.reason.includes(known)));
}

describe('P9b — a `native` skill is somewhere its harness actually reads', () => {
  it('puts every authored `native` in the harness’s own discovered set', () => {
    let checked = 0;

    fc.assert(
      fc.property(arbRepo(), (spec) => {
        withRepo(spec, ({ repoRoot, dorkHome }) => {
          const plan = project(repoRoot, { dorkHome });
          applyPlan(repoRoot, plan);

          const natives = plan.actions.filter(
            (a): a is ProjectionAction & { source: string } =>
              a.kind === 'native' && a.artifact === 'skill' && a.provenance === 'authored'
          );
          if (natives.length === 0) return;

          const byHarness = new Map<HarnessId, CoverageResult>();
          const coverageFor = (harness: HarnessId): CoverageResult => {
            const cached = byHarness.get(harness);
            if (cached) return cached;
            const fresh = harnessCoverage(harness, repoRoot);
            byHarness.set(harness, fresh);
            return fresh;
          };

          for (const action of natives) {
            checked += 1;
            const target = realpath(join(repoRoot, action.source));
            const coverage = coverageFor(action.harness);
            expect({
              harness: action.harness,
              skill: action.name,
              discovered: coverage.discovered.some((d) => realpath(d.dir) === target),
            }).toEqual({ harness: action.harness, skill: action.name, discovered: true });
          }

          // §5's shape for a projected tree: an authored skill may be uncertain
          // only because it was ALSO reached through the engine's own symlink,
          // and only while it is discovered by its real path too.
          //
          // Scoped to each harness's OWN natives. The union across harnesses made
          // a claim the plan never makes: a skill a person links into
          // `.claude/skills` is a confident `native` for Claude Code, which
          // documents following links, and an honest DROP for OpenCode, which
          // reads the directory and says nothing about links — and the union then
          // demanded OpenCode discover a path OpenCode was never promised
          // (DOR-1845 review). A harness answers for what the plan told it.
          for (const [harness, coverage] of byHarness) {
            const authoredPaths = new Set(
              natives
                .filter((a) => a.harness === harness)
                .map((a) => realpath(join(repoRoot, a.source)))
            );
            for (const entry of coverage.uncertain) {
              if (!authoredPaths.has(realpath(entry.path))) continue;
              expect({ harness, path: entry.path, reason: entry.reason }).toEqual({
                harness,
                path: entry.path,
                reason: expect.stringContaining('does not document whether it follows one'),
              });
              expect(
                coverage.discovered.some((d) => realpath(d.dir) === realpath(entry.path))
              ).toBe(true);
            }
          }
        });
      }),
      RUNS
    );

    expect(checked).toBeGreaterThan(0);
  });

  it('puts every installed `native` somewhere the harness looks, uncertain or not', () => {
    // The tier the false-native fix is measured by. Reverting the unconditional
    // `.agents/skills` link reds this and nothing else in the file.
    let checked = 0;

    fc.assert(
      fc.property(arbRepo(), (spec) => {
        withRepo(spec, ({ repoRoot, dorkHome }) => {
          const plan = project(repoRoot, { dorkHome });
          applyPlan(repoRoot, plan);

          const natives = plan.actions.filter(
            (a): a is ProjectionAction & { source: string } =>
              a.kind === 'native' && a.artifact === 'skill' && a.provenance === 'installed'
          );
          if (natives.length === 0) return;

          for (const action of natives) {
            checked += 1;
            const target = realpath(join(repoRoot, action.source));
            const coverage = harnessCoverage(action.harness, repoRoot);
            const discovered = coverage.discovered.some((d) => realpath(d.dir) === target);
            const uncertain = coverage.uncertain.some((u) => realpath(u.path) === target);

            expect({
              harness: action.harness,
              skill: action.name,
              reached: discovered || uncertain,
            }).toEqual({ harness: action.harness, skill: action.name, reached: true });

            // Uncertain is allowed here (SK-09/SK-12 are unverified), but only
            // for the reasons the vendor's own silence produces.
            expect({
              harness: action.harness,
              skill: action.name,
              onlyDocumented: onlyDocumentedUnknowns(coverage, target),
            }).toEqual({ harness: action.harness, skill: action.name, onlyDocumented: true });
          }
        });
      }),
      RUNS
    );

    expect(checked).toBeGreaterThan(0);
  });
});
