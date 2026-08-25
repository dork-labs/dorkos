'use client';

import { trackHeroDownload, type DownloadPlacement } from '@/lib/analytics';
import { AppleLogo } from './AppleLogo';
import { DOWNLOAD } from './copy';

/**
 * The page's primary call to action: get the Mac app. Downloading the signed
 * app is the shortest path for most people, so the terminal install sits
 * underneath it as the alternative rather than the default.
 *
 * A plain anchor, not `next/link`, for the same reason every other download
 * button on the site is one: `/download/mac` is a route handler that redirects
 * off-site to the release asset, so prefetching it fetches a GitHub URL the
 * browser then refuses on CORS grounds.
 *
 * @param props - Which of the page's two download buttons this is, for the funnel.
 */
export function DownloadMacButton({ placement }: { placement: DownloadPlacement }) {
  return (
    <a
      href="/download/mac"
      onClick={() => trackHeroDownload(placement)}
      className="bg-brand-orange focus-visible:ring-charcoal focus-visible:ring-offset-cream-primary inline-flex items-center gap-2.5 rounded-full px-7 py-3.5 text-base font-semibold text-[#131110] transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:scale-100 sm:text-lg"
    >
      <AppleLogo size={20} />
      {DOWNLOAD.label}
    </a>
  );
}
