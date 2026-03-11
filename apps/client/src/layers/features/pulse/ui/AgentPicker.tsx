import { useState, useEffect } from 'react';
import { Check, Pencil } from 'lucide-react';
import { ScrollArea } from '@/layers/shared/ui';
import { Input } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { hashToHslColor, hashToEmoji } from '@/layers/shared/lib/favicon-utils';
import { shortenHomePath } from '@/layers/shared/lib';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

const SEARCH_THRESHOLD = 8;

interface AgentPickerProps {
  agents: AgentPathEntry[];
  value: string | undefined;
  onValueChange: (value: string | undefined) => void;
}

/** Direct agent list selector — collapses to a single row after selection. */
export function AgentPicker({ agents, value, onValueChange }: AgentPickerProps) {
  const [expanded, setExpanded] = useState(!value);
  const [search, setSearch] = useState('');

  // Re-expand when value is cleared externally (e.g., form reset)
  useEffect(() => {
    if (!value) setExpanded(true);
  }, [value]);

  const selectedAgent = agents.find((a) => a.id === value);
  const showSearch = agents.length >= SEARCH_THRESHOLD;

  const filteredAgents = search
    ? agents.filter(
        (a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          a.projectPath.toLowerCase().includes(search.toLowerCase())
      )
    : agents;

  function handleSelect(agentId: string) {
    if (agentId === value) {
      onValueChange(undefined);
    } else {
      onValueChange(agentId);
      setExpanded(false);
      setSearch('');
    }
  }

  // Empty state
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

  // Collapsed state — show selected agent only
  if (selectedAgent && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label="Change agent"
        className={cn(
          'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
          'hover:bg-accent/50',
          'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-1'
        )}
      >
        <span
          className="inline-block size-2 shrink-0 rounded-full"
          style={{ backgroundColor: selectedAgent.color ?? hashToHslColor(selectedAgent.id) }}
        />
        <span className="text-xs leading-none">
          {selectedAgent.icon ?? hashToEmoji(selectedAgent.id)}
        </span>
        <span className="truncate font-medium">{selectedAgent.name}</span>
        <span className="text-muted-foreground truncate text-xs">
          {shortenHomePath(selectedAgent.projectPath)}
        </span>
        <Pencil className="text-muted-foreground ml-auto size-3.5 shrink-0" />
      </button>
    );
  }

  // Expanded state — full agent list
  return (
    <div className="space-y-2">
      {showSearch && (
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or path..."
          className="h-8 text-sm"
        />
      )}
      <ScrollArea className="max-h-[200px]">
        <div className="space-y-1">
          {filteredAgents.map((agent) => {
            const isSelected = agent.id === value;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => handleSelect(agent.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-1',
                  isSelected
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50'
                )}
              >
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: agent.color ?? hashToHslColor(agent.id) }}
                />
                <span className="text-xs leading-none">
                  {agent.icon ?? hashToEmoji(agent.id)}
                </span>
                <span className="truncate font-medium">{agent.name}</span>
                <span className="text-muted-foreground truncate text-xs">
                  {shortenHomePath(agent.projectPath)}
                </span>
                {isSelected && <Check className="ml-auto size-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
