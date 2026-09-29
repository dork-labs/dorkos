/**
 * Group what is waiting by the project it belongs to (spec
 * `flow-multiproject` §6.3, V2).
 *
 * @module features/inbox/lib/group-by-project
 */
import type { ProjectRef } from '@dorkos/shared/project-schemas';

/** One project's items, or the trailing items that belong to no project. */
export interface ProjectGroup<T> {
  /** The project, or null for the group with no heading. */
  project: ProjectRef | null;
  /** Its items, in the order they arrived. */
  items: T[];
}

/**
 * Split items into one group per project.
 *
 * - Groups keep the order in which each project's first item appears, so a
 *   caller that passes its most urgent items first gets the most urgent
 *   project first.
 * - Items with no project form one trailing group, with no heading.
 * - **With fewer than two distinct projects there is one group with no
 *   heading** (V2: the heading hides), holding every item in its original
 *   order.
 *
 * @param items - Everything waiting, most urgent first.
 * @param projectOf - The project of one item, or null.
 */
export function groupByProject<T>(
  items: readonly T[],
  projectOf: (item: T) => ProjectRef | null
): ProjectGroup<T>[] {
  const byRoot = new Map<string, ProjectGroup<T>>();
  const loose: T[] = [];
  for (const item of items) {
    const project = projectOf(item);
    if (!project) {
      loose.push(item);
      continue;
    }
    const group = byRoot.get(project.root);
    if (group) group.items.push(item);
    else byRoot.set(project.root, { project, items: [item] });
  }
  if (byRoot.size < 2) return items.length === 0 ? [] : [{ project: null, items: [...items] }];
  const groups = [...byRoot.values()];
  if (loose.length > 0) groups.push({ project: null, items: loose });
  return groups;
}
