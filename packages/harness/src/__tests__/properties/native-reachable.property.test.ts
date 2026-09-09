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
import { loadManifest, project } from '../../engine.js';
import { applyPlan } from '../../apply/apply.js';
import { harnessCoverage, type CoverageResult } from '../../vendor-facts/coverage.js';
import { inventorySourceTree } from '../../inventory/index.js';
import { CLAUDE_SKILLS_DIR } from '../../plan/installed-projector.js';
import type { HarnessId } from '../../manifest/schema.js';
import type { ProjectionAction, ProjectionPlan } from '../../plan/types.js';
import { arbRepo, withRepo, PROPERTY_TIMEOUT_MS, RUNS } from './arb-repo.js';

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

/** The one plan line the walk's verdict allows. */
const AGREES = {
  discovered: 'native',
  uncertain: 'warning',
  neither: 'drop',
} as const;

/** What the plan says about one source for one harness, as a single word. */
function plannedFor(plan: ProjectionPlan, harness: HarnessId, source: string): string {
  const kinds = [
    ...plan.actions.filter((a) => a.harness === harness && a.source === source).map((a) => a.kind),
    ...plan.drops.filter((a) => a.harness === harness && a.source === source).map(() => 'drop'),
    ...plan.warnings
      .filter((w) => w.harness === harness && w.source === source)
      .map(() => 'warning'),
  ];
  return kinds.length === 1 ? kinds[0] : `${kinds.length} lines: ${kinds.sort().join('+')}`;
}

describe('P9b — a `native` skill is somewhere its harness actually reads', () => {
  it(
    'puts every authored `native` in the harness’s own discovered set',
    () => {
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
    },
    PROPERTY_TIMEOUT_MS
  );

  it(
    'says about a .claude/skills skill exactly what the walk says',
    () => {
      // P9c. The two answers about one directory, from two sides that share only
      // the facts table: the plan routes `evaluateSkillRules` into native / drop /
      // warning, and `harnessCoverage` walks a real tree into discovered /
      // uncertain / neither. They must map onto each other, three for three.
      //
      // This is the guard for the placement that consulted `readPaths` and
      // `symlinks` and called everything else `native` — `.claude/skills/My_Skill`
      // holding `name: totally-different` was claimed as loading in OpenCode and
      // Cursor while the walk refused to decide (DOR-1845 review). `arbRepo` now
      // stages that directory and three more like it.
      //
      // One carve-out, stated rather than silent: a skill present in BOTH roots.
      // The plan answers about the copy that blocks the canonical projection, and
      // the walk answers a dedupe question about a skill it reached twice. Two
      // different subjects, so they are not compared.
      let compared = 0;
      const seen = new Set<string>();

      fc.assert(
        fc.property(arbRepo(), (spec) => {
          withRepo(spec, ({ repoRoot, dorkHome }) => {
            const plan = project(repoRoot, { dorkHome });
            const inBothRoots = new Set(spec.skills);
            const claudeSkills = inventorySourceTree(repoRoot).skills.filter(
              (skill) => skill.root === CLAUDE_SKILLS_DIR && !inBothRoots.has(skill.name)
            );
            if (claudeSkills.length === 0) return;

            for (const harness of loadManifest(repoRoot).harnesses) {
              const coverage = harnessCoverage(harness, repoRoot);
              for (const skill of claudeSkills) {
                const abs = realpath(join(repoRoot, skill.source));
                const walk = coverage.discovered.some((d) => realpath(d.dir) === abs)
                  ? 'discovered'
                  : coverage.uncertain.some((u) => realpath(u.path) === abs)
                    ? 'uncertain'
                    : 'neither';
                const said = plannedFor(plan, harness, skill.source);
                compared += 1;
                seen.add(`${walk}:${said}`);
                expect({ harness, skill: skill.name, walk, plan: said }).toEqual({
                  harness,
                  skill: skill.name,
                  walk,
                  plan: AGREES[walk],
                });
              }
            }
          });
        }),
        RUNS
      );

      expect(compared).toBeGreaterThan(0);
      // All three outcomes actually occur, so the property is not one branch wide.
      expect([...seen].sort()).toEqual(['discovered:native', 'neither:drop', 'uncertain:warning']);
    },
    PROPERTY_TIMEOUT_MS
  );

  it(
    'puts every installed `native` somewhere the harness looks, uncertain or not',
    () => {
      // The tier the false-native fix is measured by. Reverting the unconditional
      // `.agents/skills` link reds this and nothing else in the file.
      let checked = 0;

      fc.assert(
        fc.property(arbRepo(), (spec) => {
          withRepo(spec, ({ repoRoot, dorkHome }) => {
            const plan = project(repoRoot, { dorkHome });
            const { conflicts } = applyPlan(repoRoot, plan);
            // A `native` claim about an installed skill rides the link another
            // harness's action writes into `.agents/skills`. When something is
            // in the way of that write (the `hostile` arbitrary stages a file
            // there), the link is a blocked conflict and the tree is not the one
            // the plan describes — that claim is DOR-1942's subject, not this
            // property's.
            if (conflicts.length > 0) return;

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
    },
    PROPERTY_TIMEOUT_MS
  );
});
