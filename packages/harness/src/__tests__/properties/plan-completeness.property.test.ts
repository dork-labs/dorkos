/**
 * P6 — nothing a person authored is silent.
 *
 * The drop list is the engine's honesty surface, and it was only ever honest
 * about the kinds the engine already knew how to project. `ArtifactType` had no
 * `agent`, `rule` or `mcp`; `loadClaudeHooks` read one of the two settings files
 * Claude Code merges; skill-frontmatter `hooks:` were never parsed. Those
 * artifacts were not dropped with a reason and not warned about — they were
 * absent from the report, which reads exactly like a repository that does not
 * have them (`meta/harness-sync-capabilities.md` §14 item 2).
 *
 * The property is the general form: over generated repositories, for every
 * artifact `inventory/` finds and every harness the manifest enables, the plan
 * **says something about it** — an action, a drop, or a warning naming its
 * source under its kind.
 *
 * **Why "says something" and not "says exactly one thing".** One source file can
 * hold several artifacts with different fates: `.claude/settings.json` declaring
 * both a `Stop` hook Codex maps and a `Notification` hook it does not appears in
 * `actions` (the generated file) AND in `drops` (the event that had nowhere to
 * go) for the same harness, and both lines are true. What would be a real
 * contradiction is claiming a harness reads a source natively while also
 * reporting it dropped, so that is asserted separately and directly.
 *
 * `arbRepo()` is shared with the four other property files (`./arb-repo.ts`);
 * the rules, subagents, `.mcp.json`, `settings.local.json` hooks and
 * skill-frontmatter hooks it stages were added for this property and harden the
 * rest.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { loadManifest, project } from '../../engine.js';
import { inventorySourceTree, allEntries, type InventoryEntry } from '../../inventory/index.js';
import type { ProjectionAction, ProjectionPlan } from '../../plan/types.js';
import type { HarnessId } from '../../manifest/schema.js';
import {
  arbRepo,
  withRepo,
  RUNS,
  LINKED_RULES_FILE,
  PERSON_SKILL_LINK,
  type RepoSpec,
} from './arb-repo.js';

/**
 * Whether a path the plan names covers the inventoried source.
 *
 * Exact equality, plus one containment case the plan is right to use: authored
 * slash commands are planned per DIRECTORY (`.claude/commands`), because Claude
 * Code namespaces them and every one of them travels or does not travel
 * together, so the line about the directory is the line about each file in it.
 */
function covers(planned: string | undefined, source: string): boolean {
  if (planned === undefined) return false;
  return planned === source || source.startsWith(`${planned}/`);
}

/** Whether one action is a line about this inventory entry, for this harness. */
function names(action: ProjectionAction, entry: InventoryEntry, harness: HarnessId): boolean {
  return (
    action.harness === harness &&
    action.artifact === entry.kind &&
    (covers(action.source, entry.source) || covers(action.target, entry.source))
  );
}

/** Which of the three lists say something about this entry, for this harness. */
function listsNaming(
  plan: ProjectionPlan,
  entry: InventoryEntry,
  harness: HarnessId
): { actions: boolean; drops: boolean; warnings: boolean } {
  return {
    actions: plan.actions.some((a) => names(a, entry, harness)),
    drops: plan.drops.some((a) => names(a, entry, harness)),
    warnings: plan.warnings.some(
      (w) => w.harness === harness && w.artifact === entry.kind && covers(w.source, entry.source)
    ),
  };
}

/**
 * Every source path the generator staged, worked out from the SPEC rather than
 * from the tree.
 *
 * The generator knows what it wrote, so this is an oracle the walk cannot agree
 * with by construction — which is the whole point. A `.claude/skills` entry that
 * is a dead link or a directory with no `SKILL.md` is deliberately absent: those
 * are not skills to anybody.
 */
function stagedSources(spec: RepoSpec): string[] {
  return [
    ...spec.skills.map((name) => `.agents/skills/${name}`),
    ...spec.claudeSkills.map((dir) => `.claude/skills/${dir}`),
    ...(spec.personSkillLink ? [PERSON_SKILL_LINK] : []),
    ...(spec.claudeCommands === 'populated' ? ['.claude/commands/review.md'] : []),
    ...spec.rules.map((rule) => `.claude/rules/${rule.name}.md`),
    ...(spec.linkedRulesDir ? [LINKED_RULES_FILE] : []),
    ...spec.agents.map((agent) => `.claude/agents/${agent}.md`),
    ...(spec.mcpServers ?? []).map(() => '.mcp.json'),
  ].sort();
}

describe('P6 — every authored artifact reaches the report, for every enabled harness', () => {
  it('finds every artifact the generator staged, so a walk that stops early cannot pass', () => {
    // The completeness property above cannot catch a SCANNER gap: its subject is
    // the inventory, so an artifact the walk never sees is not a subject and the
    // property stays green. That is exactly how a non-recursive `.claude/rules`
    // walk and a skipped symlinked directory survived it (DOR-1845 review). This
    // is the missing half — the walk measured against what was actually written.
    let sourcesChecked = 0;

    fc.assert(
      fc.property(arbRepo(), (spec) => {
        withRepo(spec, ({ repoRoot }) => {
          const found = allEntries(inventorySourceTree(repoRoot))
            .map((entry) => entry.source)
            // Hook entries name a file that may hold several events, and the
            // skill-frontmatter ones name a `SKILL.md` inside a skill directory
            // this list already carries. Sources, deduplicated, is the comparison.
            .filter((source) => !source.endsWith('/SKILL.md') && !source.startsWith('.claude/set'));
          const staged = stagedSources(spec);
          sourcesChecked += staged.length;
          expect([...new Set(found)].sort()).toEqual([...new Set(staged)].sort());
        });
      }),
      RUNS
    );

    expect(sourcesChecked).toBeGreaterThan(0);
  });

  it('never leaves an inventoried source unmentioned by an enabled harness', () => {
    // Counted, not assumed: a repository the generator happened to leave empty
    // would pass this vacuously, so the pairs actually examined are tallied and
    // the tally is asserted after the sweep (REVIEW.md, zero-subject pass).
    let pairsChecked = 0;
    const kindsSeen = new Set<string>();

    fc.assert(
      fc.property(arbRepo(), (spec) => {
        withRepo(spec, ({ repoRoot, dorkHome }) => {
          const entries = allEntries(inventorySourceTree(repoRoot));
          const plan = project(repoRoot, { dorkHome });

          for (const harness of loadManifest(repoRoot).harnesses) {
            for (const entry of entries) {
              pairsChecked += 1;
              kindsSeen.add(entry.kind);
              const lists = listsNaming(plan, entry, harness);
              expect({
                harness,
                kind: entry.kind,
                source: entry.source,
                mentioned: lists.actions || lists.drops || lists.warnings,
              }).toEqual({ harness, kind: entry.kind, source: entry.source, mentioned: true });
            }
          }
        });
      }),
      RUNS
    );

    expect(pairsChecked).toBeGreaterThan(0);
    // The five kinds this property exists for, plus the two the engine always
    // had. An alphabet that lost one would make the sweep quietly narrower.
    expect([...kindsSeen].sort()).toEqual(['agent', 'command', 'hook', 'mcp', 'rule', 'skill']);
  });

  it('never claims a harness reads a source natively and drops it at the same time', () => {
    let contradictionsPossible = 0;

    fc.assert(
      fc.property(arbRepo(), (spec) => {
        withRepo(spec, ({ repoRoot, dorkHome }) => {
          const plan = project(repoRoot, { dorkHome });
          const natives = plan.actions.filter((a) => a.kind === 'native' && a.source !== undefined);
          contradictionsPossible += natives.length;

          for (const native of natives) {
            const contradicted = plan.drops.filter(
              (d) =>
                d.harness === native.harness &&
                d.artifact === native.artifact &&
                d.source === native.source
            );
            expect({
              harness: native.harness,
              artifact: native.artifact,
              source: native.source,
              alsoDropped: contradicted.map((d) => d.reason),
            }).toEqual({
              harness: native.harness,
              artifact: native.artifact,
              source: native.source,
              alsoDropped: [],
            });
          }
        });
      }),
      RUNS
    );

    expect(contradictionsPossible).toBeGreaterThan(0);
  });
});
