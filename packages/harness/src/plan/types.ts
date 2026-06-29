import type { HarnessId } from '../manifest/schema.js';

/** How an artifact reaches a harness. */
export type ProjectionKind = 'native' | 'symlink' | 'scaffold' | 'generate' | 'drop';

/** The kind of agent file being projected. */
export type ArtifactType = 'skill' | 'instruction' | 'hook' | 'command';

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
 * The full result of planning a projection: the actionable projections plus the
 * honest, explicit drop list. Nothing a harness cannot accept is ever silently
 * omitted — it appears in `drops` with a reason.
 */
export interface ProjectionPlan {
  /** Actionable projections (`native` | `symlink` | `scaffold` | `generate`). */
  actions: ProjectionAction[];
  /** Artifacts with no home in a target harness, each with a reason. */
  drops: ProjectionAction[];
}

/** The result of diffing a {@link ProjectionPlan} against the current on-disk state (`--check`). */
export interface DriftResult {
  /** Actions whose target does not yet match the plan (missing, stale, or wrong). */
  drifted: ProjectionAction[];
  /** True when there is no drift — the on-disk state already matches the plan. */
  clean: boolean;
}
