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
    // Stays hand-written: `POST /api/runtimes/{type}/login` has no operationId (DOR-5473).
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
    // Stays hand-written: `GET /api/runtimes/claude-code/signins` has no operationId (DOR-5473).
    getClaudeSigninPolicy: () => fetchJSON<ClaudeSigninPolicyView>(baseUrl, base),
    // Stays hand-written: the `/api/runtimes/claude-code/signins/*` writes have no operationId (DOR-5473).
    changeClaudeSigninPolicy(input: ClaudeSigninPolicyChange): Promise<{ ok: boolean }> {
      switch (input.action) {
        case 'add-org':
          return fetchJSON(baseUrl, `${base}/organizations`, {
            method: 'POST',
            body: JSON.stringify({ orgId: input.orgId, label: input.label }),
          });
        case 'remove-org':
          return fetchJSON(baseUrl, `${base}/organizations/${encodeURIComponent(input.orgId)}`, {
            method: 'DELETE',
          });
        case 'exclude-folder':
          return fetchJSON(baseUrl, `${base}/folders`, {
            method: 'POST',
            body: JSON.stringify({ accountId: input.accountId }),
          });
        case 'allow-folder':
          return fetchJSON(baseUrl, `${base}/folders/${encodeURIComponent(input.accountId)}`, {
            method: 'DELETE',
          });
        case 'accept':
          return fetchJSON(baseUrl, `${base}/${encodeURIComponent(input.accountId)}/accept`, {
            method: 'POST',
          });
      }
    },
  };
}
