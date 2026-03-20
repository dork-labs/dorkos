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
export function TimezoneCombobox({ value, onChange }: TimezoneComboboxProps) {
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

  const detectedTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

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

  const displayValue = value || 'System default';

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
          'border-input ring-offset-background flex h-9 w-full items-center justify-between rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm transition-colors',
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
            <CommandInput placeholder="Search timezone..." />
            <CommandList className="max-h-60">
              <CommandEmpty>No timezone found.</CommandEmpty>
              <CommandGroup heading="Default">
                <CommandItem value="system-default" onSelect={() => handleSelect('')}>
                  <span>System default</span>
                  {value === '' && <Check className="ml-auto size-4" />}
                </CommandItem>
                {detectedTz && (
                  <CommandItem
                    value={`${detectedTz}-detected`}
                    onSelect={() => handleSelect(detectedTz)}
                  >
                    <span>{detectedTz} (detected)</span>
                    {value === detectedTz && <Check className="ml-auto size-4" />}
                  </CommandItem>
                )}
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
