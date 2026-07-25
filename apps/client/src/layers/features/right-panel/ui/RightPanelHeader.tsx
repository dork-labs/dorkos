import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { X, Puzzle } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  useRovingTabList,
  type RovingTabProps,
} from '@/layers/shared/ui';
import { useAppStore, type RightPanelContribution } from '@/layers/shared/model';

/** DOM id of the right-panel content region the active tab controls. */
export const RIGHT_PANEL_PANEL_ID = 'right-panel-content';

/** Stable DOM id for a right-panel contribution's tab — links panel `aria-labelledby` to it. */
export function rightPanelTabDomId(contributionId: string): string {
  return `right-panel-tab-${contributionId}`;
}

/**
 * Whether React can render `raw` as a component.
 *
 * A bare `typeof raw === 'function'` is too narrow: every `lucide-react` icon is
 * a `forwardRef` result, which is an OBJECT. React renders it happily, but the
 * function-only check rejected it — so all six built-in tabs fell back to the
 * puzzle-piece and became visually indistinguishable from each other. Accept a
 * function or a React element type (identified by its `$$typeof` symbol), which
 * still rejects the garbage the guard exists for: a string, a number, a plain
 * object.
 *
 * @param raw - The registered `icon` value, from typed or untyped code.
 */
function isRenderableIcon(raw: unknown): raw is NonNullable<RightPanelContribution['icon']> {
  if (typeof raw === 'function') return true;
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as { $$typeof?: unknown }).$$typeof === 'symbol'
  );
}

/**
 * Render a contribution's tab icon, guarding a garbage value.
 *
 * Extension-contributed tabs register no icon (the registry API allows one but
 * doesn't require it), and an untyped JS extension can pass a non-component (e.g.
 * `icon: 'foo'`) that a nullish `?? Puzzle` would wave through to render
 * `<'foo' />` and kill the whole header — which lives OUTSIDE PanelErrorBoundary.
 * So require something renderable, else fall back to the puzzle-piece. Shared by
 * the tab strip and the single-tab title so both are equally hardened.
 *
 * @param props - The raw `icon` value and an optional className.
 */
function TabIcon({ raw, className }: { raw: RightPanelContribution['icon']; className?: string }) {
  const Icon = isRenderableIcon(raw) ? raw : Puzzle;
  return <Icon className={className} />;
}

interface RightPanelHeaderProps {
  /**
   * The visible panel contributions, in tab order. The tab strip renders one
   * button per entry when there are 2+; the container is the single source of
   * truth for which contributions are visible (route + transport filtering).
   */
  contributions: RightPanelContribution[];
  /** Optional actions rendered to the left of the close button (the active tab's `headerActions`). */
  actions?: ReactNode;
}

/**
 * Shared header bar for the right panel.
 *
 * Rendered exactly once by {@link RightPanelContainer}, above the active
 * panel's content, so the tab strip and close button are structurally
 * guaranteed — a panel contribution can never omit or break them. Shows a
 * segmented tab control when 2+ contributions are visible; with exactly one it
 * names that single panel (icon + title) instead of leaving the header a blank
 * bar, and renders the active tab's `headerActions` beside the close button.
 */
export function RightPanelHeader({ contributions, actions }: RightPanelHeaderProps) {
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const activeTab = useAppStore((s) => s.activeRightPanelTab);
  const setActiveTab = useAppStore((s) => s.setActiveRightPanelTab);

  const { getTabProps } = useRovingTabList({
    orderedIds: contributions.map((c) => c.id),
    activeId: activeTab,
    // Source is irrelevant here (no content auto-focus) — drop it so the store
    // setter keeps its single-argument contract.
    onActivate: (id) => setActiveTab(id),
  });

  return (
    <div
      className="flex w-full items-center justify-between border-b px-3 py-2"
      data-slot="right-panel-header"
    >
      {contributions.length > 1 ? (
        <TabStrip contributions={contributions} activeTab={activeTab} getTabProps={getTabProps} />
      ) : contributions.length === 1 ? (
        // Single panel: name it (icon + title) instead of a blank bar. Not a
        // tab/tablist — a quiet title — so the "no tab strip with one
        // contribution" contract holds.
        <div className="text-foreground flex items-center gap-1.5 px-1 text-xs font-medium">
          <TabIcon raw={contributions[0]!.icon} className="text-muted-foreground size-3.5" />
          <span>{contributions[0]!.title}</span>
        </div>
      ) : (
        <div />
      )}

      <div className="flex shrink-0 items-center gap-1 pl-1">
        {actions}
        {/* Close button */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close panel"
          className="size-7 shrink-0"
          onClick={() => setRightPanelOpen(false)}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * The segmented tab control, which scrolls rather than clipping.
 *
 * Six tabs are wider than a 375px overlay panel, and a tab pushed past the edge
 * with no way to reach it is a lost surface. Each tab keeps its full width
 * (`shrink-0`, no wrapping) so labels stay readable while scrolling, and a fade is
 * drawn over whichever edge still has tabs behind it — reachable is not the same
 * as discoverable, and macOS shows no scrollbar until you already scrolled.
 *
 * The fade is drawn ONLY when something is actually behind it (ADR
 * 260725-004456: the status line's old fade advertised items that could not be
 * reached at all, which is worse than no affordance).
 *
 * @param props - The visible contributions, the active tab, and the roving-tab props builder.
 * @param props.contributions - The visible panel contributions, in tab order.
 * @param props.activeTab - Id of the selected tab, or `null`.
 * @param props.getTabProps - Roving keyboard props for one tab, from `useRovingTabList`.
 */
function TabStrip({
  contributions,
  activeTab,
  getTabProps,
}: {
  contributions: RightPanelContribution[];
  activeTab: string | null;
  getTabProps: (id: string) => RovingTabProps;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // 1px slack: fractional layout widths leave a sub-pixel remainder that would
    // otherwise pin a fade on permanently at the end of a fully-scrolled strip.
    const max = el.scrollWidth - el.clientWidth;
    const next = { start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 };
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  // Re-measure on any width change — the panel is resizable and its tab set
  // changes with the route — and once more when the tab count itself changes.
  useEffect(() => {
    measure();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, contributions.length]);

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={scrollerRef}
        onScroll={measure}
        // `overflow-y-hidden` is explicit on purpose: with `overflow-x: auto` and a
        // `visible` cross axis, CSS promotes the used `overflow-y` to `auto` too,
        // which clips the active tab's `shadow-sm` and the focus ring against the
        // scroll box. The `-my-1 py-1` pair gives both 4px of room without making
        // the header any taller.
        className="-my-1 overflow-x-auto overflow-y-hidden py-1"
      >
        <div
          className="bg-accent/60 inline-flex gap-0.5 rounded-lg p-0.5"
          role="tablist"
          aria-label="Right panel tabs"
        >
          {contributions.map((contribution) => {
            const isActive = contribution.id === activeTab;
            return (
              <Tooltip key={contribution.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-label={contribution.title}
                    id={rightPanelTabDomId(contribution.id)}
                    aria-controls={isActive ? RIGHT_PANEL_PANEL_ID : undefined}
                    {...getTabProps(contribution.id)}
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] font-medium whitespace-nowrap transition-colors',
                      isActive
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <TabIcon raw={contribution.icon} className="size-3.5" />
                    <span>{contribution.title}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{contribution.title}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
      {/* Purely decorative, and never in the way of the tab it is drawn over. */}
      {edges.start && (
        <div
          aria-hidden
          data-testid="right-panel-tabs-fade-start"
          className="from-sidebar via-sidebar/70 pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r to-transparent"
        />
      )}
      {edges.end && (
        <div
          aria-hidden
          data-testid="right-panel-tabs-fade-end"
          className="from-sidebar via-sidebar/70 pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l to-transparent"
        />
      )}
    </div>
  );
}
