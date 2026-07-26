/**
 * The seeded skill pack must not contradict the tier table (DOR-509).
 *
 * `seedOperatingSkills` writes the Operating DorkOS pack into every new agent's
 * `.agents/skills/` and into DorkBot's, so a wrong sentence there is not a wrong
 * sentence in a document somebody might read. It is an instruction that models
 * execute. Version 4 of the pack said `tasks_delete` "carries no gate of its own";
 * `tasks_delete` has been `destructive` since DOR-468. An agent that believes the
 * pack does not warn a person before an irreversible delete, and reads the refusal
 * it then gets as a malfunction to retry around.
 *
 * This file is the cross-check that keeps the two honest. It derives the
 * destructive set from `MCP_TOOL_TIERS` rather than naming tools, so promoting a
 * tool to `destructive` puts it under these assertions on the same commit — nothing
 * here has to be remembered.
 *
 * The pack resolves to its SOURCE here, via an alias in `apps/server/vitest.config.ts`.
 * Its `exports` map points `default` at `dist/`, and prose in a stale dist is
 * yesterday's prose: the exact false claim this file exists to catch would sail
 * through against a dist built before the edit that reintroduced it.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { OPERATING_SKILLS_PACK } from '@dorkos/operating-skills';

import { MCP_TOOL_TIERS } from '../mcp-tool-tiers.js';

/** Every hand-registered tool that stops and asks a person. */
const DESTRUCTIVE_TOOLS = Object.entries(MCP_TOOL_TIERS)
  .filter(([, declared]) => declared.tier === 'destructive')
  .map(([name]) => name);

/**
 * Ways the pack has claimed, or could claim, that an action needs nobody's
 * permission. Matched only against prose that names a `destructive` tool, so the
 * true version of the same sentence about an `act` tool ("it runs without an
 * approval", in `managing-agents`) is untouched.
 */
const UNGATED_CLAIM =
  /carries no gate|no gate of its own|carr(?:y|ies) no permission tier|without an approval|needs no approval|no approval (?:is )?(?:needed|required)|not gated|ungated|runs without asking|runs unasked/i;

/** Any mention of approval — the shape a correct sentence about these tools has. */
const APPROVAL_LANGUAGE = /approv/i;

/** Blank-line-separated blocks of a skill body that name `tool`. */
function blocksNaming(body: string, tool: string): string[] {
  return body.split(/\n\s*\n/).filter((block) => block.includes(tool));
}

/** Every (skill, block) pair across the pack that names `tool`. */
function packBlocksNaming(tool: string): { skill: string; block: string }[] {
  return OPERATING_SKILLS_PACK.flatMap((skill) =>
    blocksNaming(skill.body, tool).map((block) => ({ skill: skill.name, block }))
  );
}

describe('operating-skills pack vs MCP_TOOL_TIERS', () => {
  it('has destructive tools to check (the guard is not vacuous)', () => {
    expect(DESTRUCTIVE_TOOLS.length).toBeGreaterThan(0);
  });

  it.each(DESTRUCTIVE_TOOLS)('teaches %s at all', (tool) => {
    // Without this, the fix for a red assertion below would be to delete the
    // sentence — leaving agents seeded with a pack that never mentions the tool
    // that stops for a person, which is worse than the wrong sentence.
    expect(packBlocksNaming(tool).length).toBeGreaterThan(0);
  });

  it.each(DESTRUCTIVE_TOOLS)('never calls %s ungated', (tool) => {
    for (const { skill, block } of packBlocksNaming(tool)) {
      expect(
        UNGATED_CLAIM.test(block),
        `${skill} describes the destructive tool "${tool}" as needing no approval:\n\n${block}`
      ).toBe(false);
    }
  });

  it.each(DESTRUCTIVE_TOOLS)('says an approval is involved wherever it names %s', (tool) => {
    const blocks = packBlocksNaming(tool);
    expect(
      blocks.some(({ block }) => APPROVAL_LANGUAGE.test(block)),
      `No block naming "${tool}" mentions approval. An agent reading the pack learns ` +
        `the tool exists but not that it stops for a person.`
    ).toBe(true);
  });
});
