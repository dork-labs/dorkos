/**
 * Account Transport methods (spec `claude-account-ui` §6.0): how much of each
 * account is used, and carrying a session whose account ran out over to
 * another one.
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
  LimitHistoryEntry,
} from '@dorkos/shared/account-usage';
import { fetchJSON, fetchNoContent } from './http-client';

/** The path of one session's account routes. */
function sessionPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

/** Create the account methods bound to a base URL. */
export function createAccountMethods(baseUrl: string) {
  return {
    getAccountUsage(runtime: string): Promise<{ accounts: AccountUsage[] }> {
      return fetchJSON<{ accounts: AccountUsage[] }>(
        baseUrl,
        `/runtimes/${encodeURIComponent(runtime)}/accounts/usage`
      );
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
      return fetchNoContent(baseUrl, `${sessionPath(sessionId)}/continue/cancel`, {
        method: 'POST',
      });
    },

    getLimitHistory(sessionId: string): Promise<{ entries: LimitHistoryEntry[] }> {
      return fetchJSON<{ entries: LimitHistoryEntry[] }>(
        baseUrl,
        `${sessionPath(sessionId)}/limit-history`
      );
    },
  };
}
