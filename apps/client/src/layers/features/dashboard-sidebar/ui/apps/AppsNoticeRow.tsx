/**
 * What stands under the Apps door while its pins cannot be shown (DOR-3970,
 * spec §7): skeleton bars on the first read, or one quiet "Couldn't load apps"
 * row with Try again.
 *
 * No orange on the failure: nothing of the person's is waiting.
 *
 * @module features/dashboard-sidebar/ui/apps/AppsNoticeRow
 */
import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { useRetryApps } from '@/layers/entities/extension';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  SIDEBAR_GLYPH_GAP,
  SIDEBAR_GLYPH_SLOT,
  SIDEBAR_ROW_INSET,
  Skeleton,
} from '@/layers/shared/ui';
import type { SidebarAppsNotice } from '../../model/build-sidebar-model';
import { ROW_GLYPH_CLASS } from '../row-glyph';

/** Props for {@link AppsNoticeRow}. */
export interface AppsNoticeRowProps {
  /** What to stand in for the pins. */
  notice: SidebarAppsNotice;
}

/**
 * Draw the stand-in for the pins.
 *
 * @param props - The notice.
 */
export function AppsNoticeRow({ notice }: AppsNoticeRowProps) {
  if (notice.kind === 'loading') {
    return (
      <li aria-hidden className="flex flex-col gap-1 py-1" data-slot="apps-pins-loading">
        {Array.from({ length: notice.rows }, (_, index) => (
          <Skeleton key={index} className="ml-[calc(var(--sidebar-row-x)_+_1rem)] h-5 w-28" />
        ))}
      </li>
    );
  }
  return <AppsLoadFailedRow />;
}

/** "Couldn't load apps", with a Try again that reads "Trying…" while it runs. */
function AppsLoadFailedRow() {
  const retry = useRetryApps();
  const [trying, setTrying] = useState(false);
  const onRetry = () => {
    setTrying(true);
    void retry().finally(() => setTrying(false));
  };
  return (
    <li
      role="status"
      data-slot="apps-load-failed"
      className={cn(
        'text-sidebar-foreground/70 text-control flex min-h-7 items-center rounded-md py-1 max-md:min-h-11',
        SIDEBAR_ROW_INSET
      )}
    >
      <span className={cn('flex shrink-0 items-center', SIDEBAR_GLYPH_SLOT)}>
        <CircleAlert aria-hidden className={ROW_GLYPH_CLASS} />
      </span>
      <span className={cn('min-w-0 flex-1 truncate', SIDEBAR_GLYPH_GAP)}>Couldn’t load apps</span>
      <Button
        variant="ghost"
        size="xs"
        onClick={onRetry}
        disabled={trying}
        className="text-sidebar-foreground hover:bg-sidebar-accent/70 ml-2 shrink-0 max-md:min-h-11"
      >
        {trying ? 'Trying…' : 'Try again'}
      </Button>
    </li>
  );
}
