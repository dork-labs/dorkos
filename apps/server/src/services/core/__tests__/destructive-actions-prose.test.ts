/**
 * The docs must not contradict what actually stops for a person (DOR-509, DOR-555).
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
 *   `meta/archive/positioning-202607/02-positioning.md` and is enforced by review.
 * - **The retired-phrase scan covers published copy, not the whole repo.** Eight
 *   files under `meta/`, `research/`, `decisions/`, and `changelog/` contain
 *   "secure by default" and "sign-in required the moment" legitimately: they are the
 *   copy rules that forbid the phrases and the changelog entry recording the removal.
 *   A repo-wide literal ban would redden the rule stating the ban. See
 *   {@link RETIRED_PHRASES}.
 * - **Three ways to defeat the retired-phrase scan, all found by seeding them.**
 *   Recorded rather than papered over, because the ones a reader can see are the
 *   ones a reader can close:
 *   1. **Hyphenation.** `secure-by-default` is the same claim and the most natural
 *      headline spelling of it, and it is not in {@link RETIRED_PHRASES}. Adding it
 *      is safe (no current file contains it); adding a `[- ]` character class
 *      instead would be the first step toward matching a concept, which this file
 *      argues against, so it stays a literal if somebody adds it.
 *   2. **Line wrapping.** `secure by\ndefault` slips a substring check. Mitigated by
 *      convention rather than by code: `.prettierrc` sets no `proseWrap`, so
 *      Prettier preserves what the author typed and never introduces the break
 *      itself. A hand-wrapped one would pass.
 *   3. **`.js` / `.jsx`.** {@link filesUnder} matches `/\.(mdx?|tsx?)$/`. Mitigated
 *      the same way: `apps/site/src` and `apps/client/src` contain zero `.js`/`.jsx`
 *      files today, and both are TypeScript projects. Widen the pattern the day that
 *      stops being true.
 * - **The exposure-guard pairing check skips `decisions/`.** A cross-reference to
 *   another ADR's mechanism is a citation, not an explanation. See
 *   {@link exposureGuardPages}.
 * - **`specs/` is not scanned, and it has live hits** at
 *   `specs/agent-approval-settings/02-specification.md:265` and `:345`. That is not
 *   an oversight: specs are frozen records of what was true when written, and
 *   DOR-509 scoped them out on purpose. They are named here so the exclusion reads
 *   as a decision rather than a blind spot.
 * - **An author can opt a block out** with the marker `destructive-actions: partial`
 *   in a comment. Prose that names a subset and says so honestly ("there are others;
 *   this is not a list of them") is correct writing, and a guard that reddens it
 *   teaches people to pad unrelated sentences, which is how guards get deleted. The
 *   marker is deliberate and greppable, so an audit can find every use — and since
 *   DOR-555 the audit is a test: {@link MARKER_FILES} pins the exact inventory, and
 *   the whole-file scans honour the marker at whole-file granularity.
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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { registerCapabilitiesResource } from '../mcp-resources/capabilities-resource.js';
import {
  REPO_ROOT,
  USER_ROOTS,
  DEV_ROOTS,
  scannableText,
  PARTIAL_MARKER,
  MARKER_FILES,
  destructiveToolNames,
  destructiveCapabilities,
  destructiveActionLabels,
  codeLabelSpellings,
  PLAIN_LANGUAGE,
  UNTIERED_CLAIM,
  SOLE_ACTION_CLAIM,
  UNGATED_CLAIM,
  uncarvedToolAccessClaims,
  PUBLISHED_ROOTS,
  RETIRED_PHRASES,
  EXPOSURE_GUARD_HATCH,
  type ProseFile,
  filesUnder,
  load,
} from './destructive-actions-prose/destructive-actions-prose.fixtures.js';

let userDocs: ProseFile[] = [];

let devDocs: ProseFile[] = [];

let publishedCopy: { rel: string; lower: string }[] = [];

beforeAll(async () => {
  userDocs = await load(USER_ROOTS);
  devDocs = await load(DEV_ROOTS);
  const files = (
    await Promise.all(PUBLISHED_ROOTS.map((root) => filesUnder(root, /\.(mdx?|tsx?)$/)))
  ).flat();
  publishedCopy = await Promise.all(
    files.map(async (file) => {
      const rel = path.relative(REPO_ROOT, file);
      return { rel, lower: scannableText(rel, await readFile(file, 'utf-8')).toLowerCase() };
    })
  );
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

/**
 * Files a whole-file scan must skip: the author marked the page as a corrected
 * historical record.
 *
 * The chunk scans above already honour the marker per chunk, which is the right
 * granularity for "does this list name all of them". The two regex scans below ask
 * a whole-file question, so the marker has to work at whole-file granularity for
 * them or it does not work at all. {@link MARKER_FILES} keeps the set of pages that
 * can use it from growing unseen.
 *
 * @param docs - Files to filter.
 * @returns The files with no marker.
 */
function withoutMarkedFiles(docs: ProseFile[]): ProseFile[] {
  return docs.filter((doc) => !doc.lower.includes(PARTIAL_MARKER));
}

/**
 * The pages the exposure-guard pairing check reads: docs, blog, and dev guides.
 *
 * `decisions/` is deliberately out. An ADR is a dated record, and the sentence that
 * put it out was a CITATION rather than an explanation — "Tunnel + ADR-0320's
 * exposure guard" in
 * `decisions/260727-184933-the-community-server-never-runs-a-members-agent.md`. That
 * is a cross-reference to a mechanism decided elsewhere, and reddening it would push
 * an author to pad an unrelated decision record with a caveat about a flag that
 * record never discussed, or to edit a frozen record to satisfy a guard. The same
 * reasoning already keeps `decisions/archive/` and `specs/` out of this file.
 *
 * @returns The pages to check.
 */
function exposureGuardPages(): ProseFile[] {
  return [...userDocs, ...devDocs.filter((doc) => doc.rel.startsWith('contributing/'))];
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

  it('the partial-marker opt-out is used by exactly the files that declare it', () => {
    // The marker is the one way to switch this guard off for a page. An unnoticed
    // one is a hole the size of a file, so the inventory is pinned: adding a marker
    // has to be a deliberate diff here, and REMOVING a marker that is no longer
    // earned has to be one too.
    const marked = [...userDocs, ...devDocs]
      .filter((doc) => doc.lower.includes(PARTIAL_MARKER))
      .map((doc) => doc.rel)
      .sort();
    expect(
      marked,
      `A file carries "${PARTIAL_MARKER}" that MARKER_FILES does not list, or a listed ` +
        `file no longer carries it. The marker stops the whole-file scans from reading ` +
        `that page; it is not a convention, it is an inventory.`
    ).toEqual([...MARKER_FILES].sort());
  });

  it('no page tells a reader the hand-registered tools carry no tier', () => {
    const offenders = withoutMarkedFiles([...userDocs, ...devDocs])
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
    const offenders = withoutMarkedFiles([...userDocs, ...devDocs])
      .flatMap((doc) =>
        uncarvedToolAccessClaims(doc.lower).map((claim) => `${doc.rel}: "${claim}"`)
      )
      .sort();
    expect(
      offenders,
      'The FOUR documentation toggles decide what an agent is TOLD ABOUT, not what it may ' +
        'call: every group is registered unconditionally (mcp-tools/index.ts) and ' +
        'allowedTools auto-approves rather than restricting (ADR-260726-171347). A sentence ' +
        'promising control over tool access is the one a user acts on when they believe ' +
        'they have sandboxed an agent. ' +
        'The `roomsManage` grant is the exception and IS enforced (ADR 260828-123331) — say ' +
        'so in the same sentence and this guard carves it out.'
    ).toEqual([]);
  });

  it('carves out a TRUE access claim about the rooms grant, and only that one', () => {
    // The carve-out's own test (spec `rooms-management-tools` §Testing, D16). An
    // exception nobody checks is one that quietly widens until the guard is off.
    const trueClaim = 'manage rooms decides which tools this agent can call, and it is enforced.';
    const falseClaim = 'tool groups control which tools an agent can call.';

    // True about the grant, because it names it: allowed.
    expect(uncarvedToolAccessClaims(trueClaim)).toEqual([]);
    // The identical framing WITHOUT the grant named: still the Class A defect.
    expect(uncarvedToolAccessClaims(falseClaim)).not.toEqual([]);
    // And naming the grant elsewhere on the page does not license the blanket
    // claim — the carve-out is per sentence, not per page.
    expect(uncarvedToolAccessClaims(`manage rooms is a lock. ${falseClaim}`)).not.toEqual([]);
  });

  it('reads published copy outside the docs tree', () => {
    // The retired-phrase scan below walks four roots and would pass forever if the
    // walker returned nothing. One of the phrases was on the marketing site, so
    // reaching apps/site is the part worth asserting, not just the total.
    expect(publishedCopy.length).toBeGreaterThan(100);
    expect(publishedCopy.some((file) => file.rel.startsWith('apps/site/src/'))).toBe(true);
    expect(publishedCopy.some((file) => file.rel.startsWith('blog/'))).toBe(true);
  });

  it.each(RETIRED_PHRASES)('no published copy says "%s" again', (phrase) => {
    const offenders = publishedCopy
      .filter((file) => file.lower.includes(phrase))
      .map((file) => file.rel)
      .sort();
    expect(
      offenders,
      `"${phrase}" was retired because it is false, not because it went out of date. ` +
        `Every protection DorkOS has depends on an auth posture, and the default posture ` +
        `trusts every program running as you; the Docker image goes further and sets ` +
        `DORKOS_HOST=0.0.0.0 with DORKOS_ALLOW_INSECURE_BIND=true. State the protection ` +
        `and its posture. The claim that IS true: "it listens only on your own machine ` +
        `by default."`
    ).toEqual([]);
  });

  it('no page explains the exposure guard without naming its escape hatch', () => {
    const offenders = exposureGuardPages()
      .filter((doc) => doc.lower.includes('exposure guard'))
      .filter((doc) => !doc.lower.includes(EXPOSURE_GUARD_HATCH))
      .map((doc) => doc.rel)
      .sort();
    expect(
      offenders,
      'A page describes the exposure guard without mentioning DORKOS_ALLOW_INSECURE_BIND. ' +
        'The guard refuses a wide bind without a login UNLESS that flag is set, and the ' +
        'Docker image we publish sets it (Dockerfile:144-145; exposure-guard.ts:156 returns ' +
        '"allowed" on the flag). Describing the guard without the hatch promises a ' +
        'protection our own artifact does not have.'
    ).toEqual([]);
  });

  it('finds pages that discuss the exposure guard at all', () => {
    // Guards the guard above: if nothing matched "exposure guard", it would pass on
    // an empty set forever.
    expect(
      exposureGuardPages().filter((doc) => doc.lower.includes('exposure guard')).length
    ).toBeGreaterThan(0);
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
