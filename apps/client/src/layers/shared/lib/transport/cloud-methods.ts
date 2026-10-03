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
import { buildQueryString, fetchJSON } from './http-client';
import { startHostedCommunityMoveOverHttp } from './community-move-methods';

/**
 * Answer a write whose reply is an `ok` envelope, handing back the owner bar's
 * refusal instead of throwing it.
 *
 * Every DorkOS account write is for the owner of this DorkOS, and the
 * server answers anyone else with a 403 carrying one sentence
 * (`{ ok: false, code, message }`). `fetchJSON` throws on every non-2xx, so
 * without this the sentence would be lost and the surface would say the
 * account could not be reached. Anything that is not such a refusal still
 * throws.
 *
 * @param send - The write, as a `fetchJSON` call.
 */
async function refusalOrAnswer<T>(
  send: () => Promise<T>
): Promise<T | { ok: false; message: string }> {
  try {
    return await send();
  } catch (err) {
    const body = (err as { body?: unknown }).body as
      { ok?: unknown; message?: unknown } | undefined;
    if (body?.ok === false && typeof body.message === 'string') {
      return { ok: false, message: body.message };
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
  return {
    startCloudLink(): Promise<StartLinkResult> {
      return fetchJSON<StartLinkResult>(baseUrl, '/cloud/link/start', { method: 'POST' });
    },

    getCloudLinkStatus(): Promise<CloudLinkStatus> {
      return fetchJSON<CloudLinkStatus>(baseUrl, '/cloud/link/status');
    },

    cancelCloudLink(): Promise<CloudLinkStatus> {
      return fetchJSON<CloudLinkStatus>(baseUrl, '/cloud/link/cancel', { method: 'POST' });
    },

    unlinkCloud(): Promise<{ ok: boolean }> {
      return fetchJSON<{ ok: boolean }>(baseUrl, '/cloud/unlink', { method: 'POST' });
    },

    getCloudStatus(): Promise<CloudLinkSummary> {
      return fetchJSON<CloudLinkSummary>(baseUrl, '/cloud/status');
    },

    checkCloudLink(): Promise<CloudLinkSummary> {
      return fetchJSON<CloudLinkSummary>(baseUrl, '/cloud/link/check', { method: 'POST' });
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
      return refusalOrAnswer(() =>
        fetchJSON<CloudSeatActionResponse>(
          baseUrl,
          `/cloud/seats/${encodeURIComponent(seatId)}/assign`,
          { method: 'POST', body: JSON.stringify({ subject }) }
        )
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

    getCloudOffers(): Promise<CloudOffersResponse> {
      return fetchJSON<CloudOffersResponse>(baseUrl, '/cloud/offers');
    },

    createCloudBillingSession(
      page: CloudBillingPage,
      skuId?: string
    ): Promise<CloudBillingSessionResponse> {
      return refusalOrAnswer(() =>
        fetchJSON<CloudBillingSessionResponse>(
          baseUrl,
          `/cloud/billing/${encodeURIComponent(page)}`,
          { method: 'POST', body: JSON.stringify(skuId === undefined ? {} : { skuId }) }
        )
      );
    },

    requestCloudAccountExport(): Promise<CloudAccountExportResponse> {
      return refusalOrAnswer(() =>
        fetchJSON<CloudAccountExportResponse>(baseUrl, '/cloud/account/export', {
          method: 'POST',
        })
      );
    },

    requestCloudAccountDeletion(): Promise<CloudAccountDeletionResponse> {
      return refusalOrAnswer(() =>
        fetchJSON<CloudAccountDeletionResponse>(baseUrl, '/cloud/account/deletion', {
          method: 'POST',
        })
      );
    },

    getCloudCredits(): Promise<CloudCreditsStatus> {
      return fetchJSON<CloudCreditsStatus>(baseUrl, '/cloud/credits');
    },

    setCloudCreditsDefault(runtime: string, useCredits: boolean): Promise<CloudCreditsStatus> {
      return fetchJSON<CloudCreditsStatus>(baseUrl, '/cloud/credits/default', {
        method: 'PUT',
        body: JSON.stringify({ runtime, useCredits }),
      });
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
      return refusalOrAnswer(() =>
        fetchJSON<CloudCommunityStartResponse>(baseUrl, '/cloud/communities', {
          method: 'POST',
          body: JSON.stringify(input),
        })
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
      return refusalOrAnswer(() =>
        fetchJSON<CloudCommunityKeepResponse>(
          baseUrl,
          `/cloud/communities/${encodeURIComponent(communityId)}/keep`,
          { method: 'POST', body: JSON.stringify({ expectedHeldCommunityIds }) }
        )
      );
    },

    restoreHostedCommunity(communityId: string): Promise<CloudCommunityRestoreResponse> {
      return refusalOrAnswer(() =>
        fetchJSON<CloudCommunityRestoreResponse>(
          baseUrl,
          `/cloud/communities/${encodeURIComponent(communityId)}/restore`,
          { method: 'POST' }
        )
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
      return refusalOrAnswer(() =>
        fetchJSON<CloudCommunityMoveResponse>(
          baseUrl,
          `/cloud/communities/moves/${encodeURIComponent(moveId)}/upload`,
          { method: 'POST' }
        )
      );
    },
  };
}
