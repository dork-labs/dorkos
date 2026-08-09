import { useEffect, useMemo, useRef } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import type { AppTab } from '@/layers/shared/model';
import {
  statusDotClass,
  type RovingTabProps,
  type StatusSignal,
  type TabActivationSource,
} from '@/layers/shared/ui';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import { useSessionBorderState, type SessionBorderKind } from '@/layers/entities/session';
import { fallbackTabLabel, parseTabHref, ROUTE_ICONS } from '../lib/tab-target';

/** DOM id of the routed content region the active tab controls. */
export const APP_TAB_PANEL_ID = 'app-tab-panel';

/**
 * Dot signal per live state. Idle is absent on purpose — a tab that needs
 * nothing from you shows nothing, so the dots that do appear mean something.
 *
 * The colours and the motion both come from the shared token map, so this strip
 * cannot drift from the sidebar row saying the same thing one pane away. Waiting
 * for approval no longer pulses: motion is what says "right now", and a tab
 * blocked on you is not going anywhere until you answer it.
 */
const DOT_SIGNAL: Partial<Record<SessionBorderKind, StatusSignal>> = {
  streaming: 'working',
  pendingApproval: 'needs-you',
  error: 'error',
  unseen: 'unseen',
};

interface AppTabItemProps {
  /** The tab to render. */
  tab: AppTab;
  /** Whether this is the tab currently on screen. */
  isActive: boolean;
  /** Whether a close control should be offered (false for the last tab). */
  canClose: boolean;
  /** Roving-tablist props for this tab, from the strip's `getTabProps`. */
  tabProps: RovingTabProps;
  /** Close this tab. */
  onClose: (id: string, source: TabActivationSource) => void;
}

/**
 * One tab in the window's tab strip.
 *
 * Derives everything it shows from the tab's href: the route's name, or — for a
 * chat tab — the agent that lives in that project, with its emoji and a live
 * status dot. The dot reads {@link useSessionBorderState}, which merges the
 * global session-list stream in, so a tab in the background still lights up when
 * its agent starts working or needs an answer, even though only the active tab
 * holds a session stream.
 */
export function AppTabItem({ tab, isActive, canClose, tabProps, onClose }: AppTabItemProps) {
  const target = useMemo(() => parseTabHref(tab.href), [tab.href]);
  const isSession = target.pathname === '/session';

  const { data: agent } = useCurrentAgent(isSession ? target.dir : null);
  const visual = useAgentVisual(agent ?? null, target.dir ?? '');
  const status = useSessionBorderState(target.sessionId ?? '');

  const label = agent ? getAgentDisplayName(agent) : fallbackTabLabel(target);
  const Icon = ROUTE_ICONS[target.pathname] ?? MessageSquare;
  const signal = isSession ? DOT_SIGNAL[status.kind] : undefined;

  // Keep the tab you switched to on screen once the strip overflows. Arrow-key
  // traversal gets this free from the browser (it moves focus), but Cmd+9 and
  // the close-and-fall-through cases only change state — without this they can
  // leave you looking at a strip that shows every tab except the live one.
  // Optional-called: jsdom has no `scrollIntoView`.
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isActive) wrapper.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [isActive]);

  return (
    // role="presentation" wrapper: ARIA wants tabs as direct tablist children,
    // so this exists only to anchor the close control as a SIBLING of the tab
    // (a button inside a button is invalid HTML) — the same shape TerminalTabs
    // and VS Code use.
    <div ref={wrapper} role="presentation" className="group relative flex shrink-0">
      <button
        type="button"
        role="tab"
        aria-selected={isActive}
        aria-controls={isActive ? APP_TAB_PANEL_ID : undefined}
        {...tabProps}
        className={cn(
          'focus-ring flex max-w-48 min-w-0 items-center gap-1.5 rounded-md py-1 pl-2 text-xs transition-colors',
          canClose ? 'pr-7' : 'pr-2',
          isActive
            ? 'bg-background text-foreground shadow-soft'
            : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
        )}
      >
        {agent ? (
          <span aria-hidden="true" className="shrink-0 text-sm leading-none">
            {visual.emoji}
          </span>
        ) : (
          <Icon className="size-3.5 shrink-0" />
        )}
        <span className="truncate font-medium">{label}</span>
        {signal && (
          <>
            <span
              aria-hidden="true"
              className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(signal))}
            />
            {/* Folded into the tab's accessible name ("api, Working") rather
                than announced as a live region — a strip of live regions would
                talk over whatever the operator is actually reading. */}
            <span className="sr-only">, {status.label}</span>
          </>
        )}
      </button>
      {canClose && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onClose(tab.id, 'pointer')}
          aria-label={`Close ${label}`}
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
