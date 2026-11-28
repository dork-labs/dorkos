import type {
  DelegateLoginOptions,
  DelegatedLoginResult,
  ClaudeSigninPolicyChange,
  ClaudeSigninPolicyView,
} from '@dorkos/shared/runtime-connect';
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';

/**
 * All identity decisions stay on the server, addressed by registry ID. The
 * sign-in policy goes through the generated API client (DOR-5473).
 */
export function createAccountSigninMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  const base = '/runtimes/claude-code/signins';
  return {
    // Stays hand-written: sends no body when nothing is pinned; waits for batch 3's
    // no-body client (DOR-5473).
    delegateRuntimeLogin(
      type: string,
      options?: DelegateLoginOptions
    ): Promise<DelegatedLoginResult> {
      const pin: Record<string, string> = {};
      if (options?.sessionId !== undefined) pin.sessionId = options.sessionId;
      if (options?.accountId !== undefined) pin.accountId = options.accountId;
      return fetchJSON(baseUrl, `/runtimes/${encodeURIComponent(type)}/login`, {
        method: 'POST',
        ...(Object.keys(pin).length ? { body: JSON.stringify(pin) } : {}),
      });
    },
    getClaudeSigninPolicy: (): Promise<ClaudeSigninPolicyView> =>
      api.call('runtimes.getClaudeCodeSignins', {}),
    changeClaudeSigninPolicy(input: ClaudeSigninPolicyChange): Promise<{ ok: boolean }> {
      switch (input.action) {
        case 'add-org':
          return api.call('runtimes.createClaudeCodeSigninsOrganizations', {
            body: { orgId: input.orgId, label: input.label },
          });
        case 'remove-org':
          return api.call('runtimes.deleteClaudeCodeSigninsOrganizations', {
            path: { id: input.orgId },
          });
        case 'exclude-folder':
          return api.call('runtimes.createClaudeCodeSigninsFolders', {
            body: { accountId: input.accountId },
          });
        case 'allow-folder':
          return api.call('runtimes.deleteClaudeCodeSigninsFolders', {
            path: { id: input.accountId },
          });
        case 'accept':
          // Stays hand-written: sends no body; waits for batch 3's no-body client (DOR-5473).
          return fetchJSON(baseUrl, `${base}/${encodeURIComponent(input.accountId)}/accept`, {
            method: 'POST',
          });
      }
    },
  };
}
