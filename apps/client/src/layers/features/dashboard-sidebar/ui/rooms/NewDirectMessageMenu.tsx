import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent, SidebarGroupAction } from '@/layers/shared/ui';

/** One agent the operator can start a conversation with. */
export interface DirectMessageCandidate {
  /** The agent's directory — its stable identity (ADR 260726-170126). */
  agentPath: string;
  /** What to call it on screen, already disambiguated across the roster. */
  displayName: string;
}

interface NewDirectMessageMenuProps {
  /** Agents not already in a direct message, sorted by name. */
  candidates: DirectMessageCandidate[];
  /** Start a conversation with this agent. */
  onSelect: (candidate: DirectMessageCandidate) => void;
}

/**
 * The "+" beside Direct messages: pick an agent, get a conversation with it.
 *
 * Agents already in a direct message are filtered out upstream, so choosing from
 * this list can never produce a second conversation with the same agent.
 */
export function NewDirectMessageMenu({ candidates, onSelect }: NewDirectMessageMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SidebarGroupAction aria-label="New direct message">
          <Plus />
        </SidebarGroupAction>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-56 p-1">
        {candidates.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">
            You already have a conversation with every agent you have added.
          </p>
        ) : (
          candidates.map((candidate) => (
            <button
              key={candidate.agentPath}
              type="button"
              data-testid="dm-candidate"
              onClick={() => {
                setOpen(false);
                onSelect(candidate);
              }}
              className="hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden focus-visible:ring-2"
            >
              <span className="min-w-0 flex-1 truncate">{candidate.displayName}</span>
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
