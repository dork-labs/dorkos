import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
  Button,
} from '@/layers/shared/ui';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useBindings } from '@/layers/entities/binding';

interface QuickBindingPopoverProps {
  /** The adapter ID to create a binding for. Used to filter already-bound agents. */
  adapterId: string;
  /** Called with the selected agent ID to create a binding with defaults. */
  onQuickBind: (agentId: string) => Promise<void>;
  /** Opens the full BindingDialog for advanced configuration. */
  onAdvanced: () => void;
  /** Whether a create mutation is in flight. */
  isPending: boolean;
  /** Trigger element rendered as the popover anchor. */
  children: React.ReactNode;
}

/**
 * Inline agent picker popover for one-click binding creation.
 *
 * Shows a searchable list of registered agents, excluding agents that already
 * have a binding to this adapter. Selecting one fires `onQuickBind` to create
 * a binding with all defaults. An "Advanced..." link opens the full
 * BindingDialog for detailed configuration.
 */
export function QuickBindingPopover({
  adapterId,
  onQuickBind,
  onAdvanced,
  isPending,
  children,
}: QuickBindingPopoverProps) {
  const [open, setOpen] = useState(false);
  const { data: agentsData } = useRegisteredAgents();
  const { data: bindings = [] } = useBindings();

  // Exclude agents that already have a binding to this adapter so users
  // cannot create duplicate adapter-agent pairs via the quick picker.
  const boundAgentIds = useMemo(
    () => new Set(bindings.filter((b) => b.adapterId === adapterId).map((b) => b.agentId)),
    [bindings, adapterId]
  );

  const availableAgents = useMemo(
    () => (agentsData?.agents ?? []).filter((a) => !boundAgentIds.has(a.id)),
    [agentsData, boundAgentIds]
  );

  async function handleSelect(agentId: string) {
    await onQuickBind(agentId);
    setOpen(false);
  }

  function handleAdvanced() {
    setOpen(false);
    onAdvanced();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search agents..." />
          <CommandList>
            <CommandEmpty>No agents registered</CommandEmpty>
            {availableAgents.map((agent) => (
              <CommandItem
                key={agent.id}
                value={getAgentDisplayName(agent)}
                onSelect={() => handleSelect(agent.id)}
                disabled={isPending}
              >
                {isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
                {getAgentDisplayName(agent)}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        <div className="border-t px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground w-full text-xs"
            onClick={handleAdvanced}
          >
            Advanced...
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
