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
 *   `meta/positioning-202607/02-positioning.md` and is enforced by review.
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

/** The docs tree, named separately because two exclusions hang off it. */
const DOCS_ROOT = path.join(REPO_ROOT, 'docs');
/** Release announcements — published copy, read by more people than the docs. */
const BLOG_ROOT = path.join(REPO_ROOT, 'blog');
/**
 * User-facing prose, checked against {@link PLAIN_LANGUAGE}.
 *
 * `blog/` joined this list in DOR-555. It was the gap that let
 * `blog/dorkos-0-8-0.mdx` carry the tool-access claim in its strongest form —
 * "define **exactly** which tools each agent **can access**" — on live public copy
 * while every scanned tree was clean. That post is not rewritten (see
 * {@link MARKER_FILES}); what changes here is that the NEXT post cannot make the
 * claim fresh.
 */
const USER_ROOTS = [DOCS_ROOT, BLOG_ROOT];
/** Dev-facing prose, checked against the derived identifier spellings. */
const DEV_ROOTS = [path.join(REPO_ROOT, 'contributing'), path.join(REPO_ROOT, 'decisions')];

/**
 * Generated from the registry, a released record, or a superseded one.
 *
 * `docs/api/` is projected from `capabilities-domain.ts` and guarded at its source
 * in `capabilities-domain.test.ts`. `changelog-archive.mdx`, `changelog.mdx`, and
 * `decisions/archive/` record what was true when written and must not be rewritten.
 *
 * `changelog.mdx` joined its own archive here in v0.57.0. It is a mirror: every byte
 * is copied from `CHANGELOG.md`, which this file has never scanned and deliberately
 * cannot fix — see {@link RETIRED_PHRASES} on why `changelog/` is out of scope. The
 * entry that forced the question is the one announcing this very guard's subject:
 * `**"Secure by default" is gone.**` A changelog cannot report that a false claim was
 * retired without naming the claim, and editing the mirror to satisfy a scan would
 * make it stop matching the record it mirrors. Excluding the mirror and not the
 * source was an accident of which trees got walked, not a decision.
 */
const EXCLUDED = [
  path.join(DOCS_ROOT, 'api'),
  path.join(DOCS_ROOT, 'changelog-archive.mdx'),
  path.join(DOCS_ROOT, 'changelog.mdx'),
  path.join(REPO_ROOT, 'decisions', 'archive'),
];

/**
 * Where a release post stops being written and starts being a copy.
 *
 * Every post in `blog/` ends with an `## All Changes` section that is the release's
 * `CHANGELOG.md` section verbatim — the same unscanned source `docs/changelog.mdx` is
 * excluded for above. Scanning it reddens a release for quoting a retired claim in
 * order to announce its retirement, and the only ways to clear that are to edit the
 * mirror away from its source or to opt the whole post out.
 *
 * Neither is acceptable, because opting out the whole post is exactly the DOR-555 gap:
 * `blog/dorkos-0-8-0.mdx` carried the tool-access claim in its strongest form in the
 * post's OWN prose, above this line. So one SECTION is cut, not the file: everything
 * above `## All Changes` and everything from the next `## ` heading onward is read as
 * strictly as before, and only the mirrored body between them is skipped.
 *
 * The span matters. A first attempt cut to end-of-file, which silently exempted the
 * `## For contributors` coda a release note may carry after the mirror — proven by
 * seeding a violation there and watching it pass. Skipping a section is a decision;
 * skipping everything that happens to follow it is an accident waiting for the first
 * author who adds a section. {@link MARKER_FILES}' marker sits above `## All Changes`
 * in every file that carries one, so the marker inventory is unaffected.
 */
const RELEASE_NOTE_MIRROR_HEADING = '\n## All Changes';

/** Any level-2 heading, used to find where the mirrored section stops. */
const NEXT_SECTION_HEADING = '\n## ';

/**
 * A file's text, minus the mirrored `## All Changes` section of a release post.
 *
 * Everything before that heading and everything from the next `## ` heading onward is
 * kept, so only the section copied from `CHANGELOG.md` is skipped.
 *
 * @param rel - Repo-relative path, used to recognise a release post.
 * @param text - The file's full contents.
 * @returns The part of the file whose words were written for that file.
 */
function scannableText(rel: string, text: string): string {
  if (!rel.startsWith(`blog${path.sep}`)) return text;
  const start = text.indexOf(RELEASE_NOTE_MIRROR_HEADING);
  if (start === -1) return text;
  const resumes = text.indexOf(NEXT_SECTION_HEADING, start + RELEASE_NOTE_MIRROR_HEADING.length);
  return resumes === -1 ? text.slice(0, start) : text.slice(0, start) + text.slice(resumes);
}

/** An author's deliberate, greppable opt-out for an honestly-disclaimed subset. */
const PARTIAL_MARKER = 'destructive-actions: partial';

/**
 * Every file carrying {@link PARTIAL_MARKER}, pinned so an opt-out is a visible diff.
 *
 * The marker is the one way to make this guard stop looking at something, which
 * makes an unnoticed marker the most valuable thing an author could add by mistake.
 * DOR-509 added two markers and then removed both once the prose was accurate —
 * correctly, since a marker that is no longer needed is a future blind spot. So the
 * inventory is a list, not a convention.
 *
 * `blog/dorkos-0-8-0.mdx` is the first legitimate entry. It describes per-agent tool
 * filtering as controlling which tools an agent can access, which was never true,
 * and it carries a dated correction note saying exactly that. Rewriting the body of
 * a shipped announcement would falsify what we told people, against the security
 * page's own no-quiet-edits stance; archiving it silently would preserve the error
 * unmarked. The marker is the third option: the post stays as published, the
 * correction stays above it, and the guard is told this is a corrected historical
 * record rather than a page it has never looked at. Note the correction note itself
 * repeats the claim in order to name it, so a chunk-level marker would not be enough
 * here — the whole file is opted out of the FILE-level scans.
 */
const MARKER_FILES = ['blog/dorkos-0-8-0.mdx'];

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
  // NOPE.md, in the words the app itself uses for it (DOR-1698). "Changing"
  // rather than "editing", because the write replaces the whole file: whatever
  // the agent's boundaries said before is gone, which is what makes this one
  // irreversible in the same sense as the three above.
  'operator.update_agent_boundaries': "changing an agent's safety boundaries",
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
 *
 * ## The third narrowing, and the reason it is a carve-out rather than a rewrite
 *
 * Since DOR-1611 there IS a tool group that controls access: `roomsManage`, the
 * per-agent grant on the five room-management verbs. It is read fresh off the
 * agent's manifest at `registry.invoke`, the call does not run without it, and
 * the agent cannot set it for itself (ADR 260828-123331). A sentence saying that
 * switch decides what an agent may do is TRUE, and it is exactly the sentence the
 * two Tools tabs now have to say.
 *
 * So the claim is carved out when the sentence carrying it NAMES that grant —
 * the same shape as the `commands?` fix above, for the same reason: reddening a
 * true sentence about a neighbouring mechanism is how a guard earns a reputation
 * for crying wolf, and the next person silences it instead of reading it.
 *
 * **The carve-out is deliberately narrow.** It keys on the grant being named in
 * the same sentence, so a blanket claim about "tool groups" is still caught with
 * `roomsManage` documented three paragraphs away. The four documentation toggles
 * are untouched by it, which is the whole point: the Class A defect was, and
 * still is, a page telling somebody they have sandboxed an agent when they have
 * not.
 */
const TOOL_ACCESS_CLAIM =
  /(?<!not )(?<!never )control which tools[^.]{0,50}agents?[^.]{0,20}can (?:use|access|call)|which tools[^.]{0,40}agents? can (?:use|access|call)|tool groups?[^.]{0,30}available to|(?<!not )(?<!never )restricts? which tools/gi;

/**
 * The one tool group whose access claim is TRUE (DOR-1611).
 *
 * Matched against the SENTENCE a claim sits in, never the whole page: naming the
 * grant somewhere else on the page must not license a blanket claim about the
 * four toggles that still only shape documentation.
 */
const ROOMS_GRANT_SUBJECT = /manage rooms|roomsmanage/i;

/**
 * The sentence a match sits in, for the carve-out to read.
 *
 * Sentence-bounded rather than a fixed character window, so a long true sentence
 * about the grant is carved out whole and a short false one beside it is not
 * accidentally covered by its neighbour.
 *
 * @param text - The whole (lowercased) page.
 * @param index - Where the claim matched.
 * @returns The sentence containing that offset.
 */
function sentenceAround(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf('.', index), text.lastIndexOf('\n', index)) + 1;
  const dot = text.indexOf('.', index);
  const newline = text.indexOf('\n', index);
  const ends = [dot, newline].filter((at) => at !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : text.length;
  return text.slice(start, end);
}

/**
 * Every tool-access claim on a page that is NOT carved out as true.
 *
 * Exported shape rather than an inline scan so the carve-out itself has a test:
 * a guard whose exception nobody checks is an exception that quietly grows.
 *
 * @param text - The whole (lowercased) page.
 * @returns The matched claims that remain false.
 */
function uncarvedToolAccessClaims(text: string): string[] {
  return [...text.matchAll(TOOL_ACCESS_CLAIM)]
    .filter((match) => !ROOMS_GRANT_SUBJECT.test(sentenceAround(text, match.index)))
    .map((match) => match[0]);
}

/**
 * Trees whose text a stranger reads: the docs site, the blog, the marketing site's
 * own components, and the app's UI copy. Markdown AND source, because the sentence
 * DOR-509 had to pull off the marketing site lived in a `.tsx`.
 */
const PUBLISHED_ROOTS = [
  DOCS_ROOT,
  BLOG_ROOT,
  path.join(REPO_ROOT, 'apps', 'site', 'src'),
  path.join(REPO_ROOT, 'apps', 'client', 'src'),
];

/**
 * Claims we retired because they were FALSE, checked over published copy only.
 *
 * Both were introduced by DOR-509's own first pass, which is the point: the fix for
 * a wrong security claim wrote five fresh sentences saying sign-in is required the
 * moment you expose DorkOS. The shipped `Dockerfile:144-145` sets
 * `DORKOS_HOST=0.0.0.0` AND `DORKOS_ALLOW_INSECURE_BIND=true`, and
 * `exposure-guard.ts:156` returns `allowed` on that flag, so the container we
 * publish serves the whole API with login off. One of the five was on public
 * marketing copy. Two reviewers caught them; nothing automated would have.
 *
 * ## Why literal strings, and why only these trees
 *
 * These are substrings, deliberately. A regex over prose reads neither negation nor
 * domain: an earlier guard in this file was written to catch "control which tools
 * your commands can use" and reddened a docs page describing Claude Code's own
 * `allowed-tools`, where the restriction is genuinely real. If a future author wants
 * to ban a CONCEPT rather than a string, that is a conversation, not a regex.
 *
 * And the scan is scoped to {@link PUBLISHED_ROOTS} rather than the whole repo
 * because eight files under `meta/`, `research/`, `decisions/`, and `changelog/`
 * legitimately contain these exact phrases — they are the copy rules that FORBID
 * them ("Do not pair it with 'secure by default'") and the changelog entry recording
 * the removal. A repo-wide literal ban would redden the rule that states the ban,
 * which teaches people the guard cries wolf. Reviewers own those trees; this owns
 * what ships.
 */
const RETIRED_PHRASES = [
  'secure by default',
  'sign-in required the moment',
  'sign in required the moment',
  'signin required the moment',
  'login required the moment',
  'sign-in is required the moment',
];

/**
 * The escape hatch that makes the exposure guard conditional.
 *
 * `DORKOS_ALLOW_INSECURE_BIND=true` makes `exposure-guard.ts` return `allowed` on a
 * wide bind with no login, and the shipped Docker image sets it. A page that
 * explains the guard without naming the flag describes a protection the artifact we
 * publish does not have.
 */
const EXPOSURE_GUARD_HATCH = 'dorkos_allow_insecure_bind';

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

/** Directories that never hold shipped copy. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '__tests__']);

/**
 * Every file under `dir` whose name matches `pattern`, minus the excluded paths.
 *
 * @param dir - Directory to walk.
 * @param pattern - Filename test, e.g. markdown only or markdown plus sources.
 */
async function filesUnder(dir: string, pattern: RegExp): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (EXCLUDED.includes(full)) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      found.push(...(await filesUnder(full, pattern)));
    } else if (pattern.test(entry.name)) found.push(full);
  }
  return found;
}

/** Every `.md`/`.mdx` file under `dir`, minus the excluded paths. */
async function proseFiles(dir: string): Promise<string[]> {
  return filesUnder(dir, /\.mdx?$/);
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
      const rel = path.relative(REPO_ROOT, file);
      const lower = scannableText(rel, await readFile(file, 'utf-8')).toLowerCase();
      const blocks = lower.split(/\n\s*\n/);
      return {
        rel,
        lower,
        blocks,
        units: blocks.flatMap(toUnits),
      };
    })
  );
}

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
