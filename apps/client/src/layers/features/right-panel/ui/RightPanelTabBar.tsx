import { cn } from '@/layers/shared/lib';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import type { RightPanelContribution } from '@/layers/shared/model';

interface RightPanelTabBarProps {
  /** Ordered list of visible contributions to render as tab buttons. */
  contributions: RightPanelContribution[];
  /** ID of the currently active tab. */
  activeTab: string | null;
  /** Called with the contribution ID when a tab button is clicked. */
  onTabChange: (id: string) => void;
}

/**
 * Vertical strip of icon buttons rendered inside the right panel.
 * One button per contribution; active tab receives pressed styling.
 *
 * @module features/right-panel
 */
export function RightPanelTabBar({ contributions, activeTab, onTabChange }: RightPanelTabBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Right panel tabs"
      aria-orientation="vertical"
      className="flex flex-col items-center gap-1 border-l p-1"
    >
      {contributions.map((contribution) => {
        const isActive = contribution.id === activeTab;
        const Icon = contribution.icon;

        return (
          <Tooltip key={contribution.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={contribution.title}
                aria-pressed={isActive}
                onClick={() => onTabChange(contribution.id)}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{contribution.title}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
