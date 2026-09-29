/**
 * Query keys for the project registry.
 *
 * @module entities/project/api/queries
 */

/** TanStack Query keys for projects. */
export const projectKeys = {
  /** Every project query. */
  all: ['projects'] as const,
  /** The list of known projects. */
  list: () => [...projectKeys.all, 'list'] as const,
  /** The project one folder belongs to. */
  forCwd: (cwd: string) => [...projectKeys.all, 'for-cwd', cwd] as const,
};
