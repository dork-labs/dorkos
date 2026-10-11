import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { AppTab } from '@/layers/shared/model';
import type { RovingTabProps, TabActivationSource } from '@/layers/shared/ui';
import { tabAccessibleName, tabLabel, type TabIdentity } from '../lib/tab-identity';
import { useSharesAgentWithAnotherTab } from '../model/tab-agent-registry';
import { useTabIdentity } from '../model/use-tab-identity';
import { TabHoverCard } from './TabHoverCard';
import { TabIdentityIcon } from './TabIdentityIcon';
import { TabStatusMark } from './TabStatusMark';

/** DOM id of the routed content region the active tab controls. */
export const APP_TAB_PANEL_ID = 'app-tab-panel';

interface AppTabItemViewProps {
  /** The page the tab points at. */
  identity: TabIdentity;
  /** Whether this is the tab currently on screen. It gets more room. */
  isActive: boolean;
  /** Whether a close control should be offered (false for the last tab). */
  canClose: boolean;
  /**
   * Whether another open chat tab is with the same agent: the agent collapses
   * to its emoji and the chat title leads, so the two can be told apart.
   */
  collapseAgent?: boolean;
  /** A pinned tab shrinks to its icon and status mark. */
  pinned?: boolean;
  /** Roving-tablist props for this tab, from the strip's `getTabProps`. */
  tabProps?: RovingTabProps;
  /** Close this tab. */
  onClose?: (source: TabActivationSource) => void;
}

/**
 * One tab, drawn from its identity: icon, name · what follows it, and at most
 * one status mark. Presentational, so the Dev Playground lays out every route
 * and status with the real component. {@link AppTabItem} is the wired one.
 *
 * The accessible name is the identity's, name then status sentence ("Scout,
 * Fix the login bug, Needs you: Waiting for your answer"), led by what the
 * tab visibly leads with: a collapsed or truncated label still announces in
 * full, and the dot's colour is never the only signal.
 */
export function AppTabItemView({
  identity,
  isActive,
  canClose,
  collapseAgent = false,
  pinned = false,
  tabProps,
  onClose,
}: AppTabItemViewProps) {
  const label = tabLabel(identity, { collapseAgent });

  // Keep the tab you switched to on screen once the strip overflows. Arrow-key
  // traversal gets this free from the browser (it moves focus), but Cmd+9 and
  // the close-and-fall-through cases only change state — without this they can
  // leave you looking at a strip that shows every tab except the live one.
  // Optional-called: jsdom has no `scrollIntoView`.
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isActive) wrapper.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [isActive]);

  const showClose = canClose && !pinned;

  return (
    // role="presentation" wrapper: ARIA wants tabs as direct tablist children,
    // so this exists only to anchor the close control as a SIBLING of the tab
    // (a button inside a button is invalid HTML) — the same shape TerminalTabs
    // and VS Code use.
    <div ref={wrapper} role="presentation" className="group relative flex shrink-0">
      <TabHoverCard identity={identity}>
        <button
          type="button"
          role="tab"
          aria-selected={isActive}
          aria-controls={isActive ? APP_TAB_PANEL_ID : undefined}
          aria-label={tabAccessibleName(identity, { collapseAgent })}
          {...tabProps}
          className={cn(
            'focus-ring flex min-w-0 items-center gap-1.5 rounded-md py-1 text-xs transition-colors',
            // The tab on screen gets more room, so its name is the one cut last.
            pinned ? 'px-2' : isActive ? 'max-w-72 pl-2' : 'max-w-52 pl-2',
            !pinned && (showClose ? 'pr-7' : 'pr-2'),
            isActive
              ? 'bg-background text-foreground shadow-soft'
              : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
          )}
        >
          <TabIdentityIcon icon={identity.icon} />
          {!pinned && (
            <span className="min-w-0 truncate">
              <span className="font-medium">{label.lead}</span>
              {label.trail && <span className="opacity-70"> · {label.trail}</span>}
            </span>
          )}
          <TabStatusMark identity={identity} />
        </button>
      </TabHoverCard>
      {showClose && onClose && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onClose('pointer')}
          aria-label={`Close ${identity.primary}`}
          className={cn(
            'focus-ring hover:bg-muted absolute top-1/2 right-1 -translate-y-1/2 rounded-sm p-0.5',
            'opacity-0 transition-opacity group-hover:opacity-70 hover:opacity-100',
            // Touch and keyboard have no hover to reveal it, so the active tab
            // always shows its close control.
            isActive && 'opacity-70'
          )}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

interface AppTabItemProps {
  /** The tab to render. */
  tab: AppTab;
  /** Whether this is the tab currently on screen. */
  isActive: boolean;
  /** Whether a close control should be offered (false for the last tab). */
  canClose: boolean;
  /** A pinned tab shrinks to its icon and status mark. Defaults to `tab.pinned`. */
  pinned?: boolean;
  /** Roving-tablist props for this tab, from the strip's `getTabProps`. */
  tabProps: RovingTabProps;
  /** Close this tab. */
  onClose: (id: string, source: TabActivationSource) => void;
}

/**
 * One tab in the window's tab strip, named from its href through
 * {@link useTabIdentity}: the same hook the History menu and the window title
 * read, so the three cannot disagree. A tab in the background still lights up
 * when its agent starts working or needs an answer: the identity reads the
 * global session-list stream, not only the active tab's session stream.
 */
export function AppTabItem({
  tab,
  isActive,
  canClose,
  pinned,
  tabProps,
  onClose,
}: AppTabItemProps) {
  const identity = useTabIdentity(tab.href);
  const collapseAgent = useSharesAgentWithAnotherTab(identity.agentKey);
  return (
    <AppTabItemView
      identity={identity}
      isActive={isActive}
      canClose={canClose}
      collapseAgent={collapseAgent}
      pinned={pinned ?? tab.pinned ?? false}
      tabProps={tabProps}
      onClose={(source) => onClose(tab.id, source)}
    />
  );
}
