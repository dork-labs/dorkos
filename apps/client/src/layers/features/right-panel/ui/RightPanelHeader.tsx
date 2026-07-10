import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  Button,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  useRovingTabList,
} from '@/layers/shared/ui';
import { useAppStore, type RightPanelContribution } from '@/layers/shared/model';

/** DOM id of the right-panel content region the active tab controls. */
export const RIGHT_PANEL_PANEL_ID = 'right-panel-content';

/** Stable DOM id for a right-panel contribution's tab — links panel `aria-labelledby` to it. */
export function rightPanelTabDomId(contributionId: string): string {
  return `right-panel-tab-${contributionId}`;
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
 * segmented tab control when 2+ contributions are visible, and renders the
 * active tab's `headerActions` beside the close button.
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
      {/* Segmented control — only when >1 contribution */}
      {contributions.length > 1 ? (
        <div
          className="bg-accent/60 inline-flex gap-0.5 rounded-lg p-0.5"
          role="tablist"
          aria-label="Right panel tabs"
        >
          {contributions.map((contribution) => {
            const isActive = contribution.id === activeTab;
            const Icon = contribution.icon;
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
                      'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors',
                      isActive
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Icon className="size-3.5" />
                    <span>{contribution.title}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{contribution.title}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ) : (
        <div />
      )}

      <div className="flex items-center gap-1">
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
