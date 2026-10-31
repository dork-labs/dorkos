import type {
  DelegateLoginOptions,
  DelegatedLoginResult,
  ClaudeSigninPolicyChange,
  ClaudeSigninPolicyView,
} from '@dorkos/shared/runtime-connect';
import { fetchJSON } from './http-client';

/** All identity decisions stay on the server, addressed by registry ID. */
export function createAccountSigninMethods(baseUrl: string) {
  const base = '/runtimes/claude-code/signins';
  return {
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
    getClaudeSigninPolicy: () => fetchJSON<ClaudeSigninPolicyView>(baseUrl, base),
    changeClaudeSigninPolicy(input: ClaudeSigninPolicyChange): Promise<{ ok: boolean }> {
      const { password, confirmOnThisComputer } = input;
      switch (input.action) {
        case 'add-org':
          return fetchJSON(baseUrl, `${base}/organizations`, {
            method: 'POST',
            body: JSON.stringify({
              password,
              confirmOnThisComputer,
              orgId: input.orgId,
              label: input.label,
            }),
          });
        case 'remove-org':
          return fetchJSON(baseUrl, `${base}/organizations/${encodeURIComponent(input.orgId)}`, {
            method: 'DELETE',
            body: JSON.stringify({ password, confirmOnThisComputer }),
          });
        case 'exclude-folder':
          return fetchJSON(baseUrl, `${base}/folders`, {
            method: 'POST',
            body: JSON.stringify({ password, confirmOnThisComputer, accountId: input.accountId }),
          });
        case 'allow-folder':
          return fetchJSON(baseUrl, `${base}/folders/${encodeURIComponent(input.accountId)}`, {
            method: 'DELETE',
            body: JSON.stringify({ password, confirmOnThisComputer }),
          });
        case 'accept':
          return fetchJSON(baseUrl, `${base}/${encodeURIComponent(input.accountId)}/accept`, {
            method: 'POST',
            body: JSON.stringify({ password, confirmOnThisComputer }),
          });
      }
    },
  };
}
