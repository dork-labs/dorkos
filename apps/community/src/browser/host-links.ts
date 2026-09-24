import { useEffect, useState } from 'react';
import type { CommunityWireHostLinks } from '@dorkos/shared/community-wire';
import { hostRequest } from './api.js';

const NO_LINKS: CommunityWireHostLinks = { termsUrl: null, privacyUrl: null, reportAbuseUrl: null };

// One read per page load: every message card asks, and the answer only changes on a redeploy.
let cached: Promise<CommunityWireHostLinks> | null = null;

function loadHostLinks(): Promise<CommunityWireHostLinks> {
  cached ??= hostRequest<CommunityWireHostLinks>('/api/v1/host-links').catch(() => {
    // Links are optional; a failed read shows none and lets the next page view try again.
    cached = null;
    return NO_LINKS;
  });
  return cached;
}

/** The host's terms, privacy and report links; all `null` until loaded or when unset. */
export function useHostLinks(): CommunityWireHostLinks {
  const [links, setLinks] = useState(NO_LINKS);
  useEffect(() => {
    let active = true;
    void loadHostLinks().then((loaded) => {
      if (active) setLinks(loaded);
    });
    return () => {
      active = false;
    };
  }, []);
  return links;
}

/**
 * Build the address a Report link opens: the host's report target plus the community ID and,
 * when a message is being reported, its entry ID. Nothing else is added — no message text, name
 * or handle — so the host looks the report up itself. A `mailto:` target gets the IDs in the body.
 */
export function reportAbuseHref(target: string, communityId: string, entryId?: string): string {
  const url = new URL(target);
  if (url.protocol === 'mailto:') {
    const lines = [`Community: ${communityId}`, ...(entryId ? [`Message: ${entryId}`] : [])];
    return `${url.href}?body=${encodeURIComponent(lines.join('\n'))}`;
  }
  url.searchParams.set('community', communityId);
  if (entryId) url.searchParams.set('entry', entryId);
  else url.searchParams.delete('entry');
  return url.href;
}
