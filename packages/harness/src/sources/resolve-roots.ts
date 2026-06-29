/**
 * Source-root resolution — where authored / installed / adopted skills live.
 *
 * Each root carries its {@link Provenance}, which downstream drives the gitignore
 * policy (installed/adopted projections are ephemeral) and the collision policy.
 *
 * @module sources/resolve-roots
 */
import type { Provenance } from '../plan/types.js';

/** A skill source root and the provenance of everything found beneath it. */
export interface SourceRoot {
  /** Where skills under this root came from. */
  class: Provenance;
  /** Repo-relative skills directory for this root. */
  skillsDir: string;
}

/**
 * Resolve the skill source roots to scan for a repository.
 *
 * v1 returns only the authored root (`.agents/skills`). Installed (marketplace)
 * and adopted roots are Phase 2 and will need `repoRoot` to locate per-plugin
 * skill directories.
 *
 * @param _repoRoot - absolute repository root (reserved for Phase 2 scanning).
 * @returns the source roots to scan; v1 returns only the authored root.
 */
export function resolveSourceRoots(_repoRoot: string): SourceRoot[] {
  // TODO(DOR-173): also resolve installed (marketplace) and adopted source roots.
  return [{ class: 'authored', skillsDir: '.agents/skills' }];
}
