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
  CloudBillingPage,
  CloudAccountDeletionResponse,
  CloudAccountExportResponse,
  CloudBillingSessionResponse,
  CloudCommunityClaimLinkResponse,
  CloudCommunityKeepResponse,
  CloudCommunityMovePollResponse,
  CloudCommunityMoveRoomResponse,
  CloudCommunityMoveResponse,
  CloudCommunityMoveStartInput,
  CloudCommunityNameCheckResponse,
  CloudCommunitySignInResponse,
  CloudCommunityRestoreResponse,
  CloudCommunityStartResponse,
  CloudCreditsNoticeDismissRequest,
  CloudCreditsStatus,
  CloudHostedCommunitiesResponse,
  CloudLinkStatus,
  CloudLinkSummary,
  CloudMembersResponse,
  CloudNudgeResponse,
  CloudOffersResponse,
  CloudOrgsResponse,
  CloudPlanResponse,
  CloudSeatActionResponse,
  CloudSeatsResponse,
  CloudUsageResponse,
  StartLinkResult,
} from '@dorkos/shared/cloud-schemas';
import { isProblem } from '@dorkos/shared/problem';
import { createTransportApiClient } from './api-client';
import { buildQueryString, fetchJSON } from './http-client';
import { startHostedCommunityMoveOverHttp } from './community-move-methods';

/**
 * Answer a write whose reply is an `ok` envelope, handing back the server's
 * refusal of the request instead of throwing it.
 *
 * Every DorkOS account write is for the owner of this DorkOS, and the
 * server answers anyone else, and a request it can't take, with a `4xx`
 * problem document carrying one sentence in `detail` (DOR-4979). `fetchJSON`
 * throws on every non-2xx, so without this the sentence would be lost and the
 * surface would say the account could not be reached. A `5xx` still throws.
 *
 * @param send - The write, as a `fetchJSON` call.
 */
async function refusalOrAnswer<T>(
  send: () => Promise<T>
): Promise<T | { ok: false; message: string }> {
  try {
    return await send();
  } catch (err) {
    const body = (err as { body?: unknown }).body;
    if (isProblem(body) && body.status < 500 && err instanceof Error) {
      return { ok: false, message: err.message };
    }
    throw err;
  }
}

/**
 * Create the cloud-account-link methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createCloudMethods(baseUrl: string) {
  // The calls with an operationId go through the generated client (DOR-5473).
  // The rest have none yet; `hand-written-census.json` names each one. The
  // document types some answers looser than the contract (a refusal's `code` as
  // any string) or not at all (`{}`); the casts keep today's types.
  const api = createTransportApiClient(baseUrl);
  return {
    // The bodyless writes send no body, as they always have; their routes read none.
    startCloudLink(): Promise<StartLinkResult> {
      return api.call('cloud.startLink', {});
    },

    getCloudLinkStatus(): Promise<CloudLinkStatus> {
      return api.call('cloud.getLinkStatus', {});
    },

    cancelCloudLink(): Promise<CloudLinkStatus> {
      return api.call('cloud.cancelLink', {});
    },

    unlinkCloud(): Promise<{ ok: boolean }> {
      return api.call('cloud.unlink', {});
    },

    getCloudStatus(): Promise<CloudLinkSummary> {
      return api.call('cloud.getStatus', {});
    },

    checkCloudLink(): Promise<CloudLinkSummary> {
      return api.call('cloud.checkLink', {});
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
      return refusalOrAnswer(
        async () =>
          (await api.call('cloud.createSeatsAssign', {
            path: { seatId },
            body: { subject },
          })) as CloudSeatActionResponse
      );
    },

    releaseCloudSeat(seatId: string): Promise<CloudSeatActionResponse> {
      return refusalOrAnswer(() =>
        fetchJSON<CloudSeatActionResponse>(
          baseUrl,
          `/cloud/seats/${encodeURIComponent(seatId)}/release`,
          { method: 'POST' }
        )
      );
    },

    async getCloudOffers(): Promise<CloudOffersResponse> {
      return (await api.call('cloud.getOffers', {})) as CloudOffersResponse;
    },

    createCloudBillingSession(
      page: CloudBillingPage,
      skuId?: string
    ): Promise<CloudBillingSessionResponse> {
      return refusalOrAnswer(
        async () =>
          (await api.call('cloud.createBilling', {
            path: { page },
            body: skuId === undefined ? {} : { skuId },
          })) as CloudBillingSessionResponse
      );
    },

    requestCloudAccountExport(): Promise<CloudAccountExportResponse> {
      return refusalOrAnswer(
        async () => (await api.call('cloud.exportAccount', {})) as CloudAccountExportResponse
      );
    },

    requestCloudAccountDeletion(): Promise<CloudAccountDeletionResponse> {
      return refusalOrAnswer(
        async () =>
          (await api.call('cloud.createAccountDeletion', {})) as CloudAccountDeletionResponse
      );
    },

    getCloudCredits(): Promise<CloudCreditsStatus> {
      return fetchJSON<CloudCreditsStatus>(baseUrl, '/cloud/credits');
    },

    async setCloudCreditsDefault(
      runtime: string,
      useCredits: boolean
    ): Promise<CloudCreditsStatus> {
      const body = { runtime, useCredits };
      return (await api.call('cloud.updateCreditsDefault', { body })) as CloudCreditsStatus;
    },

    undoFilledCloudCredits(): Promise<CloudCreditsStatus> {
      return fetchJSON<CloudCreditsStatus>(baseUrl, '/cloud/credits/undo-filled', {
        method: 'POST',
      });
    },

    dismissCloudCreditsNotice(
      request: CloudCreditsNoticeDismissRequest
    ): Promise<CloudCreditsStatus> {
      return fetchJSON<CloudCreditsStatus>(baseUrl, '/cloud/credits/notices/dismiss', {
        method: 'POST',
        body: JSON.stringify(request),
      });
    },

    listHostedCommunities(): Promise<CloudHostedCommunitiesResponse> {
      return fetchJSON<CloudHostedCommunitiesResponse>(baseUrl, '/cloud/communities');
    },

    getCommunityAccountSignIn(): Promise<CloudCommunitySignInResponse> {
      return fetchJSON<CloudCommunitySignInResponse>(baseUrl, '/cloud/communities/sign-in');
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
      return refusalOrAnswer(
        async () =>
          (await api.call('cloud.createCommunities', {
            body: input,
          })) as CloudCommunityStartResponse
      );
    },

    getHostedCommunityClaimLink(communityId: string): Promise<CloudCommunityClaimLinkResponse> {
      return refusalOrAnswer(() =>
        fetchJSON<CloudCommunityClaimLinkResponse>(
          baseUrl,
          `/cloud/communities/${encodeURIComponent(communityId)}/claim-link`,
          { method: 'POST', cache: 'no-store' }
        )
      );
    },

    keepHostedCommunity(
      communityId: string,
      expectedHeldCommunityIds: string[]
    ): Promise<CloudCommunityKeepResponse> {
      return refusalOrAnswer(
        async () =>
          (await api.call('cloud.createCommunitiesKeep', {
            path: { communityId },
            body: { expectedHeldCommunityIds },
          })) as CloudCommunityKeepResponse
      );
    },

    restoreHostedCommunity(communityId: string): Promise<CloudCommunityRestoreResponse> {
      const path = { communityId };
      return refusalOrAnswer(
        async () =>
          (await api.call('cloud.restoreCommunities', { path })) as CloudCommunityRestoreResponse
      );
    },

    checkHostedCommunityMoveRoom(
      bytes: number,
      signal?: AbortSignal
    ): Promise<CloudCommunityMoveRoomResponse> {
      return fetchJSON<CloudCommunityMoveRoomResponse>(
        baseUrl,
        `/cloud/communities/moves/room${buildQueryString({ bytes })}`,
        { signal }
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
      return refusalOrAnswer(() =>
        fetchJSON<CloudCommunityMoveResponse>(
          baseUrl,
          `/cloud/communities/moves/${encodeURIComponent(moveId)}/cancel`,
          { method: 'POST' }
        )
      );
    },

    retryHostedCommunityMoveUpload(moveId: string): Promise<CloudCommunityMoveResponse> {
      const path = { moveId };
      return refusalOrAnswer(
        async () =>
          (await api.call('cloud.uploadCommunitiesMoves', { path })) as CloudCommunityMoveResponse
      );
    },
  };
}
