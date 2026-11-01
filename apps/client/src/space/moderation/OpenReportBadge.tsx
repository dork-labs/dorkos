import { useCallback, useEffect, useState } from 'react';
import type { CommunityWireReport } from '@dorkos/shared/community-wire';
import { request } from '../api.js';

/** How often a moderator's page looks for new flags while it stays open. */
const REFRESH_MS = 60_000;

/** The largest number the chip spells out, as the app's sidebar counts do. */
const COUNT_CAP = 99;

const CHANGED_EVENT = 'dorkos:space-reports-changed';

/** Tell every count on the page to read the queue again, after a report was resolved. */
export function announceReportsChanged(): void {
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/**
 * How many messages wait for this moderator: read on open, on a timer, when the tab comes back,
 * and when a report here is resolved. A failed read keeps the last count; the queue itself is
 * where a failure is shown.
 *
 * @param enabled - False for anyone who may not read the queue, who then never asks.
 * @returns The open reports this person can resolve, up to one page of them.
 */
export function useOpenReportCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  const read = useCallback(async () => {
    if (document.visibilityState === 'hidden') return;
    try {
      const body = await request<{ reports: CommunityWireReport[] }>('/api/v1/reports?status=open');
      setCount(body.reports.length);
    } catch {
      // Keep the last count.
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const first = setTimeout(() => void read(), 0);
    const timer = setInterval(() => void read(), REFRESH_MS);
    const onVisible = () => void read();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(CHANGED_EVENT, onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(CHANGED_EVENT, onVisible);
    };
  }, [enabled, read]);
  return enabled ? count : 0;
}

/** What a count reads as: exact up to the cap, then `99+`. */
export function openReportLabel(count: number): string {
  return count > COUNT_CAP ? `${COUNT_CAP}+` : String(count);
}

// copy of CountPill: see DOR-3635
/**
 * A count of flagged messages beside what opens them, in the shape and neutral tone of the app's
 * `CountPill`. This page never imports the app's layers, so it draws the chip itself. The fill
 * comes from the text colour, so it reads on a selected button too. Nothing when there are none.
 */
export function OpenReportBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1 inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,currentColor_15%,transparent)] px-1.5 text-center text-[11px] leading-4 font-semibold tabular-nums max-md:h-[22px] max-md:min-w-[22px] max-md:text-[13px]">
      <span aria-hidden="true">{openReportLabel(count)}</span>
      <span className="sr-only">{openReportLabel(count)} flagged</span>
    </span>
  );
}

/** The count of flagged messages for a place only moderators see, reading it for itself. */
export function OpenReportCount() {
  return <OpenReportBadge count={useOpenReportCount(true)} />;
}
