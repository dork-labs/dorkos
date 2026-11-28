import { readdir, readFile } from 'node:fs/promises';
import { gateViewOf } from '../../capabilities/declarations/gate-action.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noopLogger } from '@dorkos/shared/logger';
import { MCP_TOOL_TIERS } from '../../mcp-tool-tiers.js';
import { composeDorkOsCapabilityRegistry } from '../../self-description/dorkos-registry.js';
import type { AgentToolDeps } from '../../agent-tool-kit/agent-tool-kit.js';
import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';

export const REPO_ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));

/** The docs tree, named separately because two exclusions hang off it. */
export const DOCS_ROOT = path.join(REPO_ROOT, 'docs');

/** Release announcements — published copy, read by more people than the docs. */
export const BLOG_ROOT = path.join(REPO_ROOT, 'blog');

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
export const USER_ROOTS = [DOCS_ROOT, BLOG_ROOT];

/** Dev-facing prose, checked against the derived identifier spellings. */
export const DEV_ROOTS = [path.join(REPO_ROOT, 'contributing'), path.join(REPO_ROOT, 'decisions')];

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
export const EXCLUDED = [
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
export const RELEASE_NOTE_MIRROR_HEADING = '\n## All Changes';

/** Any level-2 heading, used to find where the mirrored section stops. */
export const NEXT_SECTION_HEADING = '\n## ';

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
export function scannableText(rel: string, text: string): string {
  if (!rel.startsWith(`blog${path.sep}`)) return text;
  const start = text.indexOf(RELEASE_NOTE_MIRROR_HEADING);
  if (start === -1) return text;
  const resumes = text.indexOf(NEXT_SECTION_HEADING, start + RELEASE_NOTE_MIRROR_HEADING.length);
  return resumes === -1 ? text.slice(0, start) : text.slice(0, start) + text.slice(resumes);
}

/** An author's deliberate, greppable opt-out for an honestly-disclaimed subset. */
export const PARTIAL_MARKER = 'destructive-actions: partial';

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
export const MARKER_FILES = ['blog/dorkos-0-8-0.mdx'];

/** Hand-registered tools that stop and ask. */
export function destructiveToolNames(): string[] {
  return Object.entries(MCP_TOOL_TIERS)
    .filter(([, declared]) => declared.tier === 'destructive')
    .map(([name]) => name);
}

/** Registry capabilities that stop and ask, by id and by MCP tool name. */
export function destructiveCapabilities(): { id: string; toolName?: string }[] {
  return composeDorkOsCapabilityRegistry({
    logger: noopLogger,
    operatorDeps: {} as AgentToolDeps,
    marketplaceDeps: {} as MarketplaceMcpDeps,
  })
    .capabilities.filter((capability) => capability.tier === 'destructive')
    .map((capability) => ({
      // The id people know it by: a moved tool keeps its old name (C9a).
      id: gateViewOf(capability).id,
      ...(capability.surfaces.mcp ? { toolName: capability.surfaces.mcp.toolName } : {}),
    }));
}

/** The union, labelled the way the code labels it. */
export function destructiveActionLabels(): string[] {
  return [...destructiveToolNames(), ...destructiveCapabilities().map((c) => c.id)].sort();
}

/**
 * Every spelling a dev guide may use for a destructive action.
 *
 * Derived, so promoting a tool puts it under the completeness check on the same
 * commit. A capability counts by id (`marketplace.uninstall`) or by MCP tool name
 * (`marketplace_uninstall`); both are how somebody legitimately names it.
 */
export function codeLabelSpellings(): string[][] {
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
export const PLAIN_LANGUAGE: Record<string, string> = {
  'marketplace.uninstall': 'removing an installed package',
  tasks_delete: 'deleting a scheduled task',
  mesh_unregister: 'removing an agent',
  // NOPE.md, in the words the app itself uses for it (DOR-1698). "Changing"
  // rather than "editing", because the write replaces the whole file: whatever
  // the agent's boundaries said before is gone, which is what makes this one
  // irreversible in the same sense as the three above.
  'operator.update_agent_boundaries': "changing an agent's safety boundaries",
  // An agent's runtime, model and effort (DOR-2328). Reversible, unlike the
  // four above, and gated because every schedule that follows the agent runs
  // differently; the docs say both.
  'operator.update_agent_execution': 'changing what an agent runs on',
  // A hook, a setting or a skill under an agent's `.claude/` (DOR-4266): the
  // file is replaced whole, and a hook runs on every turn that agent takes.
  'operator.update_agent_config': "changing an agent's setup files",
  // A dev link (DOR-2696): reversible by unlink, and gated on every call
  // because the folder's code then runs unreviewed on every edit.
  'marketplace.link': 'running a package from a folder',
};

/**
 * Ways the docs have claimed that the tools outside the catalog answer to nobody.
 *
 * True until DOR-468, false since. It is the premise an agent reasons from when it
 * deletes something and reports that no approval was needed.
 */
export const UNTIERED_CLAIM = /carr(?:y|ies) no (?:permission )?tier|no tier at all/i;

/**
 * Counting words that turn one named action into a claim about the whole set.
 *
 * This is the assertion that catches the original DOR-509 defect, which the first
 * version of this file did not: "Removing an installed package is the one today"
 * names a single action, so a count-the-mentions rule skips it, and every word of
 * it is about approval being REQUIRED so an ungated-phrase rule skips it too. What
 * was wrong was the arithmetic.
 */
export const SOLE_ACTION_CLAIM =
  /\bis the one\b|\bthe one today\b|\bis the only\b|\bthe only one\b|\bis the sole\b|\bonly action\b/i;

/**
 * Ways prose has described, or could describe, a destructive action as free.
 *
 * Matched only against prose that NAMES a destructive action, so the identical and
 * true sentence about an `act` tool ("almost everything else runs straight away")
 * is untouched. It cannot read negation, so prose near a destructive action must
 * avoid these outright rather than negate them.
 */
export const UNGATED_CLAIM =
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
export const TOOL_ACCESS_CLAIM =
  /(?<!not )(?<!never )control which tools[^.]{0,50}agents?[^.]{0,20}can (?:use|access|call)|which tools[^.]{0,40}agents? can (?:use|access|call)|tool groups?[^.]{0,30}available to|(?<!not )(?<!never )restricts? which tools/gi;

/**
 * The one tool group whose access claim is TRUE (DOR-1611).
 *
 * Matched against the SENTENCE a claim sits in, never the whole page: naming the
 * grant somewhere else on the page must not license a blanket claim about the
 * four toggles that still only shape documentation.
 */
export const ROOMS_GRANT_SUBJECT = /manage rooms|roomsmanage/i;

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
export function sentenceAround(text: string, index: number): string {
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
export function uncarvedToolAccessClaims(text: string): string[] {
  return [...text.matchAll(TOOL_ACCESS_CLAIM)]
    .filter((match) => !ROOMS_GRANT_SUBJECT.test(sentenceAround(text, match.index)))
    .map((match) => match[0]);
}

/**
 * Trees whose text a stranger reads: the docs site, the blog, the marketing site's
 * own components, and the app's UI copy. Markdown AND source, because the sentence
 * DOR-509 had to pull off the marketing site lived in a `.tsx`.
 */
export const PUBLISHED_ROOTS = [
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
export const RETIRED_PHRASES = [
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
export const EXPOSURE_GUARD_HATCH = 'dorkos_allow_insecure_bind';

export interface ProseFile {
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
export function toUnits(block: string): string[] {
  const parts = block
    .split(/\n(?=\s*(?:[-*+]\s|\d+\.\s))/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [block];
}

/** Directories that never hold shipped copy. */
export const SKIPPED_DIRS = new Set(['node_modules', 'dist', '__tests__']);

/**
 * Every file under `dir` whose name matches `pattern`, minus the excluded paths.
 *
 * @param dir - Directory to walk.
 * @param pattern - Filename test, e.g. markdown only or markdown plus sources.
 */
export async function filesUnder(dir: string, pattern: RegExp): Promise<string[]> {
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
export async function proseFiles(dir: string): Promise<string[]> {
  return filesUnder(dir, /\.mdx?$/);
}

/**
 * Read every prose file under `roots`.
 *
 * @param roots - Directories to walk.
 * @returns One entry per file, lowercased and split into blocks.
 */
export async function load(roots: string[]): Promise<ProseFile[]> {
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
