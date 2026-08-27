import { useState } from 'react';
import {
  ArrowLeftIcon,
  CalendarIcon,
  HashIcon,
  ListIcon,
  PlusIcon,
  ToggleLeftIcon,
  CheckIcon,
} from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import {
  isEnumFilter,
  type EnumFilterDefinition,
  type DateRangeFilterValue,
  type NumericRangeFilterValue,
} from '@/layers/shared/lib/filter-engine';
import { Popover, PopoverContent, PopoverTrigger } from '@/layers/shared/ui/popover';
import { Checkbox } from '@/layers/shared/ui/checkbox';
import { Button } from '@/layers/shared/ui/button';
import { Input } from '@/layers/shared/ui/input';
import { useFilterBar } from './FilterBarContext';

const TYPE_ICONS: Record<string, typeof ListIcon> = {
  enum: ListIcon,
  dateRange: CalendarIcon,
  boolean: ToggleLeftIcon,
  numericRange: HashIcon,
};

const DATE_PRESETS = [
  { label: 'Past 1h', value: '1h' },
  { label: 'Past 24h', value: '24h' },
  { label: 'Past 7d', value: '7d' },
  { label: 'Past 30d', value: '30d' },
];

interface FilterBarAddFilterProps {
  /** Runtime options for dynamic enum filters. */
  dynamicOptions?: Record<string, string[]>;
  className?: string;
}

/** Two-stage popover for adding secondary filters. */
function FilterBarAddFilter({ dynamicOptions, className }: FilterBarAddFilterProps) {
  const { schema, values, set, clear } = useFilterBar();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<'list' | string>('list');

  // Exclude search and text-type filters from the add-filter list
  const availableFilters = Object.entries(schema.definitions).filter(
    ([, def]) => def.type !== 'text'
  );

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) setStage('list');
  }

  function selectFilter(name: string) {
    setStage(name);
  }

  function goBack() {
    setStage('list');
  }

  // ── Stage 1: Property list ──────────────────────────────────
  function renderPropertyList() {
    return (
      <div className="flex flex-col">
        {availableFilters.map(([name, def]) => {
          const Icon = TYPE_ICONS[def.type] ?? ListIcon;
          const isActive = def.isActive((values as Record<string, unknown>)[name]);
          const label = def.label ?? name;

          return (
            <button
              key={name}
              type="button"
              onClick={() => selectFilter(name)}
              className="hover:bg-accent flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs"
            >
              <Icon className="text-muted-foreground size-3.5" />
              <span className="flex-1 text-left">{label}</span>
              {isActive && <CheckIcon className="text-primary size-3" />}
            </button>
          );
        })}
      </div>
    );
  }

  // ── Stage 2: Value picker ───────────────────────────────────
  function renderValuePicker(name: string) {
    const def = schema.definitions[name];
    if (!def) return null;

    const label = def.label ?? name;

    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={goBack}
          className="hover:bg-accent -mx-1 flex items-center gap-1 rounded-sm px-1 py-1 text-xs font-medium"
        >
          <ArrowLeftIcon className="size-3" />
          {label}
        </button>
        {renderValueControl(name)}
      </div>
    );
  }

  function renderValueControl(name: string) {
    const def = schema.definitions[name];
    if (!def) return null;

    if (isEnumFilter(def)) {
      return renderEnumPicker(name, def as EnumFilterDefinition<unknown>);
    }
    if (def.type === 'dateRange') {
      return renderDateRangePicker(name);
    }
    if (def.type === 'boolean') {
      return renderBooleanPicker(name);
    }
    if (def.type === 'numericRange') {
      return renderNumericRangePicker(name);
    }
    return null;
  }

  function renderEnumPicker(name: string, enumDef: EnumFilterDefinition<unknown>) {
    const options = enumDef.dynamic ? (dynamicOptions?.[name] ?? enumDef.options) : enumDef.options;
    const current = ((values as Record<string, unknown>)[name] ?? (enumDef.multi ? [] : '')) as
      string | string[];
    const selected = Array.isArray(current) ? current : current ? [current] : [];

    function toggle(option: string) {
      if (enumDef.multi) {
        const next = selected.includes(option)
          ? selected.filter((v) => v !== option)
          : [...selected, option];
        set(name, next);
      } else {
        set(name, selected.includes(option) ? '' : option);
      }
    }

    return (
      <div className="flex flex-col">
        {options.map((option) => (
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
        {selected.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            responsive={false}
            className="mt-1 self-start"
            onClick={() => clear(name)}
          >
            Clear
          </Button>
        )}
      </div>
    );
  }

  function renderDateRangePicker(name: string) {
    const current = ((values as Record<string, unknown>)[name] ?? {}) as DateRangeFilterValue;

    return (
      <div className="flex flex-col gap-1">
        {DATE_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => set(name, { preset: preset.value })}
            className={cn(
              'hover:bg-accent rounded-sm px-2 py-1.5 text-left text-xs',
              current.preset === preset.value && 'bg-accent font-medium'
            )}
          >
            {preset.label}
          </button>
        ))}
        {current.preset && (
          <Button
            variant="ghost"
            size="xs"
            responsive={false}
            className="mt-1 self-start"
            onClick={() => clear(name)}
          >
            Clear
          </Button>
        )}
      </div>
    );
  }

  function renderBooleanPicker(name: string) {
    const current = (values as Record<string, unknown>)[name] as boolean | null;

    return (
      <div className="flex flex-col gap-1">
        {[true, false].map((val) => (
          <button
            key={String(val)}
            type="button"
            onClick={() => set(name, current === val ? null : val)}
            className={cn(
              'hover:bg-accent rounded-sm px-2 py-1.5 text-left text-xs',
              current === val && 'bg-accent font-medium'
            )}
          >
            {val ? 'Yes' : 'No'}
          </button>
        ))}
      </div>
    );
  }

  function renderNumericRangePicker(name: string) {
    const current = ((values as Record<string, unknown>)[name] ?? {}) as NumericRangeFilterValue;

    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground w-8">Min</span>
          <Input
            responsive={false}
            type="number"
            aria-label="Minimum value"
            value={current.min ?? ''}
            onChange={(e) =>
              set(name, {
                ...current,
                min: e.target.value ? Number(e.target.value) : undefined,
              })
            }
            className="h-7 text-xs"
          />
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground w-8">Max</span>
          <Input
            responsive={false}
            type="number"
            aria-label="Maximum value"
            value={current.max ?? ''}
            onChange={(e) =>
              set(name, {
                ...current,
                max: e.target.value ? Number(e.target.value) : undefined,
              })
            }
            className="h-7 text-xs"
          />
        </div>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        data-slot="filter-bar-add-filter"
        className={cn(
          'border-muted text-muted-foreground hover:text-foreground hover:border-input inline-flex h-7 items-center gap-1 rounded-md border border-dashed px-2.5 text-xs',
          className
        )}
      >
        <PlusIcon className="size-3" />
        Filter
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-1">
        {stage === 'list' ? renderPropertyList() : renderValuePicker(stage)}
      </PopoverContent>
    </Popover>
  );
}

export { FilterBarAddFilter };
