import { useRef, useCallback } from 'react';
import { motion } from 'motion/react';
import { MessageSquare, Clock, Plug2 } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';

type SidebarTab = 'sessions' | 'schedules' | 'connections';

interface SidebarTabRowProps {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  schedulesBadge: number;
  connectionsStatus: 'ok' | 'partial' | 'error' | 'none';
  visibleTabs: readonly SidebarTab[];
}

const TAB_CONFIG = [
  { id: 'sessions' as const, icon: MessageSquare, label: 'Sessions', shortcut: 1 },
  { id: 'schedules' as const, icon: Clock, label: 'Schedules', shortcut: 2 },
  { id: 'connections' as const, icon: Plug2, label: 'Connections', shortcut: 3 },
] as const;

const STATUS_DOT_COLORS: Record<string, string> = {
  ok: 'bg-green-500',
  partial: 'bg-amber-500',
  error: 'bg-red-500',
};

/**
 * Horizontal tab row for the agent sidebar. Renders icon tabs with ARIA tablist
 * semantics and a motion-animated sliding indicator below the active tab.
 */
export function SidebarTabRow({
  activeTab,
  onTabChange,
  schedulesBadge,
  connectionsStatus,
  visibleTabs,
}: SidebarTabRowProps) {
  const tabListRef = useRef<HTMLDivElement>(null);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const modKey = isMac ? '\u2318' : 'Ctrl+';

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = visibleTabs.indexOf(activeTab);
      let nextIndex = currentIndex;

      if (e.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % visibleTabs.length;
        e.preventDefault();
      } else if (e.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + visibleTabs.length) % visibleTabs.length;
        e.preventDefault();
      }

      if (nextIndex !== currentIndex) {
        onTabChange(visibleTabs[nextIndex]);
        // Focus the newly active tab button
        const buttons = tabListRef.current?.querySelectorAll('[role="tab"]');
        (buttons?.[nextIndex] as HTMLElement)?.focus();
      }
    },
    [activeTab, onTabChange, visibleTabs]
  );

  const tabs = TAB_CONFIG.filter((t) => visibleTabs.includes(t.id));

  return (
    <div
      ref={tabListRef}
      role="tablist"
      aria-label="Sidebar views"
      // tabIndex makes the tablist itself focusable, satisfying jsx-a11y/interactive-supports-focus.
      // Individual tab buttons manage their own tabIndex via roving tabindex pattern.
      tabIndex={-1}
      className="border-border relative flex items-center gap-1 border-b px-2 py-1.5"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const Icon = tab.icon;

        return (
          <Tooltip key={tab.id}>
            <TooltipTrigger asChild>
              <button
                role="tab"
                id={`sidebar-tab-${tab.id}`}
                aria-selected={isActive}
                aria-controls={`sidebar-tabpanel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onTabChange(tab.id)}
                className={cn(
                  'relative rounded-md p-2 transition-colors duration-150',
                  isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground/50 hover:text-muted-foreground'
                )}
              >
                <Icon className="size-(--size-icon-sm)" />

                {/* Schedules numeric badge */}
                {tab.id === 'schedules' && schedulesBadge > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-green-500 text-[10px] font-medium text-white">
                    {schedulesBadge > 9 ? '9+' : schedulesBadge}
                    <span className="absolute inset-0 animate-pulse rounded-full bg-green-500/30" />
                  </span>
                )}

                {/* Connections status dot */}
                {tab.id === 'connections' && connectionsStatus !== 'none' && (
                  <span
                    className={cn(
                      'absolute -right-0.5 -top-0.5 size-1.5 rounded-full',
                      STATUS_DOT_COLORS[connectionsStatus]
                    )}
                  />
                )}

                {/* Sliding indicator */}
                {isActive && (
                  <motion.div
                    layoutId="sidebar-tab-indicator"
                    className="bg-foreground absolute right-0 bottom-[-7px] left-0 h-0.5 rounded-full"
                    transition={{ type: 'spring', stiffness: 280, damping: 32 }}
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {tab.label} {`${modKey}${tab.shortcut}`}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
