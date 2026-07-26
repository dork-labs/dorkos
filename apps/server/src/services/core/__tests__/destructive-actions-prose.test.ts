/**
 * The docs must not contradict what actually stops for a person (DOR-509).
 *
 * DorkOS shipped a working approval gate and then described it in docs written
 * before it covered anything. `docs/guides/action-approvals.mdx` said "an agent can
 * delete one of your scheduled tasks without asking first" for weeks after
 * `tasks_delete` became `destructive`, and its size-label table said removing a
 * package was "the one" action with no undo when there were three. Both are the
 * same failure: a count in prose derived from a table in code, with nothing holding
 * the two together.
 *
 * ## Why the destructive set is a UNION of two tables
 *
 * DorkOS declares `destructive` in two unrelated places, and a guard reading one
 * has a blind spot exactly the size of the other:
 *
 * - `MCP_TOOL_TIERS` declares a tier per hand-registered MCP tool. `tasks_delete`
 *   and `mesh_unregister` live here.
 * - `defineCapability` declares a tier per registry capability. `marketplace.uninstall`
 *   lives here.
 *
 * A guard over only the first would bless prose calling those two "the two
 * destructive actions", which is the specific mistake made and caught during this
 * work. Both tables are read here so that class cannot recur.
 *
 * ## Two vocabularies, because the two audiences use different words
 *
 * User docs cannot name `mesh_unregister`; they say "removing an agent". Dev guides
 * do name it. So there are two phrase sets, checked over different trees:
 *
 * - {@link PLAIN_LANGUAGE}: the plain words, checked over `docs/`. Hand-written,
 *   because nothing in the code knows that `mesh_unregister` reads as "removing an
 *   agent" to somebody who does not code.
 * - Derived identifier spellings: checked over `contributing/` and `decisions/`.
 *   This is what catches "The two `destructive` tools, `tasks_delete` and
 *   `mesh_unregister`", which is a completeness claim in identifier form.
 *
 * The FIRST test asserts `PLAIN_LANGUAGE`'s keys are exactly the derived set, so a
 * fourth destructive action fails this file until somebody decides what to call it
 * in plain words. That is the decision that was skipped last time.
 *
 * ## What review found this guard missing, and what is now closed
 *
 * The first version counted phrases per block and let a block naming fewer than two
 * go free. Review broke it three ways, and two are now closed:
 *
 * 1. **CLOSED.** Restoring the byte-exact original defect passed green. "Removing an
 *    installed package is the one today" names ONE action and still makes a
 *    completeness claim, so the "a single mention is just a reference" rule was
 *    itself the hole. {@link SOLE_ACTION_CLAIM} now reads the counting words.
 * 2. **CLOSED.** A block naming all three while saying two of them "run immediately
 *    without asking you" passed green, because counting is not comprehension. That
 *    is a verbatim reintroduction of the original defect. {@link UNGATED_CLAIM} now
 *    reads the description, not just the roll call.
 * 3. **PARTLY OPEN, deliberately. See "Known limits" below.**
 *
 * ## Known limits, stated rather than implied
 *
 * A guard whose docstring oversells it is worse than a missing guard, because the
 * next person stops looking. So:
 *
 * - **A misdescription that avoids every listed phrase still passes.** These are
 *   substring and regex checks over prose. A sentence like "your schedules are yours
 *   alone, nothing here interferes with them" asserts the same false thing as the
 *   original defect and matches nothing. Only a reader catches that.
 * - **The unqualified-posture class (Class D) is not checkable here.** Its defect is
 *   an ABSENCE: a true sentence about a protection that never says which auth
 *   posture makes it true. There is no phrase to match, and a regex for "does this
 *   paragraph mention login" would be noise. The copy rule lives in
 *   `meta/positioning-202607/02-positioning.md` and is enforced by review.
 * - **`specs/` is not scanned, and it has live hits** at
 *   `specs/agent-approval-settings/02-specification.md:265` and `:345`. That is not
 *   an oversight: specs are frozen records of what was true when written, and
 *   DOR-509 scoped them out on purpose. They are named here so the exclusion reads
 *   as a decision rather than a blind spot.
 * - **An author can opt a block out** with the marker `destructive-actions: partial`
 *   in a comment. Prose that names a subset and says so honestly ("there are others;
 *   this is not a list of them") is correct writing, and a guard that reddens it
 *   teaches people to pad unrelated sentences, which is how guards get deleted. The
 *   marker is deliberate and greppable, so an audit can find every use.
 *
 * Files are read from disk as text, so there is no stale-`dist` exposure in the
 * SCANNED prose. The imports below do resolve through the package graph
 * (`@dorkos/shared/logger` resolves to `dist`), but every constant this file
 * ASSERTS ON comes from a relative `apps/server` source import: `MCP_TOOL_TIERS`,
 * the composed registry, and the capabilities resource. The logger is an inert
 * argument. That is the reasoning; an earlier draft said "nothing is aliased",
 * which was misleading in the one file whose job is preventing that mistake.
 *
 * @vitest-environment node
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeAll } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';

import { MCP_TOOL_TIERS } from '../mcp-tool-tiers.js';
import { registerCapabilitiesResource } from '../mcp-resources/capabilities-resource.js';
import { composeDorkOsCapabilityRegistry } from '../self-description/dorkos-registry.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import type { MarketplaceMcpDeps } from '../../marketplace-mcp/marketplace-mcp-tools.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

/** User-facing prose, checked against {@link PLAIN_LANGUAGE}. */
const USER_ROOT = path.join(REPO_ROOT, 'docs');
/** Dev-facing prose, checked against the derived identifier spellings. */
const DEV_ROOTS = [path.join(REPO_ROOT, 'contributing'), path.join(REPO_ROOT, 'decisions')];

/**
 * Generated from the registry, a released record, or a superseded one.
 *
 * `docs/api/` is projected from `capabilities-domain.ts` and guarded at its source
 * in `capabilities-domain.test.ts`. `changelog-archive.mdx` and `decisions/archive/`
 * record what was true when written and must not be rewritten.
 */
const EXCLUDED = [
  path.join(USER_ROOT, 'api'),
  path.join(USER_ROOT, 'changelog-archive.mdx'),
  path.join(REPO_ROOT, 'decisions', 'archive'),
];

/** An author's deliberate, greppable opt-out for an honestly-disclaimed subset. */
const PARTIAL_MARKER = 'destructive-actions: partial';

/** Hand-registered tools that stop and ask. */
function destructiveToolNames(): string[] {
  return Object.entries(MCP_TOOL_TIERS)
    .filter(([, declared]) => declared.tier === 'destructive')
    .map(([name]) => name);
}

/** Registry capabilities that stop and ask, by id and by MCP tool name. */
function destructiveCapabilities(): { id: string; toolName?: string }[] {
  return composeDorkOsCapabilityRegistry({
    logger: noopLogger,
    operatorDeps: {} as McpToolDeps,
    marketplaceDeps: {} as MarketplaceMcpDeps,
  })
    .capabilities.filter((capability) => capability.tier === 'destructive')
    .map((capability) => ({
      id: capability.id,
      ...(capability.surfaces.mcp ? { toolName: capability.surfaces.mcp.toolName } : {}),
    }));
}

/** The union, labelled the way the code labels it. */
function destructiveActionLabels(): string[] {
  return [...destructiveToolNames(), ...destructiveCapabilities().map((c) => c.id)].sort();
}

/**
 * Every spelling a dev guide may use for a destructive action.
 *
 * Derived, so promoting a tool puts it under the completeness check on the same
 * commit. A capability counts by id (`marketplace.uninstall`) or by MCP tool name
 * (`marketplace_uninstall`); both are how somebody legitimately names it.
 */
function codeLabelSpellings(): string[][] {
  return [
    ...destructiveToolNames().map((name) => [name]),
    ...destructiveCapabilities().map((c) => [c.id, c.toolName].filter((s): s is string => !!s)),
  ];
}

/**
 * What a person reading the docs must be told each destructive action is.
 *
 * Hand-written on purpose: nothing in the code knows that `mesh_unregister` reads
 * as "removing an agent" to somebody who does not code. Keep these as the exact
 * phrases the docs use, lowercase, so the match is a substring check with no
 * regex-escaping surprises.
 */
const PLAIN_LANGUAGE: Record<string, string> = {
  'marketplace.uninstall': 'removing an installed package',
  tasks_delete: 'deleting a scheduled task',
  mesh_unregister: 'removing an agent',
};

/**
 * Ways the docs have claimed that the tools outside the catalog answer to nobody.
 *
 * True until DOR-468, false since. It is the premise an agent reasons from when it
 * deletes something and reports that no approval was needed.
 */
const UNTIERED_CLAIM = /carr(?:y|ies) no (?:permission )?tier|no tier at all/i;

/**
 * Counting words that turn one named action into a claim about the whole set.
 *
 * This is the assertion that catches the original DOR-509 defect, which the first
 * version of this file did not: "Removing an installed package is the one today"
 * names a single action, so a count-the-mentions rule skips it, and every word of
 * it is about approval being REQUIRED so an ungated-phrase rule skips it too. What
 * was wrong was the arithmetic.
 */
const SOLE_ACTION_CLAIM =
  /\bis the one\b|\bthe one today\b|\bis the only\b|\bthe only one\b|\bis the sole\b|\bonly action\b/i;

/**
 * Ways prose has described, or could describe, a destructive action as free.
 *
 * Matched only against prose that NAMES a destructive action, so the identical and
 * true sentence about an `act` tool ("almost everything else runs straight away")
 * is untouched. It cannot read negation, so prose near a destructive action must
 * avoid these outright rather than negate them.
 */
const UNGATED_CLAIM =
  /without asking|needs no approval|no approval (?:is )?(?:needed|required)|carries no gate|not gated\b|\bungated\b|runs? unasked|runs? straight away|runs? immediately/i;

/**
 * Access-control framing for tool groups, which is the Class A defect.
 *
 * The toggles decide what an agent is TOLD ABOUT. Nothing anywhere removes a tool
 * from an agent's reach: `mcp-tools/index.ts` registers every group
 * unconditionally, and `allowedTools` auto-approves rather than restricting
 * (ADR-260726-171347). Any sentence promising control over which tools can be used
 * is false, and it is the sentence a user acts on when they believe they have
 * sandboxed an agent.
 *
 * ## Two ways this regex was wrong before review, both fixed by NARROWING it
 *
 * Neither was fixed by editing the prose it fired on, which would have been the
 * cheap and wrong move: both sentences were correct.
 *
 * 1. **Negation.** The CORRECT explanation of this feature uses the same words
 *    negated. `api-reference.md:374` says "It does **not** restrict which tools a
 *    session can call", and the first version reddened the very sentence #492 wrote
 *    to fix this defect. Each arm now carries a negative lookbehind. This only
 *    handles the fixed negations spelled here; a differently-worded negation would
 *    still false-positive, and the answer to that is the partial marker.
 * 2. **Domain.** The pattern must be about DORKOS tool groups. Claude Code's own
 *    `allowed-tools` frontmatter on a slash command is a real restriction enforced
 *    by the harness, so "control which tools your commands can use" in
 *    `slash-commands.mdx` is accurate and must stay. The `commands?` subject is
 *    therefore gone; only `agents?` remains. A guard that reddens true sentences
 *    about a neighbouring mechanism teaches people that it cries wolf.
 */
const TOOL_ACCESS_CLAIM =
  /(?<!not )(?<!never )control which tools[^.]{0,50}agents?[^.]{0,20}can (?:use|access|call)|which tools[^.]{0,40}agents? can (?:use|access|call)|tool groups?[^.]{0,30}available to|(?<!not )(?<!never )restricts? which tools/i;

interface ProseFile {
  /** Repo-relative, so a failure names something a person can open. */
  rel: string;
  /** Lowercased, because the phrases appear mid-sentence and capitalised. */
  lower: string;
  /**
   * Blank-line-separated blocks, lowercased. The granularity for COMPLETENESS.
   *
   * A markdown list is one block, which is right for "does this enumeration name
   * all of them": the list is the claim, not any single bullet.
   */
  blocks: string[];
  /**
   * Blocks split again at markdown list-item boundaries. The granularity for
   * MISDESCRIPTION.
   *
   * Completeness is a property of a list; describing an action as free is a property
   * of one sentence. Review found the cost of conflating them: in
   * `operating-dorkos.mdx` a bullet reading "most settings changes are not gated"
   * sits in the same blank-line block as a different bullet naming all three
   * destructive actions, so a block-level ungated check reddened two unrelated true
   * sentences. Per-bullet is the honest unit for that question.
   */
  units: string[];
}

/** Split one blank-line block into its list items, or return it whole. */
function toUnits(block: string): string[] {
  const parts = block
    .split(/\n(?=\s*(?:[-*+]\s|\d+\.\s))/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [block];
}

/** Every `.md`/`.mdx` file under `dir`, minus the excluded paths. */
async function proseFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (EXCLUDED.includes(full)) continue;
    if (entry.isDirectory()) found.push(...(await proseFiles(full)));
    else if (/\.mdx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Read every prose file under `roots`.
 *
 * @param roots - Directories to walk.
 * @returns One entry per file, lowercased and split into blocks.
 */
async function load(roots: string[]): Promise<ProseFile[]> {
  const files = (await Promise.all(roots.map(proseFiles))).flat();
  return Promise.all(
    files.map(async (file) => {
      const lower = (await readFile(file, 'utf-8')).toLowerCase();
      const blocks = lower.split(/\n\s*\n/);
      return {
        rel: path.relative(REPO_ROOT, file),
        lower,
        blocks,
        units: blocks.flatMap(toUnits),
      };
    })
  );
}

let userDocs: ProseFile[] = [];
let devDocs: ProseFile[] = [];

beforeAll(async () => {
  userDocs = await load([USER_ROOT]);
  devDocs = await load(DEV_ROOTS);
});

/**
 * Chunks of `doc` that name at least one of `spellings`, skipping opted-out chunks.
 *
 * @param doc - The file to search.
 * @param spellings - Each entry is the set of spellings for one action.
 * @param granularity - `blocks` for completeness questions, `units` for
 *   per-sentence misdescription questions. See {@link ProseFile}.
 * @returns The matching chunks, each with the actions it named.
 */
function chunksNaming(
  doc: ProseFile,
  spellings: string[][],
  granularity: 'blocks' | 'units' = 'blocks'
) {
  return doc[granularity]
    .filter((chunk) => !chunk.includes(PARTIAL_MARKER))
    .map((block) => ({
      block,
      named: spellings.filter((forms) => forms.some((form) => block.includes(form.toLowerCase()))),
    }))
    .filter((entry) => entry.named.length > 0);
}

describe('destructive actions vs the docs that describe them (DOR-509)', () => {
  const labels = destructiveActionLabels();

  it('reads both declaration tables (neither source is silently empty)', () => {
    // Either one hitting zero collapses the union to a single table, and the blind
    // spot this file exists to close is back without any test going red.
    expect(destructiveToolNames().length).toBeGreaterThan(0);
    expect(destructiveCapabilities().length).toBeGreaterThan(0);
  });

  it('every destructive action has a phrase the docs can use', () => {
    expect(
      Object.keys(PLAIN_LANGUAGE).sort(),
      'A destructive action was added or removed without deciding what to call it in ' +
        'plain words. Update PLAIN_LANGUAGE, then update the docs that enumerate the set: ' +
        'docs/guides/action-approvals.mdx, docs/guides/operating-dorkos.mdx, ' +
        'docs/self-hosting/threat-model.mdx.'
    ).toEqual(labels);
  });

  it('found files to read in both trees', () => {
    // A walker that silently returns nothing turns every assertion below into a
    // no-op that passes forever.
    expect(userDocs.length).toBeGreaterThan(20);
    expect(devDocs.length).toBeGreaterThan(20);
  });

  it.each(Object.entries(PLAIN_LANGUAGE))(
    '%s is described somewhere in the docs as "%s"',
    (label, phrase) => {
      expect(
        userDocs.filter((doc) => doc.lower.includes(phrase)).length,
        `No page under docs/ says "${phrase}". "${label}" is destructive: it does not run ` +
          `without somebody's approval, and a reader who is never told that plans around a ` +
          `protection they have.`
      ).toBeGreaterThan(0);
    }
  );

  it('no page enumerates the destructive actions incompletely', () => {
    const phrases = Object.values(PLAIN_LANGUAGE);
    const spellings = phrases.map((p) => [p]);
    for (const doc of userDocs) {
      for (const { block, named } of chunksNaming(doc, spellings)) {
        if (named.length < 2) continue;
        expect(
          named.length,
          `${doc.rel} names ${named.length} of the ${phrases.length} things an agent cannot ` +
            `take back (${named.flat().join('; ')}), which reads as a complete list and is not ` +
            `one. Name all of ${phrases.join('; ')}, name only one, or mark the block ` +
            `"${PARTIAL_MARKER}" in a comment if the subset is deliberate and disclaimed.` +
            `\n\n${block.trim()}`
        ).toBe(phrases.length);
      }
    }
  });

  it('no page calls one destructive action the only one', () => {
    const phrases = Object.values(PLAIN_LANGUAGE);
    const spellings = phrases.map((p) => [p]);
    for (const doc of userDocs) {
      for (const { block, named } of chunksNaming(doc, spellings, 'units')) {
        if (named.length >= phrases.length) continue;
        const counting = SOLE_ACTION_CLAIM.exec(block);
        expect(
          counting?.[0],
          `${doc.rel} names ${named.length} of ${phrases.length} destructive actions and calls ` +
            `it "${counting?.[0]}". This is the original DOR-509 defect: the sentence is ` +
            `entirely about approval being REQUIRED, so no ungated-phrase check sees it, and it ` +
            `names one action, so no counting check saw it either. What is wrong is the ` +
            `arithmetic. There are ${phrases.length}: ${phrases.join('; ')}.\n\n${block.trim()}`
        ).toBeUndefined();
      }
    }
  });

  it('no page describes a destructive action as running without asking', () => {
    const spellings = Object.values(PLAIN_LANGUAGE).map((p) => [p]);
    for (const doc of userDocs) {
      for (const { block, named } of chunksNaming(doc, spellings, 'units')) {
        const claim = UNGATED_CLAIM.exec(block);
        expect(
          claim?.[0],
          `${doc.rel} names ${named.flat().join('; ')} and says "${claim?.[0]}". Naming all of ` +
            `them is not enough if the prose then describes one as free: that is the original ` +
            `defect restated, and counting cannot see it. Every action in PLAIN_LANGUAGE stops ` +
            `and asks.\n\n${block.trim()}`
        ).toBeUndefined();
      }
    }
  });

  it('no dev guide enumerates the destructive actions incompletely', () => {
    const spellings = codeLabelSpellings();
    for (const doc of devDocs) {
      for (const { block, named } of chunksNaming(doc, spellings)) {
        if (named.length < 2) continue;
        expect(
          named.length,
          `${doc.rel} names ${named.length} of the ${spellings.length} destructive actions ` +
            `(${named.map((forms) => forms[0]).join(', ')}), which reads as a complete list and ` +
            `is not one. A tier is declared in TWO tables: MCP_TOOL_TIERS and defineCapability. ` +
            `Name all of ${spellings.map((f) => f[0]).join(', ')}, scope the sentence ` +
            `explicitly, or mark the block "${PARTIAL_MARKER}".\n\n${block.trim()}`
        ).toBe(spellings.length);
      }
    }
  });

  it('no page tells a reader the hand-registered tools carry no tier', () => {
    const offenders = [...userDocs, ...devDocs]
      .filter((doc) => UNTIERED_CLAIM.test(doc.lower))
      .map((doc) => doc.rel)
      .sort();
    expect(
      offenders,
      'Absent from the capability catalog and carrying no permission tier are two ' +
        'different facts. All hand-registered MCP tools have carried a tier since ' +
        'DOR-468, enforced in services/core/mcp-tool-gate.ts, and two of them are ' +
        'destructive. Conflating the two tells a reader that half the product runs unasked.'
    ).toEqual([]);
  });

  it('no page promises control over which tools an agent can use', () => {
    const offenders = [...userDocs, ...devDocs]
      .flatMap((doc) => {
        const claim = TOOL_ACCESS_CLAIM.exec(doc.lower);
        return claim ? [`${doc.rel}: "${claim[0]}"`] : [];
      })
      .sort();
    expect(
      offenders,
      'Tool group toggles decide what an agent is TOLD ABOUT, not what it may call. ' +
        'Every group is registered unconditionally (mcp-tools/index.ts) and allowedTools ' +
        'auto-approves rather than restricting (ADR-260726-171347). A sentence promising ' +
        'control over tool access is the one a user acts on when they believe they have ' +
        'sandboxed an agent.'
    ).toEqual([]);
  });

  it('the model-facing capability resource says the same thing the docs do', () => {
    // The `dorkos://capabilities` resource description is read by every MCP client
    // that lists resources, which makes it higher-traffic than any page above and
    // is why it carried the same false sentence for as long.
    let description = '';
    registerCapabilitiesResource(
      {
        registerResource: (_name: string, _uri: string, config: { description: string }) => {
          description = config.description;
        },
        // The real signature is the MCP SDK's overloaded `registerResource`; this
        // captures the one shape this call site uses.
      } as never,
      { catalog: () => ({}) } as never
    );

    expect(description.length).toBeGreaterThan(0);
    expect(UNTIERED_CLAIM.test(description)).toBe(false);
    for (const tool of destructiveToolNames()) {
      expect(
        description,
        `The capabilities resource does not name "${tool}" as destructive. Its whole subject ` +
          `is the tools that are absent from the catalog, so naming the destructive ones is ` +
          `what stops a model reading "absent" as "ungated".`
      ).toContain(tool);
    }
  });
});
