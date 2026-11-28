/**
 * Permissions Transport method factory (spec `agent-permissions` D10).
 *
 * The app's side of the permission routes: read the default layer, one agent,
 * and the history, and write the preset, the defaults and one agent. Every write
 * is refused by the server for anything that is not a person. Every call goes
 * through the generated API client (DOR-5473).
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

/**
 * Create the permission methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createPermissionMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async getPermissions(): Promise<PermissionsResponse> {
      return (await api.call('permissions.get', {})) as PermissionsResponse;
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

    async setPermissionPreset(
      body: SetPermissionPresetBody
    ): Promise<PermissionWriteResult<PermissionsResponse>> {
      return (await api.call('permissions.updatePreset', {
        body,
      })) as PermissionWriteResult<PermissionsResponse>;
    },

    async patchPermissionDefaults(
      body: PatchPermissionDefaultsBody
    ): Promise<PermissionWriteResult<PermissionsResponse>> {
      return (await api.call('permissions.updateDefaults', {
        body,
      })) as PermissionWriteResult<PermissionsResponse>;
    },

    async patchAgentPermissions(
      agentId: string,
      body: PatchAgentPermissionsBody
    ): Promise<PermissionWriteResult<AgentPermissionsResponse>> {
      // The document types each change as a loose record; the server sends
      // `PermissionChange`s, so the cast keeps today's type.
      return (await api.call('agents.updatePermissions', {
        path: { agentId },
        body,
      })) as PermissionWriteResult<AgentPermissionsResponse>;
    },

    // An empty agent, cursor or limit sends nothing, as the hand-written call did.
    async getPermissionHistory(
      query: { agentId?: string; cursor?: string; limit?: number } = {}
    ): Promise<PermissionHistoryResponse> {
      return (await api.call('permissions.view_history', {
        query: {
          agentId: query.agentId || undefined,
          cursor: query.cursor || undefined,
          limit: query.limit || undefined,
        },
      })) as PermissionHistoryResponse;
    },

    async undoPermissionChange(
      eventId: string,
      body: UndoPermissionChangeBody = {}
    ): Promise<UndoPermissionChangeResponse> {
      return (await api.call('permissions.undoHistory', {
        path: { eventId },
        body,
      })) as UndoPermissionChangeResponse;
    },
  };
}
