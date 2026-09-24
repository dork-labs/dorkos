import { useEffect, useState } from 'react';
import {
  CommunityWireHostLinksSchema,
  parseCommunityReportMailto,
  type CommunityWireHostLinks,
} from '@dorkos/shared/community-wire';
import { hostRequest } from './api.js';

const NO_LINKS: CommunityWireHostLinks = { termsUrl: null, privacyUrl: null, reportAbuseUrl: null };

// One read per page load: every message card asks, and the answer only changes on a redeploy.
let cached: Promise<CommunityWireHostLinks> | null = null;

function loadHostLinks(): Promise<CommunityWireHostLinks> {
  cached ??= hostRequest<unknown>('/api/v1/host-links').then(
    // An answer outside the contract (a proxy's page, a non-HTTPS link) shows no links at all.
    (body) => {
      const parsed = CommunityWireHostLinksSchema.safeParse(body);
      return parsed.success ? parsed.data : NO_LINKS;
    },
    () => {
      // Links are optional; a failed read shows none and lets the next page view try again.
      cached = null;
      return NO_LINKS;
    }
  );
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
 * The host's own query is kept byte for byte, minus any `community` or `entry` it already had.
 * Returns `null`, never throws, for a target that is not a valid report address, so a bad value
 * hides the link instead of breaking the page.
 */
export function reportAbuseHref(
  target: string,
  communityId: string,
  entryId?: string
): string | null {
  const ids = [['community', communityId], ...(entryId ? [['entry', entryId]] : [])] as const;
  const mailbox = parseCommunityReportMailto(target);
  if (mailbox) {
    const body = ids.map(([key, id]) => `${key === 'entry' ? 'Message' : 'Community'}: ${id}`);
    return `${mailbox}?body=${encodeURIComponent(body.join('\n'))}`;
  }
  try {
    if (new URL(target).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  const hashAt = target.indexOf('#');
  const hash = hashAt === -1 ? '' : target.slice(hashAt);
  const withoutHash = hashAt === -1 ? target : target.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  const path = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const kept = (queryAt === -1 ? '' : withoutHash.slice(queryAt + 1))
    .split('&')
    .filter((pair) => pair && !/^(?:community|entry)(?:=|$)/u.test(pair));
  const ours = ids.map(([key, id]) => `${key}=${encodeURIComponent(id)}`);
  return `${path}?${[...kept, ...ours].join('&')}${hash}`;
}
