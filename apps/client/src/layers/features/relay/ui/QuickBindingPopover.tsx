import { useState } from 'react';
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
import { useRegisteredAgents } from '@/layers/entities/mesh';

interface QuickBindingPopoverProps {
  /** The adapter ID to create a binding for. Passed through to onQuickBind context. */
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
 * Shows a searchable list of registered agents. Selecting one fires
 * `onQuickBind` to create a binding with all defaults. An "Advanced..."
 * link opens the full BindingDialog for detailed configuration.
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
  const agents = agentsData?.agents ?? [];

  async function handleSelect(agentId: string) {
    await onQuickBind(agentId);
    setOpen(false);
  }

  function handleAdvanced() {
    setOpen(false);
    onAdvanced();
  }

  // Suppress unused variable lint — adapterId is accepted for future filtering.
  void adapterId;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search agents..." />
          <CommandList>
            <CommandEmpty>No agents registered</CommandEmpty>
            {agents.map((agent) => (
              <CommandItem
                key={agent.id}
                value={agent.name}
                onSelect={() => handleSelect(agent.id)}
                disabled={isPending}
              >
                {isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
                {agent.name}
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
