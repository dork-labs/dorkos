/**
 * The operator's own profile — Transport methods (spec `identity-consistency`
 * §W3.3, §W3.5).
 *
 * Its own module rather than more surface on `team-methods.ts`: the roster is
 * read-only by decision (ADR 260806-222535) and says so in its own doc, so the
 * writes that edit the person reading it belong beside each other somewhere
 * else. The JSON calls go through the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/profile-methods
 */
import type { ProfileAvatarResponse, ProfileUpdateResponse } from '@dorkos/shared/team-schemas';
import { createTransportApiClient } from './api-client';
import { fetchJSON, fetchNoContent } from './http-client';

/** The multipart field the avatar route reads. Wrong name, and the route answers `avatar_missing`. */
const AVATAR_FIELD = 'avatar';

/** Create the profile-write methods bound to a base URL. */
export function createProfileMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    updateProfile(displayName: string): Promise<ProfileUpdateResponse> {
      return api.call('profile.update', { body: { displayName } });
    },

    // Stays hand-written: uploads a multipart body (DOR-5473).
    uploadProfileAvatar(file: Blob, filename: string): Promise<ProfileAvatarResponse> {
      const body = new FormData();
      body.append(AVATAR_FIELD, file, filename);
      // No Content-Type here: `fetchJSON` leaves a FormData body untyped so
      // `fetch` writes `multipart/form-data; boundary=…` itself. Under a JSON
      // header the parser finds no boundary and answers `malformed_request`.
      return fetchJSON<ProfileAvatarResponse>(baseUrl, '/profile/avatar', {
        method: 'POST',
        body,
      });
    },

    /** The route answers 204, so there is no body to read back. */
    async deleteProfileAvatar(): Promise<void> {
      await api.call('profile.deleteAvatar', {});
    },

    // Stays hand-written: the link sends no body; waits for batch 3's no-body client (DOR-5473).
    /** Both directions answer 204; the roster is what the caller re-reads. */
    setIdentityLinkedToMe(memberId: string, linked: boolean): Promise<void> {
      return fetchNoContent(baseUrl, `/profile/identities/${encodeURIComponent(memberId)}`, {
        method: linked ? 'POST' : 'DELETE',
      });
    },
  };
}
