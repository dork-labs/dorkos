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
  CloudCommunityClaimLinkResponse,
  CloudCommunityKeepResponse,
  CloudCommunityMovePollResponse,
  CloudCommunityMoveResponse,
  CloudCommunityMoveStartInput,
  CloudCommunityNameCheckResponse,
  CloudCommunityRestoreResponse,
  CloudCommunityStartResponse,
  CloudCreditsStatus,
  CloudHostedCommunitiesResponse,
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
import { startHostedCommunityMoveOverHttp } from './community-move-methods';

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

    listHostedCommunities(): Promise<CloudHostedCommunitiesResponse> {
      return fetchJSON<CloudHostedCommunitiesResponse>(baseUrl, '/cloud/communities');
    },

    checkHostedCommunityName(name: string): Promise<CloudCommunityNameCheckResponse> {
      return fetchJSON<CloudCommunityNameCheckResponse>(
        baseUrl,
        `/cloud/communities/name-check?name=${encodeURIComponent(name)}`
      );
    },

    startHostedCommunity(input: {
      idempotencyKey: string;
      name: string;
      shortName?: string;
    }): Promise<CloudCommunityStartResponse> {
      return fetchJSON<CloudCommunityStartResponse>(baseUrl, '/cloud/communities', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },

    getHostedCommunityClaimLink(communityId: string): Promise<CloudCommunityClaimLinkResponse> {
      return fetchJSON<CloudCommunityClaimLinkResponse>(
        baseUrl,
        `/cloud/communities/${encodeURIComponent(communityId)}/claim-link`,
        { method: 'POST', cache: 'no-store' }
      );
    },

    keepHostedCommunity(
      communityId: string,
      expectedHeldCommunityIds: string[]
    ): Promise<CloudCommunityKeepResponse> {
      return fetchJSON<CloudCommunityKeepResponse>(
        baseUrl,
        `/cloud/communities/${encodeURIComponent(communityId)}/keep`,
        { method: 'POST', body: JSON.stringify({ expectedHeldCommunityIds }) }
      );
    },

    restoreHostedCommunity(communityId: string): Promise<CloudCommunityRestoreResponse> {
      return fetchJSON<CloudCommunityRestoreResponse>(
        baseUrl,
        `/cloud/communities/${encodeURIComponent(communityId)}/restore`,
        { method: 'POST' }
      );
    },

    startHostedCommunityMove(
      file: Blob,
      input: CloudCommunityMoveStartInput,
      onProgress?: (progress: { loaded: number; total: number }) => void,
      signal?: AbortSignal
    ): Promise<CloudCommunityMoveResponse> {
      return startHostedCommunityMoveOverHttp(baseUrl, file, input, onProgress, signal);
    },

    getHostedCommunityMove(moveId: string): Promise<CloudCommunityMovePollResponse> {
      return fetchJSON<CloudCommunityMovePollResponse>(
        baseUrl,
        `/cloud/communities/moves/${encodeURIComponent(moveId)}`
      );
    },

    cancelHostedCommunityMove(moveId: string): Promise<CloudCommunityMoveResponse> {
      return fetchJSON<CloudCommunityMoveResponse>(
        baseUrl,
        `/cloud/communities/moves/${encodeURIComponent(moveId)}/cancel`,
        { method: 'POST' }
      );
    },

    retryHostedCommunityMoveUpload(moveId: string): Promise<CloudCommunityMoveResponse> {
      return fetchJSON<CloudCommunityMoveResponse>(
        baseUrl,
        `/cloud/communities/moves/${encodeURIComponent(moveId)}/upload`,
        { method: 'POST' }
      );
    },
  };
}
