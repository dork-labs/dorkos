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
 * 1. **Almost every cell is documentation-derived.** `verified` is `'docs'` on
 *    every row but one: nothing else here has been checked against a running
 *    harness binary. The exception is `codex.skills`, which the H tier's free
 *    probe settled on 2026-09-09 (DOR-1856) — `observed` on that row names the
 *    six cells a real `codex-cli 0.145.0` was watched deciding, the report they
 *    were read from, and leaves the four nobody looked at alone. Read
 *    `verified: 'binary'` as "a run touched this row", never as "every cell here
 *    is measured"; that is what `observed.cells` is for.
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
 * **Almost only `skills` rows exist.** The contract's §1.2 tabulates instructions,
 * hooks, commands, subagents, rules and MCP read paths too, but it carries no
 * per-harness vendor URL or fetch date for those cells — its provenance there is
 * mixed (vendor pages, `specs/harness-sync/spike-findings.md` from 2026-06, and
 * `research/20260706_agent_cli_command_skill_naming.md`), and several cells are
 * marked `(verify)`. A row here has to carry a citation it can honour, so those
 * kinds are left out rather than given a URL that does not document them. Adding
 * them means fetching each vendor page, and {@link ./types.js#HarnessFacts} has
 * the room.
 *
 * Codex's `hooks` cell is the one exception, and it earns the exception the way
 * the rule asks: it was fetched from the vendor's own page on the date it
 * carries, and something SHIPPED reads it — `dorkos harness sync --fix` quotes
 * the trust gate back to a person after it writes a `.codex/hooks.json`
 * (contract HK-10). A claim about another company's software, printed in
 * somebody's terminal, has to be traceable to the page it came from.
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
      nameRequired: false,
      onInvalidName: 'unknown',
      dedupe: 'by-realpath',
      symlinks: 'followed',
      liveReload:
        'yes for `.claude/skills/` and `~/.claude/skills/` — but a skills directory created after the session started needs a restart',
      source: {
        url: 'https://code.claude.com/docs/en/skills#live-change-detection',
        // Re-fetched on its own for DOR-1850, which prints this claim in a log
        // line and in `dorkos harness sync --fix`. The rest of the table is
        // still on VENDOR_FACTS_FETCHED_AT; a row on its own date is a row that
        // was re-checked on its own, which is the signal a reader wants.
        fetchedAt: '2026-09-08',
        quote:
          'When you add, edit, or remove a skill under `~/.claude/skills/`, the project `.claude/skills/`, or a `.claude/skills/` inside an `--add-dir` directory, Claude Code picks up the change within the current session, without a restart. If you create a top-level skills directory that didn’t exist when the session started, restart Claude Code so it can watch the new directory.',
      },
      verified: 'docs',
      notes: [
        'The one fact the whole engine is built on: Claude Code is the only harness that does not read `.agents/skills`. The symlink into `.claude/skills/` is the entire reason the skills half of the engine exists.',
        'Two limits the `liveReload` cell cannot carry, both stated on the same page (2026-09-08): live detection covers `SKILL.md` text only — a skill folder that is also a plugin needs `/reload-plugins` for its `hooks/`, `.mcp.json`, `agents/` and `output-styles/` — and in bare mode Claude Code does not watch skill directories at all.',
        'The page is silent on whether a NESTED `.claude/skills/` created mid-session behaves like a top-level one, and on whether `/reload-plugins` rescues a newly created plain-skill directory. Neither is claimed anywhere in DorkOS output.',
        '`nameMustMatchDir` is `false` because the page states the frontmatter name is display-only outside plugins — the directory is the identity, so no match is required. `onInvalidName` is `unknown` because no name rule is stated for it to break.',
        "Read paths the contract lists but this row omits, because they are not a directory a projection can walk: enabled plugins' `skills/`, `--add-dir` directories, the nested `<subdir>/.claude/skills/` tier Claude Code loads lazily when a file there is touched (SK-15; explicitly out of scope for `harnessCoverage()` per the test plan §2), and the enterprise/managed tier above `~/.claude/skills/` that wins every conflict.",
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
      nameRequired: 'unknown',
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
      verified: 'binary',
      observed: {
        binary: 'codex-cli 0.145.0',
        observedAt: '2026-09-09',
        report: 'meta/harness-smoke/20260909-073603.110-codex.md',
        // FIVE cells, and `walk` is deliberately not among them. The probe ran
        // with its cwd AT the repository root, where an `ascend-to-repo-root`
        // walk and a `fixed` one look exactly alike — the reading that says
        // "Codex ascends" is still the vendor page's, not this run's. Settling
        // it needs a probe from a SUBDIRECTORY, which is a fixture the runner
        // does not stage yet.
        cells: ['readPaths', 'identity', 'nameMustMatchDir', 'dedupe', 'symlinks'],
        summary:
          'A `codex debug prompt-input` run over a staged, projected fixture listed each skill ' +
          'under its FRONTMATTER name with the absolute SKILL.md path beside it: `pkg__x` ' +
          'appeared as `x`, so identity is the frontmatter key and the directory need not match; ' +
          'two skills whose frontmatter agreed both appeared, so duplicates are not merged; the ' +
          '`.agents/skills/pkg__x` entry is a symlink into `.dork/plugins`, so symlinks are ' +
          'followed; and a skill of the operator’s in `~/.agents/skills` appeared on a fixture ' +
          'whose CODEX_HOME was an empty temp directory, so the user-scope read path is real.',
      },
      notes: [
        'Five cells on this row are still `docs` and nothing has looked at them: `walk`, `nameRegex`, ' +
          '`nameRequired`, `onInvalidName` and `liveReload`. `verified: binary` is a claim about ' +
          'the row having been observed at all — `observed.cells` is the claim about WHICH cells.',
        'Codex documents no charset rule and no directory-match rule for a skill name, which is why the engine\'s `<pkg>__<name>` projection into `.agents/skills` is expected to load here and nowhere else with confidence: the contract\'s SK-09 calls Codex "the one harness DorkOS source-verified" and names OpenCode, Cursor and Copilot as the ones whose stated name rules `pkg__name` violates.',
        '`dedupe: none` is the vendor\'s own statement that duplicates are not merged — a different claim from "we do not know", and the reason two skills sharing a frontmatter name are a collision warning (SK-06) rather than a silent merge.',
        'The user scope also includes skills bundled with the binary; those are not a filesystem path a projection can reach, so they are not listed.',
      ],
    },
    hooks: {
      readPaths: {
        project: ['.codex/hooks.json', '.codex/config.toml'],
        user: ['~/.codex/hooks.json', '~/.codex/config.toml'],
      },
      trust: 'per-hook-hash',
      source: {
        url: 'https://learn.chatgpt.com/docs/hooks',
        fetchedAt: '2026-09-07',
        quote:
          "Before a non-managed hook can run, Codex requires you to review and trust the exact hook definition. … Codex records trust against the hook's current hash, so new or changed hooks are marked for review and skipped until trusted. … Project-local hooks load only when the project `.codex/` layer is trusted.",
      },
      verified: 'docs',
      notes: [
        'This is the one cell a shipped output quotes back to a person: `dorkos harness sync --fix` says it after it writes a `.codex/hooks.json` whose bytes changed (contract HK-10). Both halves of the quote matter and neither implies the other — the project layer being trusted is not enough on its own, and a trusted project still holds a CHANGED hook for review.',
        'It is what makes byte-identical idempotency (AP-01) load-bearing for Codex rather than merely tidy: a regeneration that rewrites the same hooks with different bytes disarms every one of them until the person opens `/hooks` again.',
        "Read directly from the vendor page on the date above, unlike the `skills` rows, which are the capabilities contract's transcription. `developers.openai.com/codex/hooks` 308-redirects here.",
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
      nameRequired: 'unknown',
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
      nameRequired: 'unknown',
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
      nameRequired: 'unknown',
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
      // "`name` required" is the vendor's own word for it, quoted in `source` below.
      nameRequired: true,
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

/**
 * The hooks facts for one harness, when the table has compiled them.
 *
 * `undefined` is the ordinary answer and means "nothing here has been read from
 * that vendor's hooks page", never "that harness has no hook trust gate". A
 * caller that prints a claim about a harness has to handle the absence rather
 * than assume the permissive reading.
 *
 * @param harness - the harness to look up.
 * @returns that harness's documented hook-reading behaviour, or `undefined`.
 */
export function hooksFactsFor(harness: HarnessId): HarnessFacts['hooks'] {
  return HARNESS_VENDOR_FACTS[harness].hooks;
}
