/**
 * The vendor-facts table — §1 of the Harness Sync capabilities contract as data.
 *
 * `meta/harness-sync-capabilities.md` §1.1 is the oracle every projection is
 * measured against: what each harness's own documentation says it *reads*, as
 * opposed to what the engine assumes it reads. This module is that table, typed,
 * dated and quoted, so a test can assert against it and so a vendor change has
 * exactly one place to land.
 *
 * Three properties are load-bearing:
 *
 * 1. **Every cell is documentation-derived.** `verified` is `'docs'` on every
 *    row: nothing here has been checked against a running harness binary. The H
 *    tier of `plans/harness-sync-test-plan.md` is the first thing that will ever
 *    set a cell to `'binary'`, and it is expected to contradict some of these.
 * 2. **`unknown` is an answer.** Where a vendor page said nothing — OpenCode's
 *    and Cursor's and Copilot's symlink handling, Gemini's identity rule,
 *    several live-reload clauses — the cell says `unknown` and the coverage walk
 *    reports an `uncertain` finding rather than guessing. Filling one of those in
 *    without a citation is the single most damaging edit that can be made here.
 * 3. **Dates, not vibes.** `source.fetchedAt` is the day the page was read.
 *    Updating a cell means re-fetching the page, quoting the sentence, and
 *    bumping the date — see `contributing/harness-sync.md` §5.
 *
 * The `quote` on each row is the capabilities contract's verbatim transcription
 * of the vendor page it names, not a fresh quotation of the page itself; the
 * contract was compiled from those pages on the date each row carries.
 *
 * **Only `skills` rows exist.** The contract's §1.2 tabulates instructions,
 * hooks, commands, subagents, rules and MCP read paths too, but it carries no
 * per-harness vendor URL or fetch date for those cells — its provenance there is
 * mixed (vendor pages, `specs/harness-sync/spike-findings.md` from 2026-06, and
 * `research/20260706_agent_cli_command_skill_naming.md`), and several cells are
 * marked `(verify)`. A row here has to carry a citation it can honour, so those
 * kinds are left out rather than given a URL that does not document them. Adding
 * them means fetching each vendor page, and {@link ./types.js#HarnessFacts} has
 * the room.
 *
 * @module vendor-facts
 */
import type { HarnessId } from '../manifest/schema.js';
import type { HarnessFacts } from './types.js';

export * from './types.js';

/**
 * The date every row in this table was compiled from its vendor page.
 *
 * One constant rather than six literals so a partial re-fetch is visible: a row
 * whose date no longer equals this one has been re-checked on its own, which is
 * exactly the signal a reader wants.
 */
export const VENDOR_FACTS_FETCHED_AT = '2026-09-07';

/**
 * What each harness's documentation says about reading skills, keyed by
 * {@link HarnessId}.
 *
 * Source: `meta/harness-sync-capabilities.md` §1.1 and the two paragraphs of
 * prose beneath it, compiled 2026-09-07 from the vendor URLs each row names.
 */
export const HARNESS_VENDOR_FACTS: Readonly<Record<HarnessId, HarnessFacts>> = {
  'claude-code': {
    skills: {
      readPaths: {
        project: ['.claude/skills'],
        user: ['~/.claude/skills'],
      },
      walk: 'ascend-to-repo-root',
      identity: 'dir',
      nameMustMatchDir: false,
      onInvalidName: 'unknown',
      dedupe: 'by-realpath',
      symlinks: 'followed',
      liveReload:
        'yes for `.claude/skills/` and `~/.claude/skills/` — but a skills directory created after the session started needs a restart',
      source: {
        url: 'https://code.claude.com/docs/en/skills',
        fetchedAt: VENDOR_FACTS_FETCHED_AT,
        quote:
          '`.claude/skills/` in the start dir and every parent up to the repo root; … **directory name** is the `/command`; frontmatter `name` is display-only outside plugins; symlinks: yes; a target reachable twice is loaded once',
      },
      verified: 'docs',
      notes: [
        'The one fact the whole engine is built on: Claude Code is the only harness that does not read `.agents/skills`. The symlink into `.claude/skills/` is the entire reason the skills half of the engine exists.',
        '`nameMustMatchDir` is `false` because the page states the frontmatter name is display-only outside plugins — the directory is the identity, so no match is required. `onInvalidName` is `unknown` because no name rule is stated for it to break.',
        "Read paths the contract lists but this row omits, because they are not a directory a projection can walk: enabled plugins' `skills/`, `--add-dir` directories, the nested `<subdir>/.claude/skills/` tier Claude Code loads lazily when a file there is touched (SK-15; explicitly out of scope for `coverage()` per the test plan §2), and the enterprise/managed tier above `~/.claude/skills/` that wins every conflict.",
      ],
    },
  },
  codex: {
    skills: {
      readPaths: {
        project: ['.agents/skills'],
        user: ['~/.agents/skills', '/etc/codex/skills'],
      },
      walk: 'ascend-to-repo-root',
      identity: 'frontmatter',
      nameMustMatchDir: false,
      onInvalidName: 'unknown',
      dedupe: 'none',
      symlinks: 'followed',
      liveReload: 'detects new installs; "restart if it doesn\'t appear"',
      source: {
        url: 'https://learn.chatgpt.com/docs/build-skills',
        fetchedAt: VENDOR_FACTS_FETCHED_AT,
        quote:
          '`.agents/skills/` in cwd, then every ancestor up to the repo root; … frontmatter `name`; duplicates are NOT merged — both appear; symlinks: yes (documented)',
      },
      verified: 'docs',
      notes: [
        'Codex documents no charset rule and no directory-match rule for a skill name, which is why the engine\'s `<pkg>__<name>` projection into `.agents/skills` is expected to load here and nowhere else with confidence: the contract\'s SK-09 calls Codex "the one harness DorkOS source-verified" and names OpenCode, Cursor and Copilot as the ones whose stated name rules `pkg__name` violates.',
        '`dedupe: none` is the vendor\'s own statement that duplicates are not merged — a different claim from "we do not know", and the reason two skills sharing a frontmatter name are a collision warning (SK-06) rather than a silent merge.',
        'The user scope also includes skills bundled with the binary; those are not a filesystem path a projection can reach, so they are not listed.',
      ],
    },
  },
  opencode: {
    skills: {
      readPaths: {
        project: ['.opencode/skills', '.claude/skills', '.agents/skills'],
        user: ['~/.config/opencode/skills', '~/.claude/skills', '~/.agents/skills'],
      },
      walk: 'ascend-to-worktree',
      identity: 'frontmatter',
      // 1–64 chars, lowercase alphanumeric segments joined by single hyphens
      // (so no leading, trailing or doubled `-`), transcribed from the docs rule.
      nameRegex: /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/,
      nameMustMatchDir: true,
      onInvalidName: 'unknown',
      dedupe: 'unknown',
      symlinks: 'unknown',
      liveReload: 'unknown — the vendor page states nothing',
      source: {
        url: 'https://opencode.ai/docs/skills/',
        fetchedAt: VENDOR_FACTS_FETCHED_AT,
        quote:
          '`.opencode/skills/`, `.claude/skills/`, `.agents/skills/` — walking up from cwd to the git worktree; … `name`: 1–64 chars, lowercase alphanumeric with single hyphens, no `--`, **must match the directory** (docs); source keyed on frontmatter `name` at the 2026-07 check',
      },
      verified: 'docs',
      notes: [
        'The 2026-07 source check the contract records ("source keyed on frontmatter `name` … which **would** collapse the pair") is the standing hypothesis for what happens to a skill reachable through two of these three directories — but it is a hypothesis, not a documented outcome: the vendor page says nothing, and SK-12 lists the answer as unverified pending the H tier, exactly as it does for Cursor and Copilot. So `dedupe` stays `unknown` and this note carries the reasoning. When the H tier confirms it, the cell becomes `by-name` and `verified` becomes `binary` in the same edit.',
        'The docs state the name rule but not what happens to a skill that breaks it, hence `onInvalidName: unknown` — which is what makes a `<pkg>__<name>` directory an `uncertain` finding here rather than a discovery or a drop (SK-09).',
      ],
    },
  },
  cursor: {
    skills: {
      readPaths: {
        project: ['.agents/skills', '.cursor/skills', '.claude/skills', '.codex/skills'],
        user: ['~/.agents/skills', '~/.cursor/skills', '~/.claude/skills', '~/.codex/skills'],
      },
      walk: 'descend-recursive',
      identity: 'dir',
      // "lowercase/digits/hyphens", transcribed from the docs rule.
      nameRegex: /^[a-z0-9-]+$/,
      nameMustMatchDir: true,
      onInvalidName: 'unknown',
      dedupe: 'unknown',
      symlinks: 'unknown',
      liveReload: 'unknown — the vendor page states nothing',
      source: {
        url: 'https://cursor.com/docs/skills',
        fetchedAt: VENDOR_FACTS_FETCHED_AT,
        quote:
          '`.agents/skills/`, `.cursor/skills/`, `.claude/skills/`, `.codex/skills/` — recursive; nested project dirs auto-scoped; … folder containing `SKILL.md`; `name` lowercase/digits/hyphens and **must match the folder**',
      },
      verified: 'docs',
      notes: [
        'Cursor reads `.codex/skills` as a compatibility path — one of four, and the reason the contract calls the authored-skill drop for Cursor stale (SK-05).',
        'The identity is the folder containing `SKILL.md`, and the frontmatter name must match it; the docs do not say what happens when it does not, so `onInvalidName` is `unknown`.',
      ],
    },
  },
  gemini: {
    skills: {
      readPaths: {
        project: ['.gemini/skills', '.agents/skills'],
        user: ['~/.gemini/skills', '~/.agents/skills'],
      },
      walk: 'fixed',
      identity: 'unknown',
      nameMustMatchDir: 'unknown',
      onInvalidName: 'unknown',
      dedupe: 'unknown',
      symlinks: 'unknown',
      liveReload: 'manual: `/skills reload`',
      source: {
        url: 'https://geminicli.com/docs/cli/skills/',
        fetchedAt: VENDOR_FACTS_FETCHED_AT,
        quote:
          '`.gemini/skills/`, `.agents/skills/` (the alias wins within a tier); workspace beats user; … identity / name rule: — (verify)',
      },
      verified: 'docs',
      notes: [
        'The contract marks Gemini\'s identity and name rule "(verify)", so this row cannot say whether a skill is keyed by directory or by frontmatter name. A skill whose two names agree is discovered either way; one whose names differ is reported `uncertain`.',
        '`walk: fixed` is a conservative reading of silence: the page documents a workspace scope that beats the user scope, and documents no ancestor walk and no recursion. If Gemini turns out to ascend or descend, this cell is wrong in the direction of under-reporting coverage, which is the safe direction.',
        '`/skills link` links a skills directory into a scope; the page says nothing about filesystem symlinks, so `symlinks` stays `unknown`.',
      ],
    },
  },
  copilot: {
    skills: {
      readPaths: {
        project: ['.github/skills', '.claude/skills', '.agents/skills'],
        user: ['~/.copilot/skills', '~/.agents/skills'],
      },
      walk: 'fixed',
      identity: 'unknown',
      // "lowercase with hyphens", transcribed from the docs rule; the page's
      // phrasing is prose rather than a pattern, and digits are assumed allowed.
      nameRegex: /^[a-z0-9-]+$/,
      nameMustMatchDir: 'unknown',
      onInvalidName: 'unknown',
      dedupe: 'unknown',
      symlinks: 'unknown',
      liveReload: 'unknown — the vendor page states nothing',
      source: {
        url: 'https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills',
        fetchedAt: VENDOR_FACTS_FETCHED_AT,
        quote:
          '`.github/skills/`, `.claude/skills/`, `.agents/skills/`; … `name` required, lowercase with hyphens, "typically matches the name of the skill\'s directory"',
      },
      verified: 'docs',
      notes: [
        '`nameMustMatchDir: unknown` because "typically matches" is an observation, not a rule — the contract\'s SK-09 names Copilot as unverified for exactly this reason.',
        '`identity: unknown` because the page requires a `name` but describes the directory only as what it "typically matches" — which says a skill has a name, not that the name is the key Copilot collides on. SK-09 groups Copilot with the unverified harnesses for exactly this reason. A skill whose two names agree is discovered either way; one whose names differ is reported uncertain.',
        '`walk: fixed` is the same conservative reading of silence as Gemini: no ancestor walk and no recursion is documented.',
      ],
    },
  },
};

/**
 * The skills facts for one harness.
 *
 * A thin accessor so callers do not index the record by hand and so the
 * lookup has one place to grow a fallback if a harness is ever added to
 * `HARNESS_IDS` before its row is compiled.
 *
 * @param harness - the harness to look up.
 * @returns that harness's documented skill-reading behaviour.
 */
export function skillsFactsFor(harness: HarnessId): HarnessFacts['skills'] {
  return HARNESS_VENDOR_FACTS[harness].skills;
}
