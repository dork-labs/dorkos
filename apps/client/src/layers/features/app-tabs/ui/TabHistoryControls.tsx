import type { ReactElement } from 'react';
import { ArrowLeft, ArrowRight, Check, History } from 'lucide-react';
import { useRouter } from '@tanstack/react-router';
import { cn, formatShortcutKey, isDesktopShell, isMac, SHORTCUTS } from '@/layers/shared/lib';
import { useActiveTabHistory } from '@/layers/shared/model';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/layers/shared/ui';
import { goBack, goForward, goToHistoryEntry } from '../model/tab-history';
import { useTabTarget } from '../model/use-tab-target';
import { TabTargetIcon } from './TabTargetIcon';

/**
 * The tooltip's key hint. Off a Mac, Alt+Arrow works too and is the one many
 * people reach for, so it is named beside the registry chord.
 *
 * @param chord - The registry chord (`mod+[` or `mod+]`).
 * @param arrow - The matching arrow glyph.
 */
function keyHint(chord: string, arrow: string): string {
  const primary = formatShortcutKey(chord);
  return isMac ? primary : `${primary} or ${formatShortcutKey(`alt+${arrow}`)}`;
}

/** Matches `SidebarTrigger`, which sits immediately to the left. */
const BUTTON_CLASS = 'size-7';

interface HistoryRowProps {
  /** The page this row names. */
  href: string;
  /** Whether this is the page the tab is on now. */
  isCurrent: boolean;
  /** Take the tab here. Not called for the current row. */
  onSelect: () => void;
}

/**
 * One page in the History menu, named exactly as a tab on that page would be.
 * Its own component so each row can call {@link useTabTarget}.
 */
function HistoryRow({ href, isCurrent, onSelect }: HistoryRowProps) {
  const view = useTabTarget(href);
  return (
    <DropdownMenuItem
      // The page you are on is shown, checked, and not a destination. Disabled
      // for that, but kept at full strength: it is the "you are here" mark.
      disabled={isCurrent}
      aria-current={isCurrent ? 'page' : undefined}
      onSelect={onSelect}
      className="data-[disabled]:opacity-100"
    >
      <TabTargetIcon view={view} />
      <span className="min-w-0 flex-1 truncate">{view.label}</span>
      <Check className={cn('size-3.5 shrink-0', !isCurrent && 'invisible')} />
    </DropdownMenuItem>
  );
}

interface WithTooltipProps {
  /** Accessible name and tooltip text. */
  label: string;
  /** Key hint shown in the tooltip, if any. */
  keys?: string;
  /** The button itself (a `Button`), wrapped in the tooltip. */
  children: ReactElement;
}

/** A tooltip carrying the label and, when there is one, the key. */
function WithTooltip({ label, keys, children }: WithTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {keys ? `${label} (${keys})` : label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Back, Forward and History for the active tab (DOR-2107), at the left of the
 * header row.
 *
 * **Desktop app only.** In a browser the page's history is the browser's, and
 * its own Back button and History already do this job — so this renders
 * nothing there.
 *
 * Back and Forward are disabled, never hidden, when there is nowhere to go, so
 * the header does not shift as you move. The History menu stays enabled even
 * with one page: it shows that page, checked, rather than becoming a control
 * that flickers on and off with every new tab.
 */
export function TabHistoryControls() {
  const router = useRouter();
  const { entries, cursor, canGoBack, canGoForward } = useActiveTabHistory();

  if (!isDesktopShell()) return null;

  // Newest first, as every browser's History lists it, each row keeping its
  // real index so a jump lands on the right entry.
  const rows = entries.map((href, index) => ({ href, index })).reverse();

  return (
    <div className="flex items-center">
      <WithTooltip label="Back" keys={keyHint(SHORTCUTS.HISTORY_BACK.key, '←')}>
        <Button
          variant="ghost"
          size="icon-md"
          className={BUTTON_CLASS}
          aria-label="Back"
          disabled={!canGoBack}
          onClick={() => goBack(router)}
        >
          <ArrowLeft />
        </Button>
      </WithTooltip>
      <WithTooltip label="Forward" keys={keyHint(SHORTCUTS.HISTORY_FORWARD.key, '→')}>
        <Button
          variant="ghost"
          size="icon-md"
          className={BUTTON_CLASS}
          aria-label="Forward"
          disabled={!canGoForward}
          onClick={() => goForward(router)}
        >
          <ArrowRight />
        </Button>
      </WithTooltip>
      <DropdownMenu>
        <WithTooltip label="History">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-md" className={BUTTON_CLASS} aria-label="History">
              <History />
            </Button>
          </DropdownMenuTrigger>
        </WithTooltip>
        <DropdownMenuContent align="start" className="max-w-72 min-w-48">
          {rows.map(({ href, index }) => (
            <HistoryRow
              key={index}
              href={href}
              isCurrent={index === cursor}
              onSelect={() => goToHistoryEntry(router, index)}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
