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
  // The same skill that teaches editing an agent, because the decision an agent
  // has to make is "which of these two do I call" (DOR-1698).
  'operator.update_agent_boundaries': 'managing-agents',
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

/**
 * Phrases that CLOSE a list: prose asserting the named actions are all of them.
 *
 * Deliberately narrow, and narrowed TWICE by prose that already exists:
 *
 * - `managing-agents` says `mesh_unregister` "is the only tool you have for removing
 *   an agent". That is a scoped claim about removing agents, and it is true, so a
 *   bare "the only" must not match.
 * - `scheduling-tasks` opens a section with "Both of these are MCP tools with no
 *   `dorkos task` equivalent", meaning `tasks_update` and `tasks_delete`. A first
 *   draft of this regex matched `both of these` and failed on that sentence. `both`
 *   and `these two` are ordinary English that points at whatever was just listed;
 *   they are not closure claims about the destructive set, and including them buys
 *   a false positive per section.
 *
 * What is left is phrasing that can only be read as closing a counted set. It is
 * evadable (see the residuals on the assertion), and that is the accepted side of
 * the tradeoff.
 */
const EXHAUSTIVE_CLAIM = /\bare the (?:two|three|only|ones)\b|\bthe only (?:two|three)\b/i;

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
   * Prose that CLOSES the destructive set must close it correctly.
   *
   * This catches the DOR-509 review finding: "`tasks_delete` and `mesh_unregister`
   * are the two". No ungated-claim regex can see that sentence, because every word
   * of it is about approval being REQUIRED. What was wrong was the arithmetic, and
   * the damage was that an agent reading a closed list of two concludes the third
   * thing is not destructive.
   *
   * Two scoping decisions, both from review reproducing the failure:
   *
   * 1. **The window is the `##` section, not the blank-line block.** The original
   *    defect passes a block-scoped check the moment it is written as a LOOSE
   *    markdown list, since every block then names at most one action. That is not
   *    contrived: `scheduling-tasks` already blank-line-separates the bullets in
   *    the section that owns `tasks_delete`, so the pack's own house style defeats
   *    block scoping.
   * 2. **A closure phrase is required.** Firing on "names two or more" alone taxes
   *    accurate prose: a `scheduling-tasks` sentence contrasting `tasks_delete`
   *    with `mesh_unregister` ("if the user wants the agent gone, that is
   *    `mesh_unregister`, which also waits for an approval") asserts no
   *    completeness and describes both correctly, yet would be rejected, and the
   *    only way to satisfy the guard would be to bolt a marketplace non-sequitur
   *    into a tasks skill. Cross-references between skills are good writing.
   *
   * ## Residuals, stated rather than implied away
   *
   * **A section can name all three and still lie about one.** Review demonstrated
   * it: "`marketplace.uninstall` completes on the first call like any other verb;
   * `tasks_delete` and `mesh_unregister` are the ones that wait for an approval"
   * satisfies both the count and this file's phrase list, and is the DOR-509 bug
   * verbatim. No lexical guard closes that, because the claim is semantic and its
   * vocabulary is unbounded ("completes immediately", "returns right away", "needs
   * nothing"). Do not add a phrase for that one sentence and call the class closed.
   * The real closure is a human reading the pack diff, which is why pack changes
   * are worth reviewing as prose and not only as tests.
   *
   * **Closure phrases can be evaded.** "There are exactly 2 destructive tools"
   * carries none of the phrases below. The tradeoff is deliberate: this direction
   * fails safe (a missed defect) while dropping the phrase requirement fails loud
   * and often (rejecting correct prose), and a guard that cries wolf gets deleted.
   */
  it('never closes the destructive set incompletely', () => {
    const allNames = DESTRUCTIVE_ACTIONS.map((a) => a.label);
    for (const skill of OPERATING_SKILLS_PACK) {
      // `## `-delimited sections: the unit a reader actually takes a claim from.
      for (const section of skill.body.split(/\n(?=## )/)) {
        if (!EXHAUSTIVE_CLAIM.test(section)) continue;
        const named = DESTRUCTIVE_ACTIONS.filter((a) => a.names.some((n) => section.includes(n)));
        if (named.length === 0) continue;
        expect(
          named.length,
          `${skill.name} closes the destructive set ("${EXHAUSTIVE_CLAIM.exec(section)?.[0]}") ` +
            `while naming ${named.length} of ${DESTRUCTIVE_ACTIONS.length} ` +
            `(${named.map((a) => a.label).join(', ')}). An agent reading a closed list ` +
            `concludes the missing one is not destructive. Name all of ${allNames.join(', ')}, ` +
            `or drop the closure phrase.\n\n${section.slice(0, 600)}`
        ).toBe(DESTRUCTIVE_ACTIONS.length);
      }
    }
  });
});
