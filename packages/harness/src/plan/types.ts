import type { HarnessId } from '../manifest/schema.js';

/**
 * How an artifact reaches a harness.
 *
 * - `native`: the harness reads the canonical source directly; no file written.
 * - `symlink`: a managed symlink points at the source.
 * - `scaffold`: a one-time pointer file written only when absent (user owns it).
 * - `generate`: a file the engine writes deterministically. It owns the ones it
 *   can prove it wrote — for the per-harness hooks files that proof is a
 *   `.dorkos-generated` sidecar, since their vendors document those paths as
 *   hand-authorable (see `apply/generated-ownership.ts`).
 * - `merge`: engine-owned entries merged INTO a user-owned file (e.g. plugin
 *   hooks into `.claude/settings.local.json`), touching only the managed keys.
 * - `drop`: no home in the target harness; reported, never written.
 */
export type ProjectionKind = 'native' | 'symlink' | 'scaffold' | 'generate' | 'merge' | 'drop';

/**
 * The kind of agent file being projected. `plugin` covers plugin-level actions
 * that are not a single skill/hook/command — a whole installed plugin activated
 * natively, or a non-portable plugin layer that is dropped.
 *
 * `agent` (a subagent definition under `.claude/agents`), `rule` (a path-scoped
 * `.claude/rules/*.md`) and `mcp` (a server in `.mcp.json`) arrived with the
 * source-tree inventory (DOR-1845). The engine projects none of the three yet;
 * having a name for them is what lets `dorkos harness sync` report them as
 * honest drops instead of being blind to their existence, which is what it was
 * for this repository's own 13 rules, 7 subagents and `.mcp.json`.
 *
 * Adding a kind here means teaching `inventory/` to find it and
 * `plan/source-artifacts.ts` where each harness keeps it. Both read the list
 * through `satisfies Record<...>` tables, so the compiler names the gap.
 */
export type ArtifactType =
  'skill' | 'instruction' | 'hook' | 'command' | 'plugin' | 'agent' | 'rule' | 'mcp';

/**
 * Where an artifact came from. Drives the gitignore policy (installed/adopted
 * projections are ephemeral) and the collision policy.
 */
export type Provenance = 'authored' | 'installed' | 'adopted';

/** A single planned projection of one artifact to one harness. */
export interface ProjectionAction {
  /** How the artifact is projected to this harness. */
  kind: ProjectionKind;
  /** The kind of agent file. */
  artifact: ArtifactType;
  /** The target harness. */
  harness: HarnessId;
  /** Where the artifact came from. */
  provenance: Provenance;
  /** The artifact's name — a skill name, a hook event, an instruction file, or a command. */
  name: string;
  /** Source path, repo-relative. Absent for pure drops. */
  source?: string;
  /** Target path, repo-relative. Absent for drops. */
  target?: string;
  /** Human-readable reason — required for `drop`, optional note otherwise. */
  reason?: string;
  /**
   * True when this entry is not about {@link harness} in particular.
   *
   * Every action must name a harness — apply is per-harness and `HarnessId` has
   * no "DorkOS" or "none" member — but a few entries are answers about a
   * PACKAGE rather than about one agent: a plugin layer that has no home in any
   * harness, and a whole plugin that is not harness-portable at all. Those
   * carry an arbitrary harness for display and were reported under its heading,
   * so a project that does not run Codex was told about "codex: plugin layer …",
   * and `--harness cursor` hid them entirely (contract VC-02).
   *
   * Setting this makes a report render the entry under its own heading and keep
   * it under every harness filter. Absent means the ordinary case: this really
   * is about {@link harness}.
   */
  harnessAgnostic?: boolean;
}

/**
 * Fields shared by every action for one artifact + harness pairing. The `kind`,
 * `target`, and `reason` are filled in per projection mechanism on top of this base.
 */
export type ActionBase = Pick<
  ProjectionAction,
  'artifact' | 'harness' | 'provenance' | 'name' | 'source'
>;

/**
 * Where one `manifest.claudeOnlySkills` entry's declared `path` actually points.
 *
 * The manifest is the only evidence such a skill exists — it is deliberately NOT
 * in `.agents/skills`, so the scanner never sees it — and the entry says where it
 * is kept. Resolving that claim is a filesystem question, so `engine.ts` answers
 * it and `buildPlan` stays pure (see `scanClaudeOnlySkills`).
 */
export interface ClaudeOnlySkillLocation {
  /** The repo-relative path resolved: the entry's own `path`, or the default `.claude/skills/<name>`. */
  path: string;
  /**
   * What is on disk there: a real directory holding a `SKILL.md`, a symlink
   * (whatever it points at), or nothing usable.
   */
  kind: 'directory' | 'symlink' | 'missing';
  /**
   * Whether {@link path} is exactly `.claude/skills/<name>` — the one place
   * Claude Code would load this skill from, and the target its projection
   * symlink would occupy. A directory anywhere else is a real skill in a place
   * no harness reads.
   */
  atProjectionTarget: boolean;
}

/**
 * Something the operator has to be told about a projection that no `drop` line
 * covers. Two kinds live here:
 *
 * - projected-but-suspect: the artifact IS in `actions` but may not work in the
 *   target harness — e.g. a projected hook command carrying a Claude-only
 *   substitution token the target harness will not resolve.
 * - read-but-unusable: part of a source file the engine could not read, so it
 *   reached no harness at all — e.g. a matcher group the `hooks/hooks.json`
 *   salvage discarded (DOR-1724).
 *
 * Both are distinct from a `drop`, which reports a whole artifact that HAS no
 * home in a target harness.
 */
export interface ProjectionWarning {
  /** The kind of agent file the warning concerns. */
  artifact: ArtifactType;
  /** The harness the possibly-broken projection targets. */
  harness: HarnessId;
  /** The artifact's name (e.g. the hook event). */
  name: string;
  /**
   * Repo-relative source path, when the warning is about a source the inventory
   * can name. Present so the completeness check (P6) can match a warning to the
   * artifact it concerns: a `drop` and a `native` both carry a `source`, and a
   * warning that is the ONLY thing said about an artifact — a `claudeOnlySkills`
   * entry contradicted by the canonical layer, say — has to be matchable the
   * same way or the artifact reads as silent.
   */
  source?: string;
  /** Human-readable reason the projection may not work in this harness. */
  reason: string;
  /**
   * True when this warning is not about {@link harness} in particular — see
   * {@link ProjectionAction.harnessAgnostic}. A hook declaration the reader
   * could not use is the case here: the loss happened at read time, ahead of
   * every harness, so it reaches none of them.
   */
  harnessAgnostic?: boolean;
}

/**
 * The full result of planning a projection: the actionable projections, the
 * honest drop list, and any warnings. Nothing a harness cannot accept is ever
 * silently omitted — it appears in `drops` with a reason; a projection that
 * landed but may be broken, or a source declaration the engine could not read,
 * appears in `warnings` with a reason.
 */
export interface ProjectionPlan {
  /** Actionable projections (`native` | `symlink` | `scaffold` | `generate` | `merge`). */
  actions: ProjectionAction[];
  /** Artifacts with no home in a target harness, each with a reason. */
  drops: ProjectionAction[];
  /** Projections that may not work, and declarations that could not be read, each with a reason. */
  warnings: ProjectionWarning[];
}

/** The result of diffing a {@link ProjectionPlan} against the current on-disk state (`--check`). */
export interface DriftResult {
  /** Actions whose target does not yet match the plan (missing, stale, or wrong). */
  drifted: ProjectionAction[];
  /**
   * Generate actions the engine cannot apply because a file it does not own
   * occupies the target — what `--fix` will report as a conflict. Not drift: no
   * amount of re-running fixes it, and the person has to move or delete the file
   * first. Reported separately so `--check` can name it and still exit non-zero,
   * without claiming a projection is merely stale.
   */
  blocked: ProjectionAction[];
  /**
   * Repo-relative paths of managed skill links whose source is gone — somebody
   * removed or renamed `.agents/skills/<x>`, and `.claude/skills/<x>` is left
   * pointing at nothing. No plan action names one (there is no source left to
   * project), so they are reported here rather than in `drifted`; a `--fix`
   * sweeps them, which is why they count against `clean`.
   */
  orphans: string[];
  /**
   * Repo-relative paths where somebody's own file sits at a target the engine
   * generates for *some* configuration but not this one — nothing is blocked,
   * nothing needs fixing, and the person is simply told the file is theirs. Never
   * a reason to exit non-zero.
   */
  leftAlone: string[];
  /**
   * True when the plan is fully realized on disk: nothing drifted, nothing
   * blocked, and no orphaned link. `leftAlone` entries do not make a tree
   * unclean.
   */
  clean: boolean;
}
