/**
 * Query keys for the docs in a space (DOR-2982).
 *
 * @module entities/doc/api/query-keys
 */

/** Query keys for doc reads. */
export const docKeys = {
  /** Every doc query, for invalidating all of them. */
  all: ['docs'] as const,
  /** The doc index of one working directory. */
  index: (cwd: string) => ['docs', 'index', cwd] as const,
};
