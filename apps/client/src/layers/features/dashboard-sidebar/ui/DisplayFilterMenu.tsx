import type { ElementType } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { SidebarDisplayFilter } from '@dorkos/shared/config-schema';

/** Selectable per-section display filters, in menu order (spec agent-list-settings §5). */
export const DISPLAY_FILTER_OPTIONS: { value: SidebarDisplayFilter; label: string }[] = [
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
export const DISPLAY_FILTER_MENU_LABEL = 'Show';

/** The mark beside {@link DISPLAY_FILTER_MENU_LABEL}, shared for the same reason. */
export const DISPLAY_FILTER_MENU_ICON = SlidersHorizontal;

/** Slot primitives the "Show" submenu renders through — one per Radix menu family. */
export interface DisplayFilterMenuSlots {
  Sub: ElementType;
  SubTrigger: ElementType;
  SubContent: ElementType;
  RadioGroup: ElementType;
  RadioItem: ElementType;
}

/**
 * The "Show" radio submenu (All / Active / Needs attention) — rendered
 * identically inside a group's header menu and the ungrouped section's header
 * menu (spec agent-list-settings §5) so the two settings surfaces never
 * drift. Mirrors {@link DISPLAY_FILTER_OPTIONS}.
 *
 * @param slots - The Radix menu primitives to render through (context or dropdown variant).
 * @param current - The section's active display filter.
 * @param onChange - Called with the newly-selected filter value.
 */
export function renderDisplayFilterSubmenu(
  slots: DisplayFilterMenuSlots,
  current: SidebarDisplayFilter,
  onChange: (value: string) => void
) {
  const { Sub, SubTrigger, SubContent, RadioGroup, RadioItem } = slots;
  return (
    <Sub>
      <SubTrigger>
        <DISPLAY_FILTER_MENU_ICON className="mr-2 size-4" />
        {DISPLAY_FILTER_MENU_LABEL}
      </SubTrigger>
      <SubContent className="w-44">
        <RadioGroup value={current} onValueChange={onChange}>
          {DISPLAY_FILTER_OPTIONS.map((opt) => (
            <RadioItem key={opt.value} value={opt.value}>
              {opt.label}
            </RadioItem>
          ))}
        </RadioGroup>
      </SubContent>
    </Sub>
  );
}
