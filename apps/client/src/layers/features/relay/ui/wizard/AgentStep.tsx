import { useEffect } from 'react';
import { Label } from '@/layers/shared/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui/select';
import type { SessionStrategy } from '@dorkos/shared/relay-schemas';
import { getAgentDisplayName } from '@/layers/shared/lib';

/**
 * How an incoming message maps onto a conversation, in words rather than the
 * wire value's shorthand. The enum is unchanged; only the labels are plain.
 */
const MEMORY_CHOICES: { value: SessionStrategy; label: string; hint: string }[] = [
  {
    value: 'per-chat',
    label: 'One conversation per chat',
    hint: 'Everyone in a chat shares the same thread of memory.',
  },
  {
    value: 'per-user',
    label: 'One conversation per person',
    hint: 'Each person gets their own thread, even in a shared chat.',
  },
  {
    value: 'stateless',
    label: 'A fresh start every message',
    hint: 'Nothing carries over from the message before.',
  },
];

interface AgentStepProps {
  agentOptions: { id: string; name: string }[];
  agentId: string;
  onAgentIdChange: (id: string) => void;
  strategy: SessionStrategy;
  onStrategyChange: (strategy: SessionStrategy) => void;
}

/**
 * Step one: who answers. Asked before any setting, because a way for people to
 * reach your agents that reaches no agent is not worth creating — the agent
 * picked here and the connection are saved together at the end.
 */
export function AgentStep({
  agentOptions,
  agentId,
  onAgentIdChange,
  strategy,
  onStrategyChange,
}: AgentStepProps) {
  const onlyAgent = agentOptions.length === 1 ? agentOptions[0] : undefined;

  // With one agent there is no choice to make, so make it — the step still
  // renders, naming who will answer, rather than asking a question with one
  // possible answer.
  useEffect(() => {
    if (onlyAgent && !agentId) onAgentIdChange(onlyAgent.id);
  }, [onlyAgent, agentId, onAgentIdChange]);

  if (agentOptions.length === 0) {
    return (
      <p
        role="alert"
        className="text-muted-foreground rounded-md border border-dashed px-4 py-6 text-center text-sm"
      >
        You have no agents yet. Add one from the Team page, then come back and set this up.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Messages that arrive here go to this agent. Nothing is set up until you pick one.
      </p>

      {onlyAgent ? (
        <div className="bg-accent/30 rounded-md border px-4 py-3 text-sm">
          <span className="font-medium">{getAgentDisplayName(onlyAgent)}</span> will answer.
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="wizard-agent">Who should answer?</Label>
          <Select value={agentId} onValueChange={onAgentIdChange}>
            <SelectTrigger id="wizard-agent" className="w-full">
              <SelectValue placeholder="Pick an agent" />
            </SelectTrigger>
            <SelectContent>
              {agentOptions.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {getAgentDisplayName(agent)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="wizard-memory">How the agent remembers</Label>
        <Select value={strategy} onValueChange={(v) => onStrategyChange(v as SessionStrategy)}>
          <SelectTrigger id="wizard-memory" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MEMORY_CHOICES.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          {MEMORY_CHOICES.find((c) => c.value === strategy)?.hint}
        </p>
      </div>
    </div>
  );
}
