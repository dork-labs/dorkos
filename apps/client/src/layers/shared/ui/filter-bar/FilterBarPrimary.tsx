import { useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import { isEnumFilter, type EnumFilterDefinition } from '@/layers/shared/lib/filter-engine';
import { Popover, PopoverContent, PopoverTrigger } from '@/layers/shared/ui/popover';
import { Checkbox } from '@/layers/shared/ui/checkbox';
import { useFilterBar } from './FilterBarContext';

/**
 * Invisible reach that grows this 28px pill to a 44px touch target below `md`.
 *
 * Vertical reach (`-inset-y-2`, 8px each side) lands exactly on 28+16=44px.
 * Horizontal reach (`-inset-x-1`, 4px each side) stays inside half of the
 * toolbar's `gap-2` (8px) so neighbouring pills' reach zones meet without
 * overlapping — the same anisotropic budget `PresenceStrip` uses for its row
 * of chips.
 */
const TOUCH_REACH = 'relative after:absolute after:-inset-x-1 after:-inset-y-2 md:after:hidden';

interface FilterBarPrimaryProps {
  /** Key into the filter schema — must reference an enum filter. */
  name: string;
  className?: string;
}

/** Always-visible multi-select dropdown for a primary enum filter. */
function FilterBarPrimary({ name, className }: FilterBarPrimaryProps) {
  const { schema, values, set } = useFilterBar();
  const [open, setOpen] = useState(false);

  const def = schema.definitions[name];
  if (!def || !isEnumFilter(def)) return null;

  const enumDef = def as EnumFilterDefinition<unknown>;
  const label = enumDef.label ?? name;
  const selected = ((values as Record<string, unknown>)[name] ?? []) as string[];

  const triggerLabel =
    selected.length === 0
      ? label
      : selected.length === 1
        ? `${label}: ${enumDef.labels?.[selected[0]] ?? selected[0]}`
        : `${label}: ${selected.length} selected`;

  function toggle(option: string) {
    const next = selected.includes(option)
      ? selected.filter((v) => v !== option)
      : [...selected, option];
    set(name, next);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-slot="filter-bar-primary"
        className={cn(
          'border-input hover:bg-accent hover:text-accent-foreground inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs',
          TOUCH_REACH,
          selected.length > 0 && 'border-primary/50',
          className
        )}
      >
        {triggerLabel}
        <ChevronDownIcon className="size-3 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {enumDef.options.map((option) => (
          <label
            key={option}
            className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs"
          >
            <Checkbox checked={selected.includes(option)} onCheckedChange={() => toggle(option)} />
            {enumDef.colors?.[option] && (
              <span
                className={cn('size-2 shrink-0 rounded-full bg-current', enumDef.colors[option])}
              />
            )}
            <span>{enumDef.labels?.[option] ?? option}</span>
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export { FilterBarPrimary };
