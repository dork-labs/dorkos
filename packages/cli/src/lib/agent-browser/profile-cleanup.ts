/**
 * Removing a forgotten site from the agent browser's profile itself.
 *
 * `dorkos browser forget` edits the saved session file first, which is what
 * takes the site away from agents. But the profile is where the file comes
 * from: without this step the next `dorkos browser login` would read the same
 * cookies back out of Chrome and quietly undo the forget.
 *
 * Runs against a background (headless) Chrome on the profile. Extensions and
 * other settings are untouched; only cookies and the site's page storage go.
 *
 * @module lib/agent-browser/profile-cleanup
 */
import { hostBelongsToSite } from '@dorkos/shared/agent-browser';
import type { CdpPipe } from './cdp-pipe.js';
import type { CdpCookie } from './storage-state.js';

/** The kinds of page data cleared for a forgotten origin (cookies are removed separately). */
const PAGE_DATA_TYPES = 'local_storage,indexeddb,cache_storage,service_workers,file_systems';

/** What to remove: one site (and its subdomains), or everything. */
export type ForgetTarget = { site: string } | 'all';

/** How much {@link forgetInProfile} removed. */
export interface ProfileCleanupResult {
  cookies: number;
  origins: number;
}

/**
 * Delete a site's cookies and page data from the profile Chrome has open.
 *
 * @param cdp - A background Chrome on the agent browser's profile.
 * @param target - The site to remove, or `'all'`.
 * @param knownOrigins - Origins the saved session had page storage for; each
 *   one that belongs to the target is cleared too, beside the site's own
 *   `https://` and `http://` origins.
 */
export async function forgetInProfile(
  cdp: CdpPipe,
  target: ForgetTarget,
  knownOrigins: readonly string[]
): Promise<ProfileCleanupResult> {
  const { cookies } = await cdp.send<{ cookies: CdpCookie[] }>('Storage.getCookies');
  let removedCookies = 0;

  if (target === 'all') {
    await cdp.send('Storage.clearCookies');
    removedCookies = cookies.length;
  } else {
    const matching = cookies.filter((c) => hostBelongsToSite(c.domain, target.site));
    if (matching.length > 0) {
      // `Network.deleteCookies` lives on a page, not the browser, so borrow one.
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
      });
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      try {
        for (const cookie of matching) {
          await cdp.send(
            'Network.deleteCookies',
            {
              name: cookie.name,
              domain: cookie.domain,
              path: cookie.path,
              ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
            },
            sessionId
          );
          removedCookies += 1;
        }
      } finally {
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      }
    }
  }

  const origins = new Set(
    knownOrigins.filter((origin) => {
      if (target === 'all') return true;
      try {
        return hostBelongsToSite(new URL(origin).hostname, target.site);
      } catch {
        return false;
      }
    })
  );
  if (target !== 'all') {
    origins.add(`https://${target.site}`);
    origins.add(`http://${target.site}`);
  }
  for (const origin of origins) {
    await cdp
      .send('Storage.clearDataForOrigin', { origin, storageTypes: PAGE_DATA_TYPES })
      .catch(() => {});
  }
  return { cookies: removedCookies, origins: origins.size };
}
