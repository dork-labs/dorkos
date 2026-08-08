/**
 * The operator's own profile — Transport methods (spec `identity-consistency`
 * §W3.3, §W3.5).
 *
 * Its own module rather than more surface on `team-methods.ts`: the roster is
 * read-only by decision (ADR 260806-222535) and says so in its own doc, so the
 * writes that edit the person reading it belong beside each other somewhere
 * else.
 *
 * @module shared/lib/transport/profile-methods
 */
import type { ProfileAvatarResponse, ProfileUpdateResponse } from '@dorkos/shared/team-schemas';
import { fetchJSON, fetchNoContent } from './http-client';

/** The multipart field the avatar route reads. Wrong name, and the route answers `AVATAR_MISSING`. */
const AVATAR_FIELD = 'avatar';

/** Create the profile-write methods bound to a base URL. */
export function createProfileMethods(baseUrl: string) {
  return {
    updateProfile(displayName: string): Promise<ProfileUpdateResponse> {
      return fetchJSON<ProfileUpdateResponse>(baseUrl, '/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName }),
      });
    },

    uploadProfileAvatar(file: Blob, filename: string): Promise<ProfileAvatarResponse> {
      const body = new FormData();
      body.append(AVATAR_FIELD, file, filename);
      // `headers: {}` is load-bearing, not tidiness: `fetchJSON` defaults to
      // `Content-Type: application/json`, and a multipart body sent under that
      // header has no boundary for the parser to find, so the route sees no
      // file and answers `AVATAR_MISSING`. Clearing it lets `fetch` write the
      // `multipart/form-data; boundary=…` header itself.
      return fetchJSON<ProfileAvatarResponse>(baseUrl, '/profile/avatar', {
        method: 'POST',
        headers: {},
        body,
      });
    },

    /** The route answers 204, so there is no body to read back. */
    deleteProfileAvatar(): Promise<void> {
      return fetchNoContent(baseUrl, '/profile/avatar', { method: 'DELETE' });
    },
  };
}
