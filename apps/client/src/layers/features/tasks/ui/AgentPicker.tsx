import { useState, useEffect, useRef } from 'react';
import { ChevronsUpDown } from 'lucide-react';
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
import { AgentAvatar, AgentOptionRow, resolveAgentVisual } from '@/layers/entities/agent';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

interface AgentPickerProps {
  agents: AgentPathEntry[];
  value: string | undefined;
  onValueChange: (value: string | undefined) => void;
  /**
   * Show the chosen agent without offering a change, and point at the element
   * that says why.
   *
   * An id rather than a bare boolean, because an inert control with no reason
   * attached is a dead click somebody has to guess at. It becomes the trigger's
   * `aria-describedby`, so the sentence beneath the picker is read out with it.
   *
   * `aria-disabled` rather than the `disabled` attribute, the same rule the
   * widget action buttons follow: this trigger is the only place the chosen
   * agent is named, and a `disabled` button is skipped by tab navigation — so
   * somebody moving through the form by keyboard would never hear which agent
   * this is about. The click is neutralised instead.
   */
  disabledReasonId?: string;
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
          {agents.map((agent) => (
            <CommandItem
              key={agent.id}
              value={`${getAgentDisplayName(agent)} ${agent.name} ${agent.projectPath}`}
              onSelect={() => onSelect(agent.id)}
            >
              <AgentOptionRow
                agent={agent}
                secondary={shortenHomePath(agent.projectPath)}
                selected={agent.id === value}
              />
            </CommandItem>
          ))}
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
  inertReasonId,
  hasValue,
}: {
  selectedAgent: AgentPathEntry | undefined;
  open: boolean;
  onClick: () => void;
  inertReasonId?: string;
  /** Whether an agent id is stored, whether or not the roster still has it. */
  hasValue: boolean;
}) {
  const selectedVisual = selectedAgent ? resolveAgentVisual(selectedAgent) : null;
  const inert = inertReasonId !== undefined;

  // A prompt on a control that takes no input reads as an instruction nobody
  // can follow, so the inert trigger states the case instead — and it tells the
  // two empty cases apart the way a task row does, because "no agent" and "the
  // agent is gone" call for different things from the person reading it.
  const emptyText = !inert ? 'Select an agent...' : hasValue ? 'Agent not found' : 'No agent';

  return (
    <button
      type="button"
      {...(inert
        ? { 'aria-disabled': true, 'aria-describedby': inertReasonId }
        : { 'aria-expanded': open, 'aria-haspopup': 'listbox' as const })}
      className={cn(
        'border-input ring-offset-background flex h-9 w-full items-center justify-between rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm transition-colors',
        'focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none',
        inert ? 'cursor-default opacity-60' : 'hover:bg-accent/50'
      )}
      onClick={inert ? undefined : onClick}
    >
      {selectedAgent ? (
        <span className="flex items-center gap-2 truncate">
          <AgentAvatar color={selectedVisual!.color} emoji={selectedVisual!.emoji} size="xs" />
          <span className="truncate">{getAgentDisplayName(selectedAgent)}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">{emptyText}</span>
      )}
      {/* The chevron promises a list to open. Nothing opens here. */}
      {!inert && <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// AgentPicker — dropdown on desktop, drawer on mobile
// ---------------------------------------------------------------------------

/**
 * Searchable combobox for selecting a registered agent. Renders as a drawer on
 * mobile, and as an inert row wherever the choice is already settled — see
 * {@link AgentPickerProps.disabledReasonId}.
 */
export function AgentPicker({ agents, value, onValueChange, disabledReasonId }: AgentPickerProps) {
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

  // Ahead of the empty-state box below, which invites registering an agent —
  // an action that would change nothing here, because this picker is not
  // offering the choice in the first place.
  if (disabledReasonId !== undefined) {
    return (
      <AgentPickerTrigger
        selectedAgent={selectedAgent}
        open={false}
        onClick={() => {}}
        inertReasonId={disabledReasonId}
        hasValue={value !== undefined}
      />
    );
  }

  if (agents.length === 0) {
    return (
      <div className="rounded-md border px-4 py-6 text-center">
        <p className="text-muted-foreground text-sm">No agents registered yet</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Register an agent via the Mesh panel to give it scheduled tasks.
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
          hasValue={value !== undefined}
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
        hasValue={value !== undefined}
      />

      {open && (
        <div className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 w-full rounded-md border shadow-md">
          <AgentCommandList agents={agents} value={value} onSelect={handleSelect} />
        </div>
      )}
    </div>
  );
}
