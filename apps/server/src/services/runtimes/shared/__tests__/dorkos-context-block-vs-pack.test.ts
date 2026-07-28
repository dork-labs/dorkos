/**
 * The seeded `answering-dorkos-questions` skill parses the `<dorkos_context>`
 * block this module builds, and the two live in different packages (DOR-661).
 *
 * The skill's very first step is textual: find the line that starts
 * `Documentation: `, drop the trailing `/llms.txt`, and treat what is left as the
 * documentation base every later URL is built from. That instruction is a
 * contract with `buildDorkosContextBlock()` below, and nothing enforced it.
 * `pack.test.ts` can only assert that the skill file says what the skill file
 * says; it cannot see this module.
 *
 * The drift that motivates this guard is cheap to cause and silent to suffer:
 * rename the label to `Docs:`, or follow DOR-660 with a swap of `llms.txt` for
 * some `llms-index.txt`, and every pack test plus every server test stays green
 * while every seeded agent runs a first step that cannot match the block it is
 * reading. The skill explicitly forbids the only fallback (guessing a production
 * URL), so the failure surfaces as an agent that cannot answer, on every
 * instance, with nothing red anywhere.
 *
 * So both sides are read here and compared. {@link CONTEXT_BLOCK_CONTRACT} is the
 * shared shape: each entry must appear verbatim in the skill body (with `<base>`
 * standing for the address) AND be emitted by the producer (with a real address
 * in that position). Changing either side alone fails.
 *
 * Sibling guard, same seam, different subject:
 * `services/core/__tests__/operating-skills-tier-consistency.test.ts` checks pack
 * prose against everything that declares a `destructive` tier. Both rely on the
 * `@dorkos/operating-skills` alias in `apps/server/vitest.config.ts`, which
 * resolves the pack to its SOURCE: against a stale `dist/` these tests read
 * yesterday's prose and pass.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { OPERATING_SKILLS_PACK } from '@dorkos/operating-skills';

import { _buildDorkosContextBlock as buildDorkosContextBlock } from '../agent-context.js';

/**
 * Every line of the block the skill teaches an agent to read, written the way the
 * skill quotes it. `<base>` marks where the real address goes.
 *
 * Kept as data rather than inlined into one assertion so a third pointer line
 * added to the block, and quoted by the skill, is one entry rather than a new
 * test.
 */
const CONTEXT_BLOCK_CONTRACT = [
  'Documentation: <base>/llms.txt',
  'Full docs: <base>/docs',
] as const;

/** The skill under contract. Absent means the pack dropped it: fail, do not skip. */
const docsSkill = OPERATING_SKILLS_PACK.find((s) => s.name === 'answering-dorkos-questions');

/** A `<base>`-templated contract line as a regex over one real block line. */
function asLineRegex(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace('<base>', '\\S+')}$`, 'm');
}

/**
 * The lines of the block that point an agent at a URL.
 *
 * A URL scheme is the definition because it is what makes a line the skill's
 * business: the block's other lines name subsystems and CLI verbs, none of which
 * carries one. Any future line that sends an agent somewhere is caught by this
 * whether or not anybody remembers this file exists.
 */
function pointerLines(block: string): string[] {
  return block.split('\n').filter((line) => /https?:\/\//.test(line));
}

describe('<dorkos_context> vs the skill that parses it', () => {
  it('the pack still ships the skill this guard is about', () => {
    expect(docsSkill).toBeDefined();
  });

  it('the contract accounts for every pointer line the block emits', () => {
    // One assertion, two holes, both of which turn this file into decoration.
    //
    // 1. INERT GUARD. Four of the cases below are `it.each(CONTEXT_BLOCK_CONTRACT)`,
    //    and `it.each([])` registers ZERO tests while reporting green (vitest 4).
    //    Emptying the contract would delete four of this file's cases with nothing
    //    red anywhere. This case is not `it.each`, so it survives an empty contract
    //    and fails on it: 0 pointer lines expected against 2 emitted.
    //
    // 2. ONE-DIRECTIONAL. The `it.each` cases catch a pointer line that was renamed
    //    or removed. They cannot see one that was ADDED, and the skill body states
    //    the block "carries two lines" and tells agents to read the first. Add an
    //    `API reference:` line and that seeded sentence is false on every instance,
    //    green all the way. Counting is what closes that direction.
    const emitted = pointerLines(buildDorkosContextBlock());
    expect(
      emitted,
      `buildDorkosContextBlock() emits ${emitted.length} pointer line(s) but ` +
        `CONTEXT_BLOCK_CONTRACT describes ${CONTEXT_BLOCK_CONTRACT.length}. A pointer line ` +
        `is one an agent can follow, so all three of these move together: the block, this ` +
        `contract, and the answering-dorkos-questions body (which quotes the lines AND ` +
        `says how many there are).\n\n${emitted.join('\n')}`
    ).toHaveLength(CONTEXT_BLOCK_CONTRACT.length);
  });

  it.each(CONTEXT_BLOCK_CONTRACT)('the skill quotes "%s" verbatim', (template) => {
    expect(
      docsSkill!.body,
      `answering-dorkos-questions no longer quotes "${template}". If the block changed, ` +
        `update the skill body AND this contract together; if the skill stopped teaching ` +
        `this line, remove it from CONTEXT_BLOCK_CONTRACT.`
    ).toContain(template);
  });

  it.each(CONTEXT_BLOCK_CONTRACT)('the block emits "%s" with a real address', (template) => {
    const block = buildDorkosContextBlock();
    expect(
      block,
      `buildDorkosContextBlock() no longer emits a line shaped "${template}". The seeded ` +
        `skill tells every agent to find that line and derive the documentation base from ` +
        `it, so renaming the label or the file here silently breaks docs lookup on every ` +
        `instance. Change both sides, or neither.\n\n${block}`
    ).toMatch(asLineRegex(template));
  });

  it('the skill instruction, executed literally, yields a usable base', () => {
    // Not a restatement of the two assertions above: those pin the shapes, this
    // one runs the skill's actual procedure ("drop the trailing `/llms.txt`") and
    // checks the result is something later URLs can be concatenated onto. A base
    // that came back with a trailing slash would build `//api/search`.
    const line = buildDorkosContextBlock()
      .split('\n')
      .find((l) => l.startsWith('Documentation: '));
    expect(line).toBeDefined();

    const base = line!.slice('Documentation: '.length).replace(/\/llms\.txt$/, '');
    expect(base).not.toMatch(/\/$/);
    expect(() => new URL(`${base}/api/search`)).not.toThrow();
    expect(new URL(`${base}/llms.mdx/docs/concepts/relay`).pathname).toBe(
      '/llms.mdx/docs/concepts/relay'
    );
  });
});
