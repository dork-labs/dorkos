/**
 * The types behind {@link ../index.js | the vendor-facts table} — one dated,
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
 * harness binary was observed doing it. Every row is `'docs'` today — no cell in
 * this table has been checked against a running harness (the H tier of
 * `plans/harness-sync-test-plan.md` is where that changes).
 */
export type FactVerification = 'docs' | 'binary';

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
  /**
   * Caveats a single cell cannot carry — a derivation, a contract row that still
   * calls the outcome unverified, or a conservative reading of silence.
   */
  notes?: readonly string[];
}

/**
 * Everything the table records about one harness.
 *
 * Only `skills` exists today. Instructions, hooks and commands are deliberately
 * absent — see the module docs of {@link ../index.js} for why.
 */
export interface HarnessFacts {
  /** How this harness reads skills. */
  skills: SkillsFacts;
}
