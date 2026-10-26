/**
 * "Sends your comments to" for one mini app that asks to forward
 * (`capabilities.forward`, DOR-3325), on its card in Settings → Extensions.
 *
 * What the person types in the mini app reaches these agents only, in their
 * Direct chat, as their own words. The first forward to a new agent asks in a
 * DorkOS prompt; this is where the person changes it later. Each agent is a
 * removable chip, with an Add picker of registered agents.
 *
 * @module features/extensions/ui/ForwardAgentsEditor
 */
import { useState } from 'react';
import { Bot, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { getAgentDisplayName } from '@dorkos/shared/validation';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/layers/shared/ui';
import { useForwardAgents, useSetForwardAgents } from '../api/forward-agents';

/** One chip: an allowed agent, or an allowed id Mesh no longer knows. */
interface Chip {
  id: string;
  name: string;
}

/**
 * The editor for one mini app's agents.
 *
 * @param props.extensionId - The mini app.
 * @param props.name - Its name, for labels.
 */
export function ForwardAgentsEditor({ extensionId, name }: { extensionId: string; name: string }) {
  const choice = useForwardAgents(extensionId).data;
  const { mutate } = useSetForwardAgents(extensionId);
  const registered = useRegisteredAgents().data?.agents ?? [];
  const chips: Chip[] = [
    ...(choice?.agents ?? []),
    ...(choice?.missing ?? []).map((id) => ({ id, name: 'An agent that is gone' })),
  ];
  const ids = chips.map((chip) => chip.id);

  const save = (next: string[]) => mutate(next, { onError: (err) => toast.error(err.message) });

  return (
    <div className="space-y-1.5 pt-1" data-testid={`forward-agents-${extensionId}`}>
      <p className="text-sm">Sends your comments to</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <span
            key={chip.id}
            className="bg-muted inline-flex h-6 items-center gap-1 rounded-md pr-0.5 pl-1.5 text-xs"
          >
            <Bot className="text-muted-foreground size-3" aria-hidden />
            <span className="max-w-40 truncate">{chip.name}</span>
            <button
              type="button"
              onClick={() => save(ids.filter((id) => id !== chip.id))}
              aria-label={`Remove ${chip.name}`}
              className="text-muted-foreground hover:text-foreground focus-ring rounded-sm p-0.5"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <AddAgent
          name={name}
          agents={registered
            .filter((agent) => !ids.includes(agent.id))
            .map((agent) => ({ id: agent.id, name: getAgentDisplayName(agent) }))}
          onAdd={(id) => save([...ids, id])}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        {chips.length === 0
          ? 'None yet. It asks you the first time you send a comment.'
          : 'Your comments reach these agents as your own words.'}
      </p>
    </div>
  );
}

/** The Add picker: registered agents not already listed, searchable. */
function AddAgent({
  name,
  agents,
  onAdd,
}: {
  name: string;
  agents: readonly Chip[];
  onAdd: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          aria-label={`Add an agent for ${name}`}
        >
          <Plus className="size-3" />
          Add
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Find an agent" />
          <CommandList className="max-h-64">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {agents.length > 0 && (
              <CommandGroup heading="Agents">
                {agents.map((agent) => (
                  <CommandItem
                    key={agent.id}
                    value={`agent ${agent.name} ${agent.id}`}
                    onSelect={() => {
                      onAdd(agent.id);
                      setOpen(false);
                    }}
                  >
                    <Bot className="size-3.5" />
                    {agent.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
