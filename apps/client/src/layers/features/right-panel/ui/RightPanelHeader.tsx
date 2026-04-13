import { X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Button, Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { useAppStore, useSlotContributions } from '@/layers/shared/model';
import { useRouterState } from '@tanstack/react-router';

/**
 * Shared header bar for right-panel contributions.
 *
 * Renders a segmented control for switching between panel tabs (Agent / Canvas)
 * when 2+ contributions are visible, plus a close button. Each contribution
 * component renders this at its top to provide consistent tab switching.
 */
export function RightPanelHeader() {
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const activeTab = useAppStore((s) => s.activeRightPanelTab);
  const setActiveTab = useAppStore((s) => s.setActiveRightPanelTab);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const allContributions = useSlotContributions('right-panel');
  const visibleContributions = allContributions.filter(
    (c) => !c.visibleWhen || c.visibleWhen({ pathname })
  );

  return (
    <div
      className="flex w-full items-center justify-between px-3 py-2"
      data-slot="right-panel-header"
    >
      {/* Segmented control — only when >1 contribution */}
      {visibleContributions.length > 1 ? (
        <div
          className="bg-accent/60 inline-flex gap-0.5 rounded-lg p-0.5"
          role="tablist"
          aria-label="Right panel tabs"
        >
          {visibleContributions.map((contribution) => {
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
                    onClick={() => setActiveTab(contribution.id)}
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
  );
}
