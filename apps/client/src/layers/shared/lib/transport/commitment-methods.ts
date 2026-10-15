/**
 * Commitments Transport method factory (spec `heartbeats` §12).
 *
 * The app's side of the commitment routes: read every agent's promises, add
 * one for an agent as the person, and close or move one.
 *
 * @module shared/lib/transport/commitment-methods
 */
import type {
  Commitment,
  CreateCommitmentRequest,
  ListCommitmentsQuery,
  ListCommitmentsResponse,
  UpdateCommitmentRequest,
} from '@dorkos/shared/commitment-schemas';
import { fetchJSON } from './http-client';

/**
 * Create the commitment methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createCommitmentMethods(baseUrl: string) {
  return {
    listCommitments(query: ListCommitmentsQuery = {}): Promise<ListCommitmentsResponse> {
      const params = new URLSearchParams();
      if (query.agentId) params.set('agentId', query.agentId);
      if (query.state) params.set('state', query.state);
      if (query.to) params.set('to', query.to);
      const qs = params.toString();
      return fetchJSON(baseUrl, `/commitments${qs ? `?${qs}` : ''}`);
    },

    createCommitment(agentId: string, body: CreateCommitmentRequest): Promise<Commitment> {
      return fetchJSON(baseUrl, `/agents/${encodeURIComponent(agentId)}/commitments`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    updateCommitment(id: string, body: UpdateCommitmentRequest): Promise<Commitment> {
      return fetchJSON(baseUrl, `/commitments/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
  };
}
