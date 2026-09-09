/**
 * The types behind {@link ./index.js | the vendor-facts table} — one dated,
 * quoted record per harness describing how that harness *reads* an artifact
 * kind, as its own documentation states it.
 *
 * These types deliberately model *uncertainty*. `unknown` is a first-class
 * value everywhere a vendor page said nothing, because the whole point of the
 * table is to separate "the vendor documents this" from "we assumed this". A
 * cell filled with a guess is worse than an empty one: the coverage walk built
 * on top of it (`coverage.ts`) turns an `unknown` into a loud `uncertain`
 * finding, and turns a guess into a confident wrong answer.
 *
 * @module vendor-facts/types
 */

/**
 * How a harness searches for its read paths relative to a tree.
 *
 * - `ascend-to-repo-root` — look in the start directory and every ancestor up
 *   to the repository root (Claude Code, Codex).
 * - `ascend-to-worktree` — the same, but stop at the nearest git worktree
 *   (OpenCode).
 * - `descend-recursive` — look under the root and under every subdirectory
 *   (Cursor).
 * - `fixed` — look only at the listed paths under the root; no walk is
 *   documented (Gemini CLI, Copilot).
 */
export type SkillWalk =
  'ascend-to-repo-root' | 'ascend-to-worktree' | 'descend-recursive' | 'fixed';

/**
 * What a harness treats as a skill's identity — the key it would collide on.
 *
 * `'unknown'` means the vendor page does not say. It is not a synonym for
 * `'dir'`; a discovery whose key would differ between the two readings is
 * reported as `uncertain` rather than guessed.
 */
export type SkillIdentity = 'dir' | 'frontmatter' | 'unknown';

/** What a harness is documented to do with a skill whose name breaks its own name rule. */
export type OnInvalidName = 'skip' | 'warn-and-load' | 'unknown';

/**
 * What a harness is documented to do when one skill is reachable through two of
 * its read paths.
 *
 * - `by-realpath` — the same target reached twice is loaded once.
 * - `by-name` — entries are keyed by name, so the second one collapses into the first.
 * - `none` — duplicates are explicitly NOT merged; both appear (Codex documents this).
 * - `unknown` — the vendor page does not say.
 */
export type SkillDedupe = 'by-realpath' | 'by-name' | 'none' | 'unknown';

/**
 * Where a cell's claim came from, and when.
 *
 * `fetchedAt` is the day the page was read, not the day the record was edited:
 * a cell whose vendor page has moved on is only detectable by a stale date, so
 * changing a cell means re-fetching and bumping this.
 */
export interface FactSource {
  /** The vendor documentation URL the claim was read from. */
  url: string;
  /** ISO date (`YYYY-MM-DD`) the URL was fetched. */
  fetchedAt: string;
  /** The vendor's own words, or the contract's verbatim transcription of them. */
  quote?: string;
}

/**
 * How confident this row is.
 *
 * `'docs'` means "the vendor's documentation says so"; `'binary'` means a real
 * harness binary was observed doing it.
 *
 * **It is a row-level field and the observations are per CELL, which is why
 * {@link FactObservation} exists.** The H tier answers cells, not rows: DOR-1856
 * watched a real `codex` resolve skills and settled five of its skills cells,
 * and left `nameRegex`, `nameRequired`, `onInvalidName` and `liveReload`
 * exactly as unverified as they were. Flipping the whole row to `'binary'` on
 * that evidence would promote four cells nobody looked at — so a row goes
 * `'binary'` only when a run touched it at all, and `observed` says which cells,
 * against which binary, in which report.
 */
export type FactVerification = 'docs' | 'binary';

/**
 * What a real binary was watched doing, and where the evidence is.
 *
 * Present only on a row some H-tier run actually observed. The cell names are
 * the field names of {@link SkillsFacts} / {@link HooksFacts}, so a reader can
 * tell at a glance which half of a `'binary'` row is measured and which half is
 * still the vendor's page.
 */
export interface FactObservation {
  /** The binary and version that was watched, e.g. `codex-cli 0.145.0`. */
  binary: string;
  /** ISO date (`YYYY-MM-DD`) of the run. */
  observedAt: string;
  /** Repo-relative path of the report the run wrote. */
  report: string;
  /** The field names this run settled. Everything else on the row is still `docs`. */
  cells: readonly string[];
  /** What was seen, in one sentence, so the claim is legible without opening the report. */
  summary: string;
}

/** The directories a harness reads a kind of artifact from, at each scope. */
export interface ReadPaths {
  /** Repo-relative project-scope directories, in the vendor's stated precedence order. */
  project: readonly string[];
  /** User-scope directories, `~`-prefixed or absolute, as the vendor writes them. */
  user: readonly string[];
}

/**
 * One harness's documented behaviour for reading skills.
 *
 * Every field is a transcription of {@link ../../../../meta/harness-sync-capabilities.md | the
 * capabilities contract} §1.1 and the prose beneath it, which in turn is what
 * each vendor page said on the date in {@link FactSource.fetchedAt}.
 */
export interface SkillsFacts {
  /** Where the harness looks for skills. */
  readPaths: ReadPaths;
  /** How it searches for those paths relative to a tree. */
  walk: SkillWalk;
  /** What it keys a skill by. */
  identity: SkillIdentity;
  /** The vendor's stated charset rule for a skill name, when it states one. */
  nameRegex?: RegExp;
  /** Whether the vendor requires the frontmatter `name` to equal the directory name. */
  nameMustMatchDir: boolean | 'unknown';
  /**
   * Whether the vendor states that a `SKILL.md` must declare a `name` at all.
   *
   * Separate from {@link SkillsFacts.nameMustMatchDir}, which is about the two
   * names AGREEING, and from {@link SkillsFacts.identity}, which is about what
   * the harness keys on. A harness can key by directory and still require the
   * frontmatter key — Copilot's page does exactly that — and a skill with no
   * name then breaks a stated rule that no other cell notices. `'unknown'` where
   * the page does not say; `false` where it says the key is optional.
   */
  nameRequired: boolean | 'unknown';
  /** What the vendor says happens to a skill whose name breaks the rule. */
  onInvalidName: OnInvalidName;
  /** How the vendor says it handles one skill reachable through two read paths. */
  dedupe: SkillDedupe;
  /** Whether the vendor documents following filesystem symlinks. */
  symlinks: 'followed' | 'unknown';
  /** One clause on whether a newly-added skill is picked up without a restart. */
  liveReload: string;
  /** Where the row came from and when. */
  source: FactSource;
  /** Whether the row is documentation-derived or observed against a binary. */
  verified: FactVerification;
  /** What a real binary was watched doing, on the cells a run actually settled. */
  observed?: FactObservation;
  /**
   * Caveats a single cell cannot carry — a derivation, a contract row that still
   * calls the outcome unverified, or a conservative reading of silence.
   */
  notes?: readonly string[];
}

/**
 * One harness's documented behaviour for reading hooks.
 *
 * Deliberately narrow: it records only what a shipped DorkOS output states out
 * loud about hooks, because a cell nothing reads is a cell nobody re-fetches. It
 * exists for the Codex trust gate (contract HK-10), which `dorkos harness sync
 * --fix` prints after it writes a generated hooks file — and a claim about
 * another company's software that appears in a terminal has to be traceable to
 * the page it was read from, on the day it was read.
 */
export interface HooksFacts {
  /** Repo-relative and user-scope paths the harness reads hooks from, as the vendor writes them. */
  readPaths: ReadPaths;
  /**
   * Whether the harness requires the person to trust something before a hook
   * runs, and what the trust is recorded against.
   *
   * - `none` — no gate is documented.
   * - `project` — the project (or its config layer) must be trusted.
   * - `per-hook-hash` — trust is recorded against each hook's current content,
   *   so changing a hook's bytes puts it back behind the gate.
   * - `unknown` — the vendor page does not say.
   */
  trust: 'none' | 'project' | 'per-hook-hash' | 'unknown';
  /** Where the row came from and when. */
  source: FactSource;
  /** Whether the row is documentation-derived or observed against a binary. */
  verified: FactVerification;
  /** Caveats a single cell cannot carry. */
  notes?: readonly string[];
}

/**
 * Everything the table records about one harness.
 *
 * `skills` is compiled for all six. `hooks` is present only where a shipped
 * output makes a claim about it — Codex's trust gate today — for the reason
 * {@link HooksFacts} gives; instructions and commands are deliberately absent,
 * see the module docs of {@link ./index.js}.
 */
export interface HarnessFacts {
  /** How this harness reads skills. */
  skills: SkillsFacts;
  /** How this harness reads hooks, where a DorkOS output states something about it. */
  hooks?: HooksFacts;
}
