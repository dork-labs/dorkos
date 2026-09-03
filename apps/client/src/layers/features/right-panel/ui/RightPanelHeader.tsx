import { useCallback, useEffect, useRef, type ReactNode } from 'react';
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
import {
  revealInScroller,
  useAppStore,
  useScrollOverflow,
  type RightPanelContribution,
} from '@/layers/shared/model';

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
 * **The selected tab is always brought into view.** Clicking a tab scrolls it in
 * for free, because a click focuses it and the browser reveals what it focuses —
 * so nothing that a person operates by hand ever showed the bug. Everything else
 * does: a tab activated by a server `ui_command` (the agent opening the canvas),
 * by a restored per-agent layout, or by the panel being dragged narrower left the
 * selected tab cut off at the edge with its label half-drawn, and the fade over it
 * reads as a smudge on the pill rather than as "there is more this way"
 * (DOR-471). So the reveal is explicit rather than borrowed from focus.
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
  const tablistRef = useRef<HTMLDivElement>(null);
  // Which edge still has tabs behind it. The same hook the home tab bar and the
  // pinned triage header draw their cues from — "is anything hidden past this
  // edge" has one answer in this codebase, and its 1px slack rule and its
  // re-measure-on-every-commit rule live with it rather than in three copies.
  const edges = useScrollOverflow(scrollerRef, 'horizontal');

  /**
   * Scroll the least distance that puts the selected tab fully inside the strip.
   *
   * The tab is found by its stable DOM id rather than by `aria-selected`, so the
   * reveal cannot silently no-op: a route or transport change can leave
   * `activeTab` pointing at a contribution that is momentarily not rendered (see
   * {@link RightPanelContainer}), and during that frame no tab carries
   * `aria-selected="true"` at all. Keyed on the id, the effect below simply runs
   * again when the tab set that made it renderable changes.
   */
  const selectedTab = useCallback((): HTMLElement | null => {
    const el = scrollerRef.current;
    if (!el || !activeTab) return null;
    return el.querySelector<HTMLElement>(`#${CSS.escape(rightPanelTabDomId(activeTab))}`);
  }, [activeTab]);

  const revealActiveTab = useCallback(() => {
    const el = scrollerRef.current;
    const tab = selectedTab();
    if (!el || !tab) return;
    revealInScroller(el, tab);
  }, [selectedTab]);

  // Re-reveal on any size change: the panel is resizable, so a strip that fitted
  // a moment ago can leave the selected tab behind an edge.
  //
  // **All three boxes, and sharing the fades' observer is not enough.**
  // `useScrollOverflow` watches the scroller too, but it watches it to answer a
  // different question and it does not run this. Dropping the scroller from
  // THIS list left the reveal blind to the one case that resizes only the scroll
  // box: dragging the panel divider narrower. Measured on the real component —
  // a tab that fitted at 340px, with the box then narrowed to 200px, stays at
  // `scrollLeft: 0` with its label half-drawn, which is verbatim one of the
  // three failures DOR-471 was written for.
  //
  // Each box answers its own part. The scroller gives the viewport the reveal
  // compares against. The tablist is the content, which can change size on its
  // own — a late web font, a contribution renaming its tab — while the box does
  // not. And the selected tab itself is what the reveal exists to keep on
  // screen: anything that moves or resizes it (a sibling tab widening as its
  // label resolves) invalidates a scroll position that was correct when it was
  // set, which is what left the reveal one tab's width short of the edge.
  //
  // Keyed on the tab ids, not their count: a route change can swap one
  // contribution for another and leave the count alone, and that is exactly when
  // the strip's content width changes underneath a stale reading.
  const tabIds = contributions.map((c) => c.id).join(',');
  useEffect(() => {
    revealActiveTab();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(revealActiveTab);
    for (const el of [scrollerRef.current, tablistRef.current, selectedTab()]) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [revealActiveTab, selectedTab, tabIds]);

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={scrollerRef}
        onScroll={edges.onScroll}
        // `overflow-y-hidden` is explicit on purpose: with `overflow-x: auto` and a
        // `visible` cross axis, CSS promotes the used `overflow-y` to `auto` too,
        // which clips the active tab's `shadow-sm` and the focus ring against the
        // scroll box. The `-my-1 py-1` pair gives both 4px of room without making
        // the header any taller.
        className="-my-1 overflow-x-auto overflow-y-hidden py-1"
      >
        <div
          ref={tablistRef}
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
                      'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-3xs font-medium whitespace-nowrap transition-colors',
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
