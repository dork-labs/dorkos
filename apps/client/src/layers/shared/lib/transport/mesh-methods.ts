/**
 * Mesh discovery, observability, topology, and agent identity Transport methods factory.
 *
 * @module shared/lib/transport/mesh-methods
 */
import type {
  AgentManifest,
  AgentPathEntry,
  CreateAgentOptions,
  DiscoveryCandidate,
  DenialRecord,
  AgentHealth,
  MeshStatus,
  TopologyView,
  UpdateAccessRuleRequest,
  CrossNamespaceRule,
} from '@dorkos/shared/mesh-schemas';
import { fetchJSON, buildQueryString } from './http-client';

/** Create all Mesh + Agent Identity methods bound to a base URL. */
export function createMeshMethods(baseUrl: string) {
  return {
    // --- Mesh Agent Discovery ---

    listMeshAgentPaths(): Promise<{ agents: AgentPathEntry[] }> {
      return fetchJSON(baseUrl, '/mesh/agents/paths');
    },

    discoverMeshAgents(
      roots: string[],
      maxDepth?: number
    ): Promise<{ candidates: DiscoveryCandidate[] }> {
      return fetchJSON(baseUrl, '/mesh/discover', {
        method: 'POST',
        body: JSON.stringify({ roots, ...(maxDepth !== undefined && { maxDepth }) }),
      });
    },

    listMeshAgents(filters?: {
      runtime?: string;
      capability?: string;
    }): Promise<{ agents: AgentManifest[] }> {
      const qs = buildQueryString({
        runtime: filters?.runtime,
        capability: filters?.capability,
      });
      return fetchJSON(baseUrl, `/mesh/agents${qs}`);
    },

    getMeshAgent(id: string): Promise<AgentManifest> {
      return fetchJSON(baseUrl, `/mesh/agents/${id}`);
    },

    registerMeshAgent(
      path: string,
      overrides?: Partial<AgentManifest>,
      approver?: string
    ): Promise<AgentManifest> {
      return fetchJSON(baseUrl, '/mesh/agents', {
        method: 'POST',
        body: JSON.stringify({
          path,
          ...(overrides && { overrides }),
          ...(approver && { approver }),
        }),
      });
    },

    updateMeshAgent(id: string, updates: Partial<AgentManifest>): Promise<AgentManifest> {
      return fetchJSON(baseUrl, `/mesh/agents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
    },

    unregisterMeshAgent(id: string): Promise<{ success: boolean }> {
      return fetchJSON(baseUrl, `/mesh/agents/${id}`, { method: 'DELETE' });
    },

    denyMeshAgent(path: string, reason?: string, denier?: string): Promise<{ success: boolean }> {
      return fetchJSON(baseUrl, '/mesh/deny', {
        method: 'POST',
        body: JSON.stringify({ path, ...(reason && { reason }), ...(denier && { denier }) }),
      });
    },

    listDeniedMeshAgents(): Promise<{ denied: DenialRecord[] }> {
      return fetchJSON(baseUrl, '/mesh/denied');
    },

    clearMeshDenial(path: string): Promise<{ success: boolean }> {
      return fetchJSON(baseUrl, `/mesh/denied/${encodeURIComponent(path)}`, {
        method: 'DELETE',
      });
    },

    // --- Mesh Observability ---

    getMeshStatus(): Promise<MeshStatus> {
      return fetchJSON(baseUrl, '/mesh/status');
    },

    getMeshAgentHealth(id: string): Promise<AgentHealth> {
      return fetchJSON(baseUrl, `/mesh/agents/${id}/health`);
    },

    sendMeshHeartbeat(id: string, event?: string): Promise<{ success: boolean }> {
      return fetchJSON(baseUrl, `/mesh/agents/${id}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ ...(event && { event }) }),
      });
    },

    // --- Mesh Topology ---

    getMeshTopology(namespace?: string): Promise<TopologyView> {
      const qs = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
      return fetchJSON(baseUrl, `/mesh/topology${qs}`);
    },

    updateMeshAccessRule(body: UpdateAccessRuleRequest): Promise<CrossNamespaceRule> {
      return fetchJSON(baseUrl, '/mesh/topology/access', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },

    getMeshAgentAccess(agentId: string): Promise<{ agents: AgentManifest[] }> {
      return fetchJSON(baseUrl, `/mesh/agents/${encodeURIComponent(agentId)}/access`);
    },

    // --- Agent Identity ---

    async getAgentByPath(path: string): Promise<AgentManifest | null> {
      const res = await fetch(`${baseUrl}/agents/current?path=${encodeURIComponent(path)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Failed to get agent: ${res.statusText}`);
      return res.json();
    },

    async resolveAgents(paths: string[]): Promise<Record<string, AgentManifest | null>> {
      const data = await fetchJSON<{ agents: Record<string, AgentManifest | null> }>(
        baseUrl,
        '/agents/resolve',
        {
          method: 'POST',
          body: JSON.stringify({ paths }),
        }
      );
      return data.agents;
    },

    initAgent(
      path: string,
      name?: string,
      description?: string,
      runtime?: string
    ): Promise<AgentManifest> {
      return fetchJSON<AgentManifest>(baseUrl, '/agents', {
        method: 'POST',
        body: JSON.stringify({
          path,
          ...(name && { name }),
          ...(description && { description }),
          ...(runtime && { runtime }),
        }),
      });
    },

    updateAgentByPath(path: string, updates: Partial<AgentManifest>): Promise<AgentManifest> {
      return fetchJSON<AgentManifest>(baseUrl, `/agents/current?path=${encodeURIComponent(path)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });
    },

    createAgent(opts: CreateAgentOptions): Promise<AgentManifest & { _path: string }> {
      return fetchJSON<AgentManifest & { _path: string }>(baseUrl, '/agents/create', {
        method: 'POST',
        body: JSON.stringify(opts),
      });
    },
  };
}
