/**
 * Permissions Transport method factory (spec `agent-permissions` D10).
 *
 * The app's side of the permission routes: read the default layer, one agent,
 * and the history, and write the preset, the defaults and one agent. Every write
 * is refused by the server for anything that is not a person.
 *
 * @module shared/lib/transport/permission-methods
 */
import type {
  AgentPermissionsResponse,
  PatchAgentPermissionsBody,
  PatchPermissionDefaultsBody,
  PermissionHistoryResponse,
  PermissionsResponse,
  SetPermissionPresetBody,
} from '@dorkos/shared/permissions';
import type { PermissionWriteResult } from '@dorkos/shared/transport';
import { fetchJSON } from './http-client';

/**
 * Create the permission methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createPermissionMethods(baseUrl: string) {
  return {
    getPermissions(): Promise<PermissionsResponse> {
      return fetchJSON(baseUrl, '/permissions');
    },

    getAgentPermissions(agentId: string): Promise<AgentPermissionsResponse> {
      return fetchJSON(baseUrl, `/agents/${encodeURIComponent(agentId)}/permissions`);
    },

    setPermissionPreset(
      body: SetPermissionPresetBody
    ): Promise<PermissionWriteResult<PermissionsResponse>> {
      return fetchJSON(baseUrl, '/permissions/preset', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },

    patchPermissionDefaults(
      body: PatchPermissionDefaultsBody
    ): Promise<PermissionWriteResult<PermissionsResponse>> {
      return fetchJSON(baseUrl, '/permissions/defaults', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },

    patchAgentPermissions(
      agentId: string,
      body: PatchAgentPermissionsBody
    ): Promise<PermissionWriteResult<AgentPermissionsResponse>> {
      return fetchJSON(baseUrl, `/agents/${encodeURIComponent(agentId)}/permissions`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },

    getPermissionHistory(
      query: { agentId?: string; before?: string; limit?: number } = {}
    ): Promise<PermissionHistoryResponse> {
      const params = new URLSearchParams();
      if (query.agentId) params.set('agentId', query.agentId);
      if (query.before) params.set('before', query.before);
      if (query.limit) params.set('limit', String(query.limit));
      const search = params.toString();
      return fetchJSON(baseUrl, `/permissions/history${search ? `?${search}` : ''}`);
    },
  };
}
