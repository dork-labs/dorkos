/**
 * How the project registry names a root (spec `flow-multiproject` §6.1, N4):
 * the folder's name in URL-safe characters, then `name~parent`, then a count.
 * See the Names section of `project-registry.ts`.
 *
 * @module services/projects/project-names
 */
import path from 'node:path';

/**
 * A folder name in the characters a project name may hold.
 *
 * @param segment - One path segment.
 * @returns The segment with every character outside `[A-Za-z0-9._-]` as `-`.
 */
export function sanitizeNameSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * The name a new root gets, given the names already taken.
 *
 * @param root - The new project's root.
 * @param isTaken - Whether a name already belongs to another project.
 */
export function assignProjectName(root: string, isTaken: (name: string) => boolean): string {
  const base = sanitizeNameSegment(path.basename(root)) || 'project';
  if (!isTaken(base)) return base;
  const parent = sanitizeNameSegment(path.basename(path.dirname(root))) || 'root';
  const withParent = `${base}~${parent}`;
  if (!isTaken(withParent)) return withParent;
  for (let n = 2; ; n++) {
    const candidate = `${withParent}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
}
