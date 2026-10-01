import { ExternalLink, TriangleAlert } from 'lucide-react';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  communityPageUrl,
  openOwnerNotice,
  ownerNoticeBanner,
  type OwnerNoticeDateFormat,
} from '@/layers/entities/community';
import { openExternalLink } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';

/** Props for {@link CommunityOwnerNoticeBanner}. */
export interface CommunityOwnerNoticeBannerProps {
  /** The connection the page is on. */
  connection: CommunityConnectionDescriptor;
  /** Locale and zone for dates; the viewer's own by default. Pinned by tests and the playground. */
  dateFormat?: OwnerNoticeDateFormat;
}

/**
 * The owner's warning, at the top of a community's page, that someone asked the host to make
 * someone else the owner (DOR-2543).
 *
 * Only the owner's own connection carries a notice, so nobody else ever sees it. It says when
 * the change could happen and only what this owner can do about it, and its one button opens
 * the community in the browser, where the owner keeps ownership with a single press. It stays
 * for as long as the request is open, and goes when the owner keeps ownership or the request
 * ends.
 */
export function CommunityOwnerNoticeBanner({
  connection,
  dateFormat,
}: CommunityOwnerNoticeBannerProps) {
  const notice = openOwnerNotice(connection);
  if (!notice) return null;
  const [headline, ...rest] = ownerNoticeBanner(
    notice,
    connection.access?.lastKnown?.lifecycle,
    dateFormat
  );
  return (
    <section
      aria-label="Request to take over this space"
      className="border-status-warning-border bg-status-warning-bg text-status-warning-fg flex flex-wrap items-start gap-x-3 gap-y-2 border-b px-4 py-3 text-sm"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 basis-60 space-y-1">
        <p className="text-foreground font-medium">{headline}</p>
        {rest.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => openExternalLink(communityPageUrl(connection))}
      >
        Open space
        <ExternalLink className="size-3.5" aria-hidden />
      </Button>
    </section>
  );
}
