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
 * Where an artifact came from. Drives the gitignore policy (an installed
 * projection is ephemeral) and the collision policy.
 *
 * There is no third value for an ADOPTED skill, and that is a decision rather
 * than an omission (DOR-1944). A skill `dorkos harness adopt` moved is not a
 * third kind of source: it lives in `.agents/skills`, which is the authored
 * root, scanned by the authored scanner, projected by the authored branch of
 * `planSkill`, and committed like every other authored skill. The value this
 * union used to carry was worse than unused — `isEphemeralProvenance` answered
 * `true` for it, so anything that ever set it would have sent the gitignore half
 * of the engine to tell a person to ignore a skill they had just committed.
 */
export type Provenance = 'authored' | 'installed';

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
  /** Source path, repo-relative for a project action and absolute for a global one. Absent for pure drops. */
  source?: string;
  /** Target path, repo-relative for a project action and absolute for a global one. Absent for drops. */
  target?: string;
  /** Human-readable reason — required for `drop`, optional note otherwise. */
  reason?: string;
  /**
   * Which plan this action belongs to.
   *
   * A project action's {@link source} and {@link target} are repo-relative
   * POSIX strings that resolve inside `repoRoot`; a global action's are
   * absolute paths that resolve inside one of the plan's declared roots (see
   * `plan/global-projector.ts`). Absent means `'project'`, so every existing
   * emitter is unchanged and the field cannot be forgotten into a false global.
   *
   * A discriminator rather than a `root` field, deliberately. A `root` would let
   * a target stay relative and be joined against something other than
   * `repoRoot`, which is a second silent way for a target to escape, and every
   * reader of `target` would then have to remember to join it first. An
   * absolute target is self-describing, so P8 and P8b are checkable on the
   * target alone.
   */
  scope?: 'project' | 'global';
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
 * A harness something says this repo should enable, and what said so.
 *
 * The manifest's `harnesses` set is decided once, when the manifest is
 * scaffolded, and nothing looked again — so a repo that grew a `.cursor/` a
 * month later never enabled Cursor and nobody was told (contract TR-11). Every
 * plan now carries the ones it found that the manifest does not enable.
 *
 * There are TWO ways to be on that list and they are different claims, which is
 * why {@link why} is not optional. A `footprint` is evidence on disk: that
 * harness's own files are here. A `dorkos-runtime` entry is evidence about THIS
 * DorkOS: its default runtime reads that harness, so every session DorkOS starts
 * in this repo reads whatever that harness reads — and a repo that never ran
 * Claude Code has left no `.claude/` for a footprint to find, which is exactly
 * how an OpenCode project ended up with managed Claude Code sessions that had
 * never seen its `AGENTS.md` (DOR-1901).
 */
export interface DetectedHarness {
  /** The harness that is not enabled. */
  harness: HarnessId;
  /**
   * What put it on the list: its own files are here (`footprint`), or DorkOS's
   * own default runtime reads it (`dorkos-runtime`).
   */
  why: 'footprint' | 'dorkos-runtime';
  /**
   * The repo-relative path that was found. A directory carries a trailing `/`,
   * so the line a person reads says `.cursor/` rather than `.cursor`.
   *
   * Absent for a `dorkos-runtime` entry, which is a fact about this DorkOS
   * rather than about a file: there is no path to name, and inventing one would
   * put a path in a sentence that is not about a path.
   */
  signal?: string;
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
  /**
   * Harnesses whose files are in the repo that the manifest does not enable.
   *
   * **Always empty in a global plan**: this is a per-repository detection
   * result and a global plan has no repository to detect anything in.
   *
   * A NOTICE, never drift: nothing is missing from disk, nothing is stale, and
   * a person who runs one of these agents somewhere else on purpose is not
   * wrong. So it never changes an exit code — it exists because detection used
   * to run exactly once, at scaffold time, and a harness added afterwards was
   * silently never projected to (TR-11).
   *
   * Only the not-enabled ones are here. The enabled set is the manifest's, the
   * caller already has it, and a plan field nobody reads is a claim nobody
   * checks.
   */
  notEnabled: DetectedHarness[];
  /**
   * The harness this plan was narrowed to, when it was narrowed at all
   * (`dorkos harness sync --harness <id>`).
   *
   * **Never set in a global plan**: `buildGlobalPlan` takes no narrowing
   * parameter at all, which is the stronger form of the guard `applyPlan` needs
   * a thrown error for.
   *
   * Present so a narrowed plan can say so about ITSELF, rather than every
   * caller having to remember. Such a plan omits every other harness's live
   * projections, so anything that reads the plan as a keep-set — the six orphan
   * finders behind `checkPlan().orphans`, and the sweeps behind
   * `applyPlan().swept` — would read those live projections as orphans. So
   * `checkPlan` reports no orphans for one, and `projectWithConsent` refuses to
   * sweep one outright.
   *
   * Absent means the ordinary case: a plan for every enabled harness, which can
   * answer both questions.
   */
  narrowedTo?: HarnessId;
  /**
   * Skill SOURCE folders the scan could not list — `.agents/skills`, or an
   * installed package's `skills/` — each spelled the way that scan spells its
   * paths.
   *
   * **This is a safety marker, not a report line, and the skill sweeps read it.**
   * A folder nobody could look in yields an empty listing, which is the same
   * value an empty folder yields and the opposite fact; the plan is the sweeps'
   * only evidence of what is installed, so an empty listing from a failed read
   * made every live link pointing into that folder look orphaned. One `chmod
   * 000` on `.agents/skills` deleted `.claude/skills/*`, and a package's
   * unreadable `skills/` took all four of its links — measured on the built dist
   * (DOR-1882). While this is non-empty both skill-link sweeps stand down and
   * `checkPlan` is not clean, and a warning names each folder.
   *
   * The same shape `plan/global-projector.ts` carries as `unreadableRoot`, for
   * the same reason and with the same consequence.
   *
   * Absent means every skill root read cleanly, which is the ordinary case.
   * `buildPlan` is the only thing that sets it.
   */
  unreadableSkillRoots?: string[];
}

/**
 * One path a sweep removes, and the one sentence saying why (DOR-1906).
 *
 * The reasons themselves live in `apply/sweep-reasons.ts` — one per finder,
 * written down once so the terminal, the app and the server's log say the same
 * words about the same file.
 */
export interface SweptPath {
  /** The repo-relative path. */
  path: string;
  /** Why it goes, in one plain sentence. */
  reason: string;
}

/** The result of diffing a {@link ProjectionPlan} against the current on-disk state (`--check`). */
export interface DriftResult {
  /** Actions whose target does not yet match the plan (missing, stale, or wrong). */
  drifted: ProjectionAction[];
  /**
   * Actions the engine cannot apply because something it does not own occupies
   * the target — what `--fix` will report as a conflict. Both projection kinds
   * that write a path are here: a `generate` whose file is somebody else's, and
   * a `symlink` with a real file or directory where the link goes. Not drift: no
   * amount of re-running fixes it, and the person has to move or delete what is
   * there first — or, for the commonest case by far, turn symlinks on in a clone
   * that has them off (J-10). Reported separately so `--check` can name it and
   * still exit non-zero, without claiming a projection is merely stale.
   */
  blocked: ProjectionAction[];
  /**
   * The paths of everything a sweep would remove — sorted, unique, and **equal
   * to the `swept` list the next `applyPlan(..., { sweepOrphans: true })`
   * returns** (DOR-1889).
   *
   * **Repo-relative for a project plan; absolute for a global one**
   * (`checkGlobalPlan`, whose targets are absolute by construction). The
   * equality contract holds PER PLAN and never across the two: a project sync
   * removes nothing a global sync would, and the reverse.
   *
   * All six sweeps answer here, not one: installed skill links whose plugin is
   * gone, dead `.claude/skills` links left by an authored skill somebody removed
   * or renamed, generated per-harness hooks files the engine can prove it wrote
   * (with their sidecars), Claude and OpenCode command wrappers, and the managed
   * plugin hooks in `.claude/settings.local.json`. That last one names a file
   * that survives — only its managed hook groups go — and it is listed because
   * it is a path a sync changes without being asked.
   *
   * No plan action names any of them (there is no source left to project), so
   * they are reported here rather than in `drifted`; a `--fix` removes them,
   * which is why they count against `clean`. A plan narrowed to one harness
   * reports none — see {@link ProjectionPlan.narrowedTo}.
   */
  orphans: string[];
  /**
   * The same paths as {@link DriftResult.orphans}, in the same order, each with
   * the one sentence saying why it would go (DOR-1906).
   *
   * Two fields rather than one because they have different readers and both are
   * load-bearing: `orphans` is the set the equality contract with `swept` is
   * written against and the shape every existing caller reads, and this is what
   * a person is shown. `sweep-reasons.ts` holds the sentences.
   *
   * Its paths follow {@link orphans}: repo-relative for a project plan,
   * absolute for a global one.
   */
  removals: SweptPath[];
  /**
   * Paths where somebody's own file sits at a target the engine generates for
   * *some* configuration but not this one — nothing is blocked, nothing needs
   * fixing, and the person is simply told the file is theirs. Never a reason to
   * exit non-zero.
   *
   * **Repo-relative for a project plan; absolute for a global one**, the same
   * rule {@link orphans} states. Always empty for a global plan today: the only
   * targets a global plan writes are symlinks, and this list is about generated
   * files (`checkGlobalPlan`).
   */
  leftAlone: string[];
  /**
   * True when the plan is fully realized on disk: nothing drifted, nothing
   * blocked, nothing a sweep would remove, and every skill folder readable.
   * `leftAlone` entries do not make a tree unclean.
   *
   * The last clause is {@link ProjectionPlan.unreadableSkillRoots}, and it earns
   * its place the way the orphan clause did: a folder DorkOS could not look in
   * is a question this answer cannot settle, and calling the tree clean over one
   * is the same lie as calling it clean over nine files a sync would delete.
   *
   * For a plan narrowed to one harness ({@link ProjectionPlan.narrowedTo}) this
   * says nothing about orphans: `orphans` is empty by rule there, so a `true`
   * means "nothing drifted or blocked for THIS harness" and the tree may still
   * hold plenty a full sync would remove.
   */
  clean: boolean;
}
