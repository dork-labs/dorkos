import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { SidebarDisplayFilter } from '@dorkos/shared/config-schema';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  setUngroupedDisplayFilter,
} from '@/layers/entities/config';
import { renderDisplayFilterSubmenu } from './DisplayFilterMenu';

const SLOTS = {
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
};

/**
 * The ungrouped "Agents" section's header "…" menu — currently just the
 * "Show" display-filter submenu, rendered next to the "Agents" label the same
 * way {@link GroupHeader}'s menu sits next to a group's name (spec
 * agent-list-settings §5). Only mounted while the sidebar is organized (the
 * label itself follows the same rule) — an unorganized flat list stays
 * uncluttered, matching how small fleets rarely need filtering.
 */
export function UngroupedSectionMenu() {
  const prefs = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();

  const setFilter = (filter: string) =>
    update((prev) => setUngroupedDisplayFilter(prev, filter as SidebarDisplayFilter));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Agents section actions"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring',
            'absolute top-3.5 right-9 flex size-5 items-center justify-center rounded-md opacity-0 outline-hidden transition-opacity',
            'group-hover/us:opacity-100 focus-visible:opacity-100 focus-visible:ring-2'
          )}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-44">
        {renderDisplayFilterSubmenu(SLOTS, prefs.ungroupedDisplayFilter, setFilter)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
