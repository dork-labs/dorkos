/**
 * Query keys for commitments, in one place so every write can invalidate every
 * list it changes.
 *
 * @module entities/commitment/model/commitment-keys
 */
import type { ListCommitmentsQuery } from '@dorkos/shared/commitment-schemas';

/** Every commitment query sits under this prefix. */
const COMMITMENTS_KEY = ['commitments'] as const;

/** The query keys the commitment hooks read under. */
export const commitmentKeys = {
  /** Everything commitment-shaped. */
  all: COMMITMENTS_KEY,
  /** `GET /api/commitments` with these filters. */
  list: (query: ListCommitmentsQuery = {}) =>
    [...COMMITMENTS_KEY, 'list', query.agentId ?? '', query.state ?? '', query.to ?? ''] as const,
};
