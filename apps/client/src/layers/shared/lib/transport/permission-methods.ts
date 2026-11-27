/**
 * Permissions Transport method factory (spec `agent-permissions` D10).
 *
 * The app's side of the permission routes: read the default layer, one agent,
 * and the history, and write the preset, the defaults and one agent. Every write
 * is refused by the server for anything that is not a person. The calls with a
 * documented operation go through the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/permission-methods
 */
import type {
  AgentLevelResponse,
  AgentPermissionsResponse,
  PatchAgentPermissionsBody,
  PatchPermissionDefaultsBody,
  PermissionHistoryResponse,
  PermissionsResponse,
  SetPermissionPresetBody,
  UndoPermissionChangeBody,
  UndoPermissionChangeResponse,
} from '@dorkos/shared/permissions';
import type { PermissionWriteResult } from '@dorkos/shared/transport';
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';

/**
 * Create the permission methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createPermissionMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    // Stays hand-written: `GET /api/permissions` has no operationId (DOR-5473).
    getPermissions(): Promise<PermissionsResponse> {
      return fetchJSON(baseUrl, '/permissions');
    },

    // The document also lists each read capability's 202 approval answer, which
    // a person's own read never gets; the casts keep today's types.
    async getAgentPermissions(agentId: string): Promise<AgentPermissionsResponse> {
      return (await api.call('permissions.view_agent', {
        path: { agentId },
      })) as AgentPermissionsResponse;
    },

    async getAgentLevel(agentId: string): Promise<AgentLevelResponse> {
      return (await api.call('permissions.view_agent_level', {
        path: { agentId },
      })) as AgentLevelResponse;
    },

    // Stays hand-written: `PUT /api/permissions/preset` has no operationId (DOR-5473).
    setPermissionPreset(
      body: SetPermissionPresetBody
    ): Promise<PermissionWriteResult<PermissionsResponse>> {
      return fetchJSON(baseUrl, '/permissions/preset', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },

    // Stays hand-written: `PATCH /api/permissions/defaults` has no operationId (DOR-5473).
    patchPermissionDefaults(
      body: PatchPermissionDefaultsBody
    ): Promise<PermissionWriteResult<PermissionsResponse>> {
      return fetchJSON(baseUrl, '/permissions/defaults', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },

    // Stays hand-written: the generated body for `agents.updatePermissions` drops the
    // `null` that puts an area back to its default (DOR-5473).
    patchAgentPermissions(
      agentId: string,
      body: PatchAgentPermissionsBody
    ): Promise<PermissionWriteResult<AgentPermissionsResponse>> {
      return fetchJSON(baseUrl, `/agents/${encodeURIComponent(agentId)}/permissions`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },

    // Stays hand-written: `GET /api/permissions/history` has no operationId (DOR-5473).
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

    // Stays hand-written: `POST /api/permissions/history/{eventId}/undo` has no
    // operationId (DOR-5473).
    undoPermissionChange(
      eventId: string,
      body: UndoPermissionChangeBody = {}
    ): Promise<UndoPermissionChangeResponse> {
      return fetchJSON(baseUrl, `/permissions/history/${encodeURIComponent(eventId)}/undo`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  };
}
