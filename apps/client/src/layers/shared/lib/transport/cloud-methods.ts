/**
 * Cloud Transport methods factory — the local `/api/cloud/*` routes: the account
 * link (accounts-and-auth P2) and the plan-aware reads beside it (DOR-2027).
 * These are independent of local login: the panels that drive them are always
 * available.
 *
 * Every plan-aware read answers `{ available: false }` rather than failing when
 * this instance has no cloud account, so a caller renders an empty state instead
 * of an error. Amounts arrive as the contract's micro-unit decimal strings and
 * are formatted once, at the edge — never parsed into a float here.
 *
 * @module shared/lib/transport/cloud-methods
 */
import type {
  CloudCreditsStatus,
  CloudLinkStatus,
  CloudLinkSummary,
  CloudMembersResponse,
  CloudNudgeResponse,
  CloudOrgsResponse,
  CloudPlanResponse,
  CloudSeatActionResponse,
  CloudSeatsResponse,
  CloudUsageResponse,
  StartLinkResult,
} from '@dorkos/shared/cloud-schemas';
import { fetchJSON } from './http-client';

/**
 * Create the cloud-account-link methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createCloudMethods(baseUrl: string) {
  return {
    startCloudLink(): Promise<StartLinkResult> {
      return fetchJSON<StartLinkResult>(baseUrl, '/cloud/link/start', { method: 'POST' });
    },

    getCloudLinkStatus(): Promise<CloudLinkStatus> {
      return fetchJSON<CloudLinkStatus>(baseUrl, '/cloud/link/status');
    },

    unlinkCloud(): Promise<{ ok: boolean }> {
      return fetchJSON<{ ok: boolean }>(baseUrl, '/cloud/unlink', { method: 'POST' });
    },

    getCloudStatus(): Promise<CloudLinkSummary> {
      return fetchJSON<CloudLinkSummary>(baseUrl, '/cloud/status');
    },

    getCloudPlan(): Promise<CloudPlanResponse> {
      return fetchJSON<CloudPlanResponse>(baseUrl, '/cloud/plan');
    },

    getCloudUsage(groupBy: 'seat' | 'model' | 'day'): Promise<CloudUsageResponse> {
      return fetchJSON<CloudUsageResponse>(baseUrl, `/cloud/usage?groupBy=${groupBy}`);
    },

    getCloudNudge(): Promise<CloudNudgeResponse> {
      return fetchJSON<CloudNudgeResponse>(baseUrl, '/cloud/nudge');
    },

    getCloudOrgs(): Promise<CloudOrgsResponse> {
      return fetchJSON<CloudOrgsResponse>(baseUrl, '/cloud/orgs');
    },

    getCloudMembers(orgId: string): Promise<CloudMembersResponse> {
      return fetchJSON<CloudMembersResponse>(
        baseUrl,
        `/cloud/orgs/${encodeURIComponent(orgId)}/members`
      );
    },

    getCloudSeats(orgId: string): Promise<CloudSeatsResponse> {
      return fetchJSON<CloudSeatsResponse>(
        baseUrl,
        `/cloud/orgs/${encodeURIComponent(orgId)}/seats`
      );
    },

    assignCloudSeat(
      seatId: string,
      subject: { kind: 'agent' | 'user'; id: string }
    ): Promise<CloudSeatActionResponse> {
      return fetchJSON<CloudSeatActionResponse>(
        baseUrl,
        `/cloud/seats/${encodeURIComponent(seatId)}/assign`,
        { method: 'POST', body: JSON.stringify({ subject }) }
      );
    },

    releaseCloudSeat(seatId: string): Promise<CloudSeatActionResponse> {
      return fetchJSON<CloudSeatActionResponse>(
        baseUrl,
        `/cloud/seats/${encodeURIComponent(seatId)}/release`,
        { method: 'POST' }
      );
    },

    getCloudCredits(): Promise<CloudCreditsStatus> {
      return fetchJSON<CloudCreditsStatus>(baseUrl, '/cloud/credits');
    },

    selectCloudCredits(): Promise<CloudCreditsStatus> {
      return fetchJSON<CloudCreditsStatus>(baseUrl, '/cloud/credits/select', { method: 'POST' });
    },
  };
}
