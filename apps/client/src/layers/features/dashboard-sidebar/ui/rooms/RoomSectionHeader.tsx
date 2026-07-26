import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

interface RoomSectionHeaderProps {
  /** Section name, e.g. "Channels". Rendered uppercase. */
  label: string;
  /** Current collapse state (persisted in `ui.sidebar`). */
  collapsed: boolean;
  /** Flip the collapse state. */
  onToggle: () => void;
}

/**
 * The collapse header shared by the Channels and Direct messages sections.
 *
 * A plain boolean pref and a conditional render, matching `RecentSessionsSection`
 * — the sidebar's house pattern. The chevron is decorative; `aria-expanded`
 * carries the state.
 */
export function RoomSectionHeader({ label, collapsed, onToggle }: RoomSectionHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className={cn(
        'text-sidebar-foreground/70 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring',
        'flex h-8 w-full items-center gap-1 rounded-md px-2 text-xs font-medium outline-hidden focus-visible:ring-2'
      )}
    >
      {collapsed ? (
        <ChevronRight className="size-3.5 shrink-0" />
      ) : (
        <ChevronDown className="size-3.5 shrink-0" />
      )}
      <span className="tracking-wider uppercase">{label}</span>
    </button>
  );
}
