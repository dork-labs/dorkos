/**
 * One app pinned under the Apps door (DOR-3970, spec §2).
 *
 * A bare glyph in muted ink, indented under the door, so it reads as the
 * door's child. One trailing mark at most, in priority order: the held dot,
 * the error glyph, then the app's own count. Pressing it does what its state
 * calls for (`useAppActions`); its "⋮" offers Open in new tab, Unpin and
 * Settings, plus Try again while it is not working.
 *
 * @module features/dashboard-sidebar/ui/apps/PinnedAppRow
 */
import { CircleAlert, ExternalLink, PinOff, RotateCw, Settings } from 'lucide-react';
import { useAppActions, useAppPins, useAppTrying } from '@/layers/entities/extension';
import { cn } from '@/layers/shared/lib';
import { useExtensionRegistry } from '@/layers/shared/model';
import {
  ContributedIcon,
  CORNER_COUNT_CAP,
  CountPill,
  SidebarRow,
  STATUS_TONE_DOT,
  type SidebarMenuNode,
  type SidebarRowMotion,
} from '@/layers/shared/ui';
import type { SidebarRowModel } from '../../model/build-sidebar-model';
import { ROW_GLYPH_CLASS } from '../row-glyph';

/** The indent that makes a pinned app read as the door's child: 24px, 28px on a phone. */
const PINNED_INDENT =
  'pl-[calc(var(--sidebar-row-x)_+_1rem)] max-md:pl-[calc(var(--sidebar-row-x)_+_1.25rem)]';

/** Props for {@link PinnedAppRow}. */
export interface PinnedAppRowProps {
  /** The row; its `app` is set. */
  row: SidebarRowModel;
  /** Whether one of the app's pages is open. */
  isActive: boolean;
  /** The row's motion. */
  rowMotion: SidebarRowMotion;
}

/** The one trailing mark, presentational only (it may be drawn twice). */
function TrailingMark({ row }: { row: SidebarRowModel }) {
  if (row.app?.state === 'held') {
    return <span aria-hidden className={cn('size-1.5 rounded-full', STATUS_TONE_DOT.warning)} />;
  }
  if (row.app?.state === 'error') {
    return <CircleAlert aria-hidden className={cn(ROW_GLYPH_CLASS, 'text-status-error-fg')} />;
  }
  if (row.count !== undefined) {
    // An app's own count is news, not a warning: neutral ink, capped at 9+ (DOR-3077).
    return <CountPill count={row.count} tone="neutral" cap={CORNER_COUNT_CAP} label="" />;
  }
  return null;
}

/**
 * Draw one pinned app.
 *
 * @param props - The row, whether it is open, and its motion.
 */
export function PinnedAppRow({ row, isActive, rowMotion }: PinnedAppRowProps) {
  const app = row.app;
  const actions = useAppActions();
  const { unpin } = useAppPins();
  const trying = useAppTrying(app?.id ?? '');
  const pageId = row.glyph.kind === 'page-icon' ? row.glyph.pageId : null;
  const icon = useExtensionRegistry(
    (state) => state.slots.pages.find((page) => page.id === pageId)?.icon
  );
  if (app === undefined || row.target.kind !== 'add-on') return null;
  const target = { id: app.id, path: row.target.path, state: app.state };

  const menuNodes: SidebarMenuNode[] = [
    ...(app.state === 'error'
      ? [
          {
            kind: 'action' as const,
            id: 'try-again',
            label: 'Try again',
            icon: RotateCw,
            run: () => void actions.tryAgain(app.id),
          },
        ]
      : []),
    {
      kind: 'action',
      id: 'open-new-tab',
      label: 'Open in new tab',
      icon: ExternalLink,
      run: () => actions.openInNewTab(target),
    },
    { kind: 'action', id: 'unpin', label: 'Unpin', icon: PinOff, run: () => unpin(app.id) },
    {
      kind: 'action',
      id: 'settings',
      label: 'Settings',
      icon: Settings,
      guardsFocus: true,
      run: () => actions.openSettings(app.id),
    },
  ];

  return (
    <SidebarRow
      glyph={
        // Hidden: an extension's SVG can carry a `<title>` that would be read
        // into the row's name.
        <span aria-hidden className="text-sidebar-foreground/60 contents">
          <ContributedIcon icon={icon} className={ROW_GLYPH_CLASS} />
        </span>
      }
      title={row.primary}
      titleText={app.accessibleName}
      isActive={isActive}
      emphasized={false}
      muted={false}
      onSelect={() => actions.open(target)}
      rowMotion={rowMotion}
      className={PINNED_INDENT}
      testId={`apps-pinned-${app.id}`}
      trailing={
        <>
          <TrailingMark row={row} />
          <span className="sr-only">
            {trying ? ', trying again' : app.accessibleName.slice(row.primary.length)}
          </span>
        </>
      }
      menuNodes={menuNodes}
      actionsLabel={`${row.primary} actions`}
    />
  );
}
