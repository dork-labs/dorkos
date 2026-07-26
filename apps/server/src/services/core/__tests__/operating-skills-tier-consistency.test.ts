/**
 * The seeded skill pack must not contradict what actually stops for a person
 * (DOR-509).
 *
 * `seedOperatingSkills` writes the Operating DorkOS pack into every new agent's
 * `.agents/skills/` and into DorkBot's, so a wrong sentence there is not a wrong
 * sentence in a document somebody might read. It is an instruction that models
 * execute. Version 4 of the pack said `tasks_delete` "carries no gate of its own";
 * `tasks_delete` has been `destructive` since DOR-468. An agent that believes the
 * pack does not warn a person before an irreversible delete, and reads the refusal
 * it then gets as a malfunction to retry around.
 *
 * ## Why the destructive set is a UNION of two sources
 *
 * DorkOS declares `destructive` in two unrelated places, and a guard that reads
 * one of them is a guard with a blind spot exactly the size of the other. The
 * first version of this file read only `MCP_TOOL_TIERS`, and review immediately
 * found what that missed: a pack sentence saying `tasks_delete` and
 * `mesh_unregister` "are the two" destructive actions, which is false because
 * `marketplace.uninstall` is a `destructive` CAPABILITY on the registry. Worse than
 * a miscount, since it told agents that `marketplace_uninstall` is not destructive,
 * one file away from the bug this pack version exists to fix. Both sources are read
 * here so that class cannot recur.
 *
 * A capability may be named by its id (`marketplace.uninstall`, how `dorkos call`
 * reaches it) or by its MCP tool name (`marketplace_uninstall`, how an in-session
 * agent reaches it). Both spellings count as naming it.
 *
 * ## Why ownership is asserted per skill
 *
 * "Is it mentioned anywhere in the pack" is too weak to be worth asserting. Review
 * proved it: deleting the whole `tasks_delete` bullet from `scheduling-tasks` still
 * passed, because `operating-dorkos` happens to name the tool in passing. Each
 * destructive action is therefore pinned to the skill whose job it is to teach it,
 * and an action with no owner fails rather than being quietly uncovered.
 *
 * The pack resolves to its SOURCE here, via an alias in `apps/server/vitest.config.ts`.
 * Its `exports` map points `default` at `dist/`, and prose in a stale dist is
 * yesterday's prose: reviewers confirmed that without the alias, a seeded false
 * claim passes against a dist built before the edit.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { OPERATING_SKILLS_PACK } from '@dorkos/operating-skills';
import { noopLogger } from '@dorkos/shared/logger';

import { MCP_TOOL_TIERS } from '../mcp-tool-tiers.js';
import { composeDorkOsCapabilityRegistry } from '../self-description/dorkos-registry.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import type { MarketplaceMcpDeps } from '../../marketplace-mcp/marketplace-mcp-tools.js';

/** One thing that stops and asks a person, however DorkOS happens to declare it. */
interface DestructiveAction {
  /** How it is named in failure messages. */
  label: string;
  /** Every spelling the pack may legitimately use to name it. */
  names: string[];
  /** Where it was declared, so a failure says which source grew. */
  source: 'mcp-tool-tiers' | 'capability-registry';
}

/**
 * The skill whose job it is to teach each destructive action.
 *
 * A deliberate table, not a derivation: nothing in the code says which skill owns
 * an action, and one missing from here fails the ownership test rather than going
 * uncovered. Adding a destructive action means deciding which skill teaches it,
 * which is the decision this table forces somebody to make.
 */
const OWNING_SKILL: Record<string, string> = {
  tasks_delete: 'scheduling-tasks',
  mesh_unregister: 'managing-agents',
  'marketplace.uninstall': 'using-the-marketplace',
};

/** Hand-registered tools that stop and ask. */
const destructiveTools: DestructiveAction[] = Object.entries(MCP_TOOL_TIERS)
  .filter(([, declared]) => declared.tier === 'destructive')
  .map(([name]) => ({ label: name, names: [name], source: 'mcp-tool-tiers' as const }));

/** Registry capabilities that stop and ask, by id and by MCP tool name. */
const destructiveCapabilities: DestructiveAction[] = composeDorkOsCapabilityRegistry({
  logger: noopLogger,
  operatorDeps: {} as McpToolDeps,
  marketplaceDeps: {} as MarketplaceMcpDeps,
})
  .capabilities.filter((c) => c.tier === 'destructive')
  .map((c) => ({
    label: c.id,
    names: [c.id, c.surfaces.mcp?.toolName].filter((n): n is string => Boolean(n)),
    source: 'capability-registry' as const,
  }));

const DESTRUCTIVE_ACTIONS: DestructiveAction[] = [...destructiveTools, ...destructiveCapabilities];

/**
 * Ways the pack has claimed, or could claim, that an action needs nobody's
 * permission. Matched only against prose that names a destructive action, so the
 * true version of the same sentence about an `act` tool ("it runs without an
 * approval", in `managing-agents`) is untouched.
 *
 * It cannot read negation, so prose near a destructive action must avoid these
 * phrases outright rather than negate them. That is deliberate, and it has already
 * caught a correct-but-unmatchable draft.
 */
const UNGATED_CLAIM =
  /carries no gate|no gate of its own|carr(?:y|ies) no permission tier|without an approval|needs no approval|no approval (?:is )?(?:needed|required)|not gated|ungated|runs without asking|runs unasked/i;

/** Any mention of approval — the shape a correct sentence about these has. */
const APPROVAL_LANGUAGE = /approv/i;

/** Blank-line-separated blocks of `body` that name any spelling of `action`. */
function blocksNaming(body: string, action: DestructiveAction): string[] {
  return body.split(/\n\s*\n/).filter((block) => action.names.some((n) => block.includes(n)));
}

/** The skill that owns `action`, or `undefined` if nobody claimed it. */
function ownerOf(action: DestructiveAction) {
  const name = OWNING_SKILL[action.label];
  return OPERATING_SKILLS_PACK.find((s) => s.name === name);
}

describe('operating-skills pack vs everything that stops for a person', () => {
  it('reads both declaration sites (neither source is silently empty)', () => {
    // If either hits zero the union has collapsed to one source, and the blind
    // spot this file exists to close is back.
    expect(destructiveTools.length).toBeGreaterThan(0);
    expect(destructiveCapabilities.length).toBeGreaterThan(0);
  });

  it.each(DESTRUCTIVE_ACTIONS)('$label has an owning skill that teaches it', (action) => {
    const owner = ownerOf(action);
    expect(
      owner,
      `No skill in OWNING_SKILL claims "${action.label}" (declared in ${action.source}). ` +
        `Decide which skill teaches it and add it there, rather than leaving a destructive ` +
        `action the pack never mentions.`
    ).toBeDefined();
    expect(
      blocksNaming(owner!.body, action).length,
      `${owner!.name} owns "${action.label}" but never names it.`
    ).toBeGreaterThan(0);
  });

  it.each(DESTRUCTIVE_ACTIONS)('no skill calls $label ungated', (action) => {
    for (const skill of OPERATING_SKILLS_PACK) {
      for (const block of blocksNaming(skill.body, action)) {
        expect(
          UNGATED_CLAIM.test(block),
          `${skill.name} describes the destructive action "${action.label}" as needing no ` +
            `approval:\n\n${block}`
        ).toBe(false);
      }
    }
  });

  it.each(DESTRUCTIVE_ACTIONS)(
    'the skill that owns $label says an approval is involved',
    (action) => {
      const owner = ownerOf(action)!;
      expect(
        blocksNaming(owner.body, action).some((block) => APPROVAL_LANGUAGE.test(block)),
        `${owner.name} names "${action.label}" but no block around it mentions approval. An ` +
          `agent reading it learns the action exists but not that it stops for a person.`
      ).toBe(true);
    }
  );

  /**
   * A block that lists destructive actions must list all of them.
   *
   * This is the assertion that actually catches the DOR-509 review finding, and it
   * is structural rather than phrase-matching on purpose. The defect was prose
   * reading "`tasks_delete` and `mesh_unregister` are the two", which no
   * ungated-claim regex can see: every word of it is about approval being
   * REQUIRED. What was wrong was the arithmetic, and the damage was that an agent
   * reading a closed list of two concludes the third thing is not destructive.
   *
   * "Naming two or more" is the signal for a list. One mention is a reference and
   * stays free; the moment prose enumerates, it has made a completeness claim
   * whether or not it used a counting word, and the count is checkable. Trying to
   * match the counting words instead is the brittle version: `managing-agents`
   * legitimately says `mesh_unregister` "is the only tool you have for removing an
   * agent", which is a scoped claim about removing agents, not a claim about the
   * destructive set.
   */
  it('never enumerates destructive actions incompletely', () => {
    const allNames = DESTRUCTIVE_ACTIONS.map((a) => a.label);
    for (const skill of OPERATING_SKILLS_PACK) {
      for (const block of skill.body.split(/\n\s*\n/)) {
        const named = DESTRUCTIVE_ACTIONS.filter((a) => a.names.some((n) => block.includes(n)));
        if (named.length < 2) continue;
        expect(
          named.length,
          `${skill.name} lists ${named.length} of the ${DESTRUCTIVE_ACTIONS.length} destructive ` +
            `actions (${named.map((a) => a.label).join(', ')}), which reads as a complete list ` +
            `and is not one. Name all of ${allNames.join(', ')}, or mention only one.\n\n${block}`
        ).toBe(DESTRUCTIVE_ACTIONS.length);
      }
    }
  });
});
