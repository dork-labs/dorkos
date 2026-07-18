/**
 * TanStack Query key factory for the shapes entity (DOR-355).
 *
 * @module entities/shapes/api/query-keys
 */
export const shapeKeys = {
  /** Root key for all shape queries. */
  all: ['shapes'] as const,
  /** The installed-Shapes list (`GET /api/shapes`). */
  list: () => [...shapeKeys.all, 'list'] as const,
};
