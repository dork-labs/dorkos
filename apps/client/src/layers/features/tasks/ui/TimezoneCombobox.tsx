import { useState, useMemo, useRef, useEffect } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

interface TimezoneComboboxProps {
  value: string;
  browserTimezone?: string | null;
  onChange: (tz: string) => void;
}

/** Group timezone strings by continent prefix (e.g. "America", "Europe"). */
function groupByContinent(timezones: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const tz of timezones) {
    const [continent] = tz.split('/');
    if (!map.has(continent)) map.set(continent, []);
    map.get(continent)!.push(tz);
  }
  return map;
}

/** Searchable combobox for IANA timezone selection, grouped by continent. */
export function TimezoneCombobox({ value, browserTimezone, onChange }: TimezoneComboboxProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const timezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return [];
    }
  }, []);

  const groups = useMemo(() => groupByContinent(timezones), [timezones]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const defaultLabel = browserTimezone ? `Your time zone (${browserTimezone})` : 'Your time zone';
  // The person's own zone reads as "Your time zone" whether the field is empty
  // (a new schedule's default) or names it outright (an edit, or a pick).
  const isOwnZone = value === '' || (browserTimezone != null && value === browserTimezone);
  const displayValue = isOwnZone ? defaultLabel : value;

  function handleSelect(tz: string) {
    onChange(tz);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          'border-input ring-offset-background flex h-9 w-full items-center justify-between rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs transition-colors',
          'focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none',
          'hover:bg-accent/50'
        )}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="truncate">{displayValue}</span>
        <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <div className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 w-full rounded-md border shadow-md">
          <Command>
            <CommandInput placeholder="Search timezone…" />
            <CommandList className="max-h-60">
              <CommandEmpty>No timezone found.</CommandEmpty>
              <CommandGroup heading="Default">
                <CommandItem
                  value="system-default"
                  // The real zone, never '': an edit sends a zone only when the field
                  // names one, so '' would leave a UTC schedule in UTC.
                  onSelect={() => handleSelect(browserTimezone ?? '')}
                >
                  <span>{defaultLabel}</span>
                  {isOwnZone && <Check className="ml-auto size-4" />}
                </CommandItem>
              </CommandGroup>
              {[...groups.entries()].map(([continent, tzList]) => (
                <CommandGroup key={continent} heading={continent}>
                  {tzList.map((tz) => (
                    <CommandItem key={tz} value={tz} onSelect={() => handleSelect(tz)}>
                      <span>{tz.replace(`${continent}/`, '').replace(/_/g, ' ')}</span>
                      {tz === value && <Check className="ml-auto size-4" />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
