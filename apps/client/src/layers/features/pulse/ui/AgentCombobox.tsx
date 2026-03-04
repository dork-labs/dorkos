import { useState, useRef, useEffect } from 'react';
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
import { hashToHslColor, hashToEmoji } from '@/layers/shared/lib/favicon-utils';
import { shortenHomePath } from '@/layers/shared/lib';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

interface AgentComboboxProps {
  agents: AgentPathEntry[];
  value: string | undefined;
  onValueChange: (value: string | undefined) => void;
}

/** Searchable combobox for selecting a registered mesh agent by name or project path. */
export function AgentCombobox({ agents, value, onValueChange }: AgentComboboxProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedAgent = agents.find((a) => a.id === value);

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

  function handleSelect(agentId: string) {
    onValueChange(agentId === value ? undefined : agentId);
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
        {selectedAgent ? (
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: selectedAgent.color ?? hashToHslColor(selectedAgent.id) }}
            />
            <span className="text-xs leading-none">{selectedAgent.icon ?? hashToEmoji(selectedAgent.id)}</span>
            <span className="truncate font-medium">{selectedAgent.name}</span>
            <span className="text-muted-foreground truncate text-xs">
              {shortenHomePath(selectedAgent.projectPath)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">Select agent...</span>
        )}
        <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <div className="bg-popover text-popover-foreground absolute left-0 top-full z-50 mt-1 w-full rounded-md border shadow-md">
          <Command>
            <CommandInput placeholder="Search by name or path..." />
            <CommandList className="max-h-60">
              <CommandEmpty>No agents found.</CommandEmpty>
              <CommandGroup heading="Registered agents">
                {agents.map((agent) => (
                  <CommandItem
                    key={agent.id}
                    value={`${agent.name} ${agent.projectPath}`}
                    onSelect={() => handleSelect(agent.id)}
                  >
                    <span
                      className="mr-1.5 inline-block size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: agent.color ?? hashToHslColor(agent.id) }}
                    />
                    <span className="mr-1 text-xs leading-none">{agent.icon ?? hashToEmoji(agent.id)}</span>
                    <span className="font-medium">{agent.name}</span>
                    <span className="text-muted-foreground ml-2 truncate text-xs">
                      {shortenHomePath(agent.projectPath)}
                    </span>
                    {agent.id === value && <Check className="ml-auto size-4 shrink-0" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
