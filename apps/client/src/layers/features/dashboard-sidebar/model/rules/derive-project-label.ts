/**
 * The repo chip on a session row — for multi-project operators only (BC-38, R4).
 *
 * @module features/dashboard-sidebar/model/rules/derive-project-label
 */
import type { ProjectFacts } from '../sidebar-state';
import { basename } from './targets';

/**
 * The project chip for one session row, or `undefined` when there should be
 * none.
 *
 * **Absent for an operator with one project, and that is the design.** A chip
 * that says the same word on every row is decoration; the chip earns its space
 * only when there is more than one answer (progressive disclosure by data
 * volume). Rooms and agents never carry it: a room is not in a repo, and an
 * agent's project is a property of its sessions.
 *
 * The word "workspace" does not appear here or in anything this returns —
 * six concepts already share it (design-decisions §16), and the naming
 * consolidation belongs to `specs/agent-workspace-binding`.
 *
 * @param cwd - The session's working directory, or nothing when it has none.
 * @param projects - How many projects are active, and their labels.
 */
export function deriveProjectLabel(
  cwd: string | null | undefined,
  projects: ProjectFacts
): string | undefined {
  if (projects.activeCount <= 1) return undefined;
  if (!cwd) return undefined;
  return projects.byCwd[cwd] ?? basename(cwd);
}
