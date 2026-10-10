/**
 * The commitments slice of the {@link Transport} port: what agents promised,
 * read by anyone, added and changed by a person (spec `heartbeats` §12).
 *
 * Split out of `transport.ts` the way the rooms slice is: `Transport` extends
 * this, so nothing consuming the port sees a difference.
 *
 * @module shared/transport-commitments
 */
import type {
  Commitment,
  CreateCommitmentRequest,
  ListCommitmentsQuery,
  ListCommitmentsResponse,
  UpdateCommitmentRequest,
} from './commitment-schemas.js';

/** The commitment methods every Transport implements. */
export interface CommitmentTransport {
  /**
   * What agents promised. Anyone reads every agent's list; open ones come
   * first, and `overdue` is computed by the server.
   *
   * @param query - Optional filters: one agent, one state, or one recipient.
   */
  listCommitments(query?: ListCommitmentsQuery): Promise<ListCommitmentsResponse>;

  /**
   * Record a promise an agent made, as the person.
   *
   * @param agentId - The agent that promised.
   * @param body - What, to whom, and by when.
   */
  createCommitment(agentId: string, body: CreateCommitmentRequest): Promise<Commitment>;

  /**
   * Mark a promise kept, missed or dropped, or move its date.
   *
   * @param id - The commitment id.
   * @param body - The new state, and optionally a new date and a note.
   */
  updateCommitment(id: string, body: UpdateCommitmentRequest): Promise<Commitment>;
}
