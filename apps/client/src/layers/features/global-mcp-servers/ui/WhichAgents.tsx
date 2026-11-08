import { useId, useState } from 'react';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { Label, SegmentedControl, SegmentedControlItem, Switch } from '@/layers/shared/ui';

interface WhichAgentsProps {
  /** The agent ids the server is kept from. */
  excluded: readonly string[];
  /** Ask for a new list of kept-out agents. The answer comes back through `excluded`. */
  onChange: (next: string[]) => void;
  /** Nothing can change while a change is in flight. */
  disabled?: boolean;
}

/**
 * All agents, or All except… with a switch per agent. It shows what is true, not what was asked,
 * so a change still waiting on "Confirm it's you" leaves the control where it was. An id for an
 * agent no longer registered is kept as it is.
 */
export function WhichAgents({ excluded, onChange, disabled }: WhichAgentsProps) {
  const labelId = useId();
  const baseId = useId();
  const { data } = useRegisteredAgents();
  const agents = data?.agents ?? [];
  // Choosing All except… keeps every agent on until a switch says otherwise.
  const [picking, setPicking] = useState(false);
  const value = excluded.length > 0 || picking ? 'except' : 'all';

  return (
    <div className="space-y-2">
      <p id={labelId} className="text-sm font-medium">
        Which agents get it
      </p>
      <SegmentedControl
        aria-labelledby={labelId}
        value={value}
        disabled={disabled}
        className="sm:w-fit"
        onValueChange={(next) => {
          setPicking(next === 'except');
          if (next === 'all' && excluded.length > 0) onChange([]);
        }}
      >
        <SegmentedControlItem value="all" className="px-3 text-sm max-sm:min-h-11">
          All agents
        </SegmentedControlItem>
        <SegmentedControlItem value="except" className="px-3 text-sm max-sm:min-h-11">
          All except…
        </SegmentedControlItem>
      </SegmentedControl>
      {value === 'except' && (
        <ul className="space-y-0.5">
          {agents.map((agent) => {
            const id = `${baseId}-${agent.id}`;
            const name = agent.displayName ?? agent.name;
            const { color, emoji } = resolveAgentVisual(agent);
            const gets = !excluded.includes(agent.id);
            return (
              <li key={agent.id} className="flex min-h-11 items-center gap-3">
                <AgentAvatar color={color} emoji={emoji} size="sm" badge={null} />
                <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer truncate py-2">
                  {name}
                </Label>
                <Switch
                  id={id}
                  checked={gets}
                  disabled={disabled}
                  onCheckedChange={(next) =>
                    onChange(
                      next
                        ? excluded.filter((candidate) => candidate !== agent.id)
                        : [...excluded, agent.id]
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
