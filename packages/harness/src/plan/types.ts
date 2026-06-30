import type { HarnessId } from '../manifest/schema.js';

/** How an artifact reaches a harness. */
export type ProjectionKind = 'native' | 'symlink' | 'scaffold' | 'generate' | 'drop';

/**
 * The kind of agent file being projected. `plugin` covers plugin-level actions
 * that are not a single skill/hook/command — a whole installed plugin activated
 * natively, or a non-portable plugin layer that is dropped.
 */
export type ArtifactType = 'skill' | 'instruction' | 'hook' | 'command' | 'plugin';

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
 * A projected-but-suspect artifact: it WAS projected (it is in `actions`), but it
 * may not work in the target harness. Surfaced so the operator is told, e.g. when
 * a projected hook command carries a Claude-only substitution token that the
 * target harness will not resolve. Distinct from a `drop` (which never projected).
 */
export interface ProjectionWarning {
  /** The kind of agent file the warning concerns. */
  artifact: ArtifactType;
  /** The harness the possibly-broken projection targets. */
  harness: HarnessId;
  /** The artifact's name (e.g. the hook event). */
  name: string;
  /** Human-readable reason the projection may not work in this harness. */
  reason: string;
}

/**
 * The full result of planning a projection: the actionable projections, the
 * honest drop list, and any warnings about projections that may not work.
 * Nothing a harness cannot accept is ever silently omitted — it appears in
 * `drops` with a reason; a projection that landed but may be broken appears in
 * `warnings` with a reason.
 */
export interface ProjectionPlan {
  /** Actionable projections (`native` | `symlink` | `scaffold` | `generate`). */
  actions: ProjectionAction[];
  /** Artifacts with no home in a target harness, each with a reason. */
  drops: ProjectionAction[];
  /** Projections that landed but may not work in the target harness, each with a reason. */
  warnings: ProjectionWarning[];
}

/** The result of diffing a {@link ProjectionPlan} against the current on-disk state (`--check`). */
export interface DriftResult {
  /** Actions whose target does not yet match the plan (missing, stale, or wrong). */
  drifted: ProjectionAction[];
  /** True when there is no drift — the on-disk state already matches the plan. */
  clean: boolean;
}
