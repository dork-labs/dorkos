import { SlidersHorizontal } from 'lucide-react';
import type { SidebarDisplayFilter } from '@dorkos/shared/config-schema';
import type { SidebarMenuRadioSubmenu } from '@/layers/shared/ui';

/** Selectable per-section display filters, in menu order (spec agent-list-settings §5). */
const DISPLAY_FILTER_OPTIONS: { value: SidebarDisplayFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'attention', label: 'Needs attention' },
];

/**
 * What the display-filter submenu is called, wherever it appears — a group's
 * header menu, the Agents header menu, and any menu that adds it next. One
 * constant because §14.1's whole point is that the same verb reads the same
 * everywhere.
 */
const DISPLAY_FILTER_MENU_LABEL = 'Show';

/** The mark beside {@link DISPLAY_FILTER_MENU_LABEL}, shared for the same reason. */
const DISPLAY_FILTER_MENU_ICON = SlidersHorizontal;

/**
 * The "Show" radio submenu (All / Active / Needs attention) as a menu node —
 * identical inside a group's header menu and the ungrouped section's header
 * menu (spec agent-list-settings §5), so the two settings surfaces cannot
 * drift.
 *
 * A node rather than a render function: the slot tables that used to make this
 * a `render*` now live once in `shared/ui/sidebar-menu-node`, so a menu is data
 * everywhere and Radix is nobody's business but the renderer's.
 *
 * @param current - The section's active display filter.
 * @param onChange - Called with the newly-selected filter value.
 */
export function displayFilterNode(
  current: SidebarDisplayFilter,
  onChange: (value: string) => void
): SidebarMenuRadioSubmenu {
  return {
    kind: 'radio',
    id: 'display',
    label: DISPLAY_FILTER_MENU_LABEL,
    icon: DISPLAY_FILTER_MENU_ICON,
    value: current,
    options: [...DISPLAY_FILTER_OPTIONS],
    onChange,
  };
}
