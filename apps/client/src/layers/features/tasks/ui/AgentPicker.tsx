import { useState, useEffect, useRef } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/layers/shared/ui';
import { cn, getAgentDisplayName, shortenHomePath } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

interface AgentPickerProps {
  agents: AgentPathEntry[];
  value: string | undefined;
  onValueChange: (value: string | undefined) => void;
}

// ---------------------------------------------------------------------------
// Shared agent list rendered inside both dropdown and drawer
// ---------------------------------------------------------------------------

function AgentCommandList({
  agents,
  value,
  onSelect,
}: {
  agents: AgentPathEntry[];
  value: string | undefined;
  onSelect: (agentId: string) => void;
}) {
  return (
    <Command>
      <CommandInput placeholder="Search agents..." />
      <CommandList className="!max-h-60 !overflow-y-auto">
        <CommandEmpty>No agents found.</CommandEmpty>
        <CommandGroup>
          {agents.map((agent) => {
            const visual = resolveAgentVisual(agent);
            return (
              <CommandItem
                key={agent.id}
                value={`${getAgentDisplayName(agent)} ${agent.name} ${agent.projectPath}`}
                onSelect={() => onSelect(agent.id)}
              >
                <AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />
                <span className="truncate font-medium">{getAgentDisplayName(agent)}</span>
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
  );
}

// ---------------------------------------------------------------------------
// Trigger button (shared between desktop and mobile)
// ---------------------------------------------------------------------------

function AgentPickerTrigger({
  selectedAgent,
  open,
  onClick,
}: {
  selectedAgent: AgentPathEntry | undefined;
  open: boolean;
  onClick: () => void;
}) {
  const selectedVisual = selectedAgent ? resolveAgentVisual(selectedAgent) : null;

  return (
    <button
      type="button"
      aria-expanded={open}
      aria-haspopup="listbox"
      className={cn(
        'border-input ring-offset-background flex h-9 w-full items-center justify-between rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm transition-colors',
        'focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none',
        'hover:bg-accent/50'
      )}
      onClick={onClick}
    >
      {selectedAgent ? (
        <span className="flex items-center gap-2 truncate">
          <AgentAvatar color={selectedVisual!.color} emoji={selectedVisual!.emoji} size="xs" />
          <span className="truncate">{getAgentDisplayName(selectedAgent)}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">Select an agent...</span>
      )}
      <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// AgentPicker — dropdown on desktop, drawer on mobile
// ---------------------------------------------------------------------------

/** Searchable combobox for selecting a registered agent. Renders as a drawer on mobile. */
export function AgentPicker({ agents, value, onValueChange }: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside (desktop only)
  useEffect(() => {
    if (!open || isMobile) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, isMobile]);

  const selectedAgent = agents.find((a) => a.id === value);

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

  // Mobile: drawer with the agent list
  if (isMobile) {
    return (
      <>
        <AgentPickerTrigger
          selectedAgent={selectedAgent}
          open={open}
          onClick={() => setOpen(true)}
        />
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Select an agent</DrawerTitle>
            </DrawerHeader>
            <div className="px-4 pb-4">
              <AgentCommandList agents={agents} value={value} onSelect={handleSelect} />
            </div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  // Desktop: dropdown
  return (
    <div ref={containerRef} className="relative w-full">
      <AgentPickerTrigger
        selectedAgent={selectedAgent}
        open={open}
        onClick={() => setOpen((prev) => !prev)}
      />

      {open && (
        <div className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 w-full rounded-md border shadow-md">
          <AgentCommandList agents={agents} value={value} onSelect={handleSelect} />
        </div>
      )}
    </div>
  );
}
