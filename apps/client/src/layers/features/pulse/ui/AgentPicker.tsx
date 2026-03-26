import { useState, useEffect, useRef } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/layers/shared/ui';
import { cn, shortenHomePath } from '@/layers/shared/lib';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

interface AgentPickerProps {
  agents: AgentPathEntry[];
  value: string | undefined;
  onValueChange: (value: string | undefined) => void;
}

/** Searchable combobox for selecting a registered agent. */
export function AgentPicker({ agents, value, onValueChange }: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const selectedAgent = agents.find((a) => a.id === value);
  const selectedVisual = selectedAgent ? resolveAgentVisual(selectedAgent) : null;

  function handleSelect(agentId: string) {
    onValueChange(agentId === value ? undefined : agentId);
    setOpen(false);
  }

  if (agents.length === 0) {
    return (
      <div className="rounded-md border px-4 py-6 text-center">
        <p className="text-muted-foreground text-sm">No agents registered yet</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Register an agent via the Mesh panel to schedule automated tasks.
        </p>
      </div>
    );
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
          <span className="flex items-center gap-2 truncate">
            <AgentAvatar color={selectedVisual!.color} emoji={selectedVisual!.emoji} size="xs" />
            <span className="truncate">{selectedAgent.name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Select an agent...</span>
        )}
        <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
      </button>

      {open && (
        <div className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 w-full rounded-md border shadow-md">
          <Command>
            <CommandInput placeholder="Search agents..." />
            <CommandList className="max-h-60">
              <CommandEmpty>No agents found.</CommandEmpty>
              <CommandGroup>
                {agents.map((agent) => {
                  const visual = resolveAgentVisual(agent);
                  return (
                    <CommandItem
                      key={agent.id}
                      value={`${agent.name} ${agent.projectPath}`}
                      onSelect={() => handleSelect(agent.id)}
                    >
                      <AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />
                      <span className="truncate font-medium">{agent.name}</span>
                      <span className="text-muted-foreground truncate text-xs">
                        {shortenHomePath(agent.projectPath)}
                      </span>
                      {agent.id === value && <Check className="ml-auto size-4 shrink-0" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
