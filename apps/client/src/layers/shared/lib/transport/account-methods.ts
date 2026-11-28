/**
 * Account Transport methods (spec `claude-account-ui` §6.0, §6.9): how much of
 * each account is used, carrying a session whose account ran out over to
 * another one, the Claude account folders found on this computer, which
 * accounts may work in which projects (spec `flow-multiproject` §8.6), and
 * which accounts agents are kept off in automatic moves (Re-seat P0).
 *
 * Every refusal rejects through {@link fetchJSON}'s error, which carries the
 * server's message and the HTTP `status`: the picker and the banner show that
 * message as is, so nothing here rewrites it.
 *
 * @module shared/lib/transport/account-methods
 */
import type {
  AccountUsage,
  ContinueOptionsResponse,
  FoundClaudeFolder,
  LimitHistoryEntry,
} from '@dorkos/shared/account-usage';
import type {
  AccountEligibilityResponse,
  AgentsMayPick,
  NoAutoMove,
  OnlyProjectsResponse,
} from '@dorkos/shared/project-schemas';
import { createTransportApiClient } from './api-client';
import { fetchJSON, fetchNoContent } from './http-client';

/** The path of one session's account routes. */
function sessionPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

/** Create the account methods bound to a base URL. */
export function createAccountMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    // The document's `type` is the four runtimes; the server refuses any other.
    async getAccountUsage(runtime: string): Promise<{ accounts: AccountUsage[] }> {
      return (await api.call('runtimes.account_usage', {
        path: { type: runtime as 'claude-code' | 'codex' | 'opencode' | 'doe' },
      })) as { accounts: AccountUsage[] };
    },

    getContinueOptions(sessionId: string): Promise<ContinueOptionsResponse> {
      return fetchJSON<ContinueOptionsResponse>(
        baseUrl,
        `${sessionPath(sessionId)}/continue-options`
      );
    },

    continueSession(
      sessionId: string,
      body: { account?: string; model?: string; runtime?: string }
    ): Promise<{ sessionId?: string }> {
      return fetchJSON<{ sessionId?: string }>(baseUrl, `${sessionPath(sessionId)}/continue`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    // The two writes below read no answer: whatever the route sends back (a
    // body or none), the caller learns the new state from the session stream.
    waitForReset(sessionId: string, body: { autoResume?: boolean }): Promise<void> {
      return fetchNoContent(baseUrl, `${sessionPath(sessionId)}/wait`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    cancelAutoContinue(sessionId: string): Promise<void> {
      return fetchNoContent(baseUrl, `${sessionPath(sessionId)}/continue`, { method: 'DELETE' });
    },

    getLimitHistory(sessionId: string): Promise<{ entries: LimitHistoryEntry[] }> {
      return fetchJSON<{ entries: LimitHistoryEntry[] }>(
        baseUrl,
        `${sessionPath(sessionId)}/limit-history`
      );
    },

    async getFoundClaudeFolders(): Promise<{ folders: FoundClaudeFolder[] }> {
      return (await api.call('runtimes.found_accounts', {})) as { folders: FoundClaudeFolder[] };
    },

    async dismissFoundClaudeFolder(path: string): Promise<void> {
      await api.call('runtimes.createClaudeCodeAccountsFoundDismiss', { body: { path } });
    },

    async getAccountEligibility(folder?: string): Promise<AccountEligibilityResponse> {
      return (await api.call('runtimes.account_eligibility', {
        query: { project: folder || undefined },
      })) as AccountEligibilityResponse;
    },

    async setProjectAccounts(
      project: string,
      allow: string[] | null
    ): Promise<AccountEligibilityResponse> {
      return await api.call('runtimes.updateClaudeCodeProjectAccounts', {
        body: { project, allow },
      });
    },

    async keepCreditsOutOfProject(sessionId: string): Promise<AccountEligibilityResponse> {
      return await api.call('runtimes.createClaudeCodeProjectAccountsWithoutCredits', {
        body: { sessionId },
      });
    },

    async setAccountOnlyProjects(
      accountId: string,
      projects: string[] | null
    ): Promise<OnlyProjectsResponse> {
      return await api.call('runtimes.updateClaudeCodeAccountsOnlyProjects', {
        path: { id: accountId },
        body: { projects },
      });
    },

    async setAccountNoAutoMove(accountId: string, noAutoMove: boolean): Promise<NoAutoMove> {
      return await api.call('runtimes.updateClaudeCodeAccountsNoAutoMove', {
        path: { id: accountId },
        body: { noAutoMove },
      });
    },

    async setAccountAgentsMayPick(
      accountId: string,
      agentsMayPick: boolean
    ): Promise<AgentsMayPick> {
      return await api.call('runtimes.updateClaudeCodeAccountsAgentsMayPick', {
        path: { id: accountId },
        body: { agentsMayPick },
      });
    },
  };
}
