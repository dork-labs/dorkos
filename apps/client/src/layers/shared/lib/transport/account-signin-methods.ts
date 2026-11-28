import type {
  DelegateLoginOptions,
  DelegatedLoginResult,
  ClaudeSigninPolicyChange,
  ClaudeSigninPolicyView,
} from '@dorkos/shared/runtime-connect';
import { createTransportApiClient } from './api-client';

/**
 * All identity decisions stay on the server, addressed by registry ID. The
 * sign-in policy goes through the generated API client (DOR-5473).
 */
export function createAccountSigninMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    // Sends no body when nothing is pinned. The document names the two runtimes
    // that sign in today; the cast keeps the caller's open `type`.
    async delegateRuntimeLogin(
      type: string,
      options?: DelegateLoginOptions
    ): Promise<DelegatedLoginResult> {
      const pin: { sessionId?: string; accountId?: string } = {};
      if (options?.sessionId !== undefined) pin.sessionId = options.sessionId;
      if (options?.accountId !== undefined) pin.accountId = options.accountId;
      return (await api.call('runtimes.createLogin', {
        path: { type: type as 'claude-code' | 'codex' },
        ...(Object.keys(pin).length ? { body: pin } : {}),
      })) as DelegatedLoginResult;
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
          return api.call('runtimes.acceptClaudeCodeSignins', {
            path: { id: input.accountId },
          }) as Promise<{ ok: boolean }>;
      }
    },
  };
}
