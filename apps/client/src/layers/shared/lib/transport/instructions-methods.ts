/**
 * Agent instructions Transport method factory (spec `context-viewer` phase 3):
 * what every agent is told, and what one agent will be told. Read only.
 *
 * @module shared/lib/transport/instructions-methods
 */
import type {
  InstructionsQuery,
  InstructionsView,
} from '@dorkos/shared/agent-instructions-schemas';
import { fetchJSON } from './http-client';

/**
 * The query string for a view, leaving out what was not chosen.
 *
 * @param query - Runtime, place and level.
 */
function search(query: Partial<InstructionsQuery>): string {
  const params = new URLSearchParams();
  if (query.runtime) params.set('runtime', query.runtime);
  if (query.place) params.set('place', query.place);
  if (query.level) params.set('level', query.level);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * Create the agent instructions methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createInstructionsMethods(baseUrl: string) {
  return {
    getAgentInstructionsTemplate(query: Partial<InstructionsQuery>): Promise<InstructionsView> {
      return fetchJSON(baseUrl, `/agent-instructions${search(query)}`);
    },

    getAgentInstructionsPreview(
      agentId: string,
      query: Partial<InstructionsQuery>
    ): Promise<InstructionsView> {
      return fetchJSON(
        baseUrl,
        `/agents/${encodeURIComponent(agentId)}/instructions${search(query)}`
      );
    },
  };
}
