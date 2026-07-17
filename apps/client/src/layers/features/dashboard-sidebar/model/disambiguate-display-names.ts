/**
 * Disambiguate duplicate agent display names for the sidebar (DOR-329).
 *
 * Two agents whose base display name collides (e.g. two `server` directories)
 * get a parenthetical suffix from the nearest differentiating path segment, so
 * every rendered label is unique.
 *
 * @module features/dashboard-sidebar/model/disambiguate-display-names
 */
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { getAgentDisplayName } from '@/layers/shared/lib';

/**
 * Build a `projectPath → display name` map, disambiguating collisions.
 *
 * @param rawPaths - Agent project paths (roster order).
 * @param agents - Resolved manifests keyed by project path (missing → path-derived name).
 */
export function disambiguateDisplayNames(
  rawPaths: string[],
  agents: Record<string, AgentManifest | null | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  const nameGroups = new Map<string, string[]>();

  for (const p of rawPaths) {
    const base = getAgentDisplayName(agents[p], p.split('/').pop() ?? 'Agent');
    const group = nameGroups.get(base) ?? [];
    group.push(p);
    nameGroups.set(base, group);
  }

  for (const [base, paths] of nameGroups) {
    if (paths.length === 1) {
      result[paths[0]] = base;
      continue;
    }
    // Walk up from the end of each path until a differentiating segment is found.
    const splitPaths = paths.map((p) => p.split('/').filter(Boolean));
    for (const [i, p] of paths.entries()) {
      const segments = splitPaths[i];
      let suffix = '';
      for (let offset = 2; offset < segments.length; offset++) {
        const candidate = segments[segments.length - offset];
        const isUnique = splitPaths.every(
          (other, j) =>
            j === i || other.length < offset || other[other.length - offset] !== candidate
        );
        if (isUnique) {
          suffix = candidate;
          break;
        }
      }
      result[p] = suffix ? `${base} (${suffix})` : base;
    }
  }

  return result;
}
