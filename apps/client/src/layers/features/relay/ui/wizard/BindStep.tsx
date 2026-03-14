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

/** Options for the session strategy selector. */
const SESSION_STRATEGIES: { value: SessionStrategy; label: string }[] = [
  { value: 'per-chat', label: 'Per Chat' },
  { value: 'per-user', label: 'Per User' },
  { value: 'stateless', label: 'Stateless' },
];

interface BindStepProps {
  agentOptions: { id: string; name: string }[];
  agentId: string;
  onAgentIdChange: (id: string) => void;
  strategy: SessionStrategy;
  onStrategyChange: (strategy: SessionStrategy) => void;
  botUsername?: string;
  adapterType?: string;
}

/** Optional step to bind the newly created adapter to an agent. */
export function BindStep({
  agentOptions,
  agentId,
  onAgentIdChange,
  strategy,
  onStrategyChange,
  botUsername,
  adapterType,
}: BindStepProps) {
  // Auto-select when there's exactly one agent and none is selected yet.
  useEffect(() => {
    if (agentOptions.length === 1 && !agentId) {
      onAgentIdChange(agentOptions[0]!.id);
    }
  }, [agentOptions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Bind this adapter to an agent so incoming messages are routed automatically. You can skip
        this and bind later from the Bindings tab.
      </p>

      {agentOptions.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No agents registered yet. You can bind this adapter later from the Adapters tab.
        </div>
      ) : agentOptions.length === 1 ? (
        <div className="rounded-md border bg-accent/30 px-4 py-3 text-sm">
          Will bind to <span className="font-medium">{agentOptions[0]!.name}</span>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="bind-agent">Agent</Label>
          <Select value={agentId} onValueChange={onAgentIdChange}>
            <SelectTrigger id="bind-agent" className="w-full">
              <SelectValue placeholder="Select an agent" />
            </SelectTrigger>
            <SelectContent>
              {agentOptions.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {agentOptions.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor="bind-strategy">Session Strategy</Label>
          <Select value={strategy} onValueChange={(v) => onStrategyChange(v as SessionStrategy)}>
            <SelectTrigger id="bind-strategy" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SESSION_STRATEGIES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {botUsername && adapterType === 'telegram' && (
        <a
          href={`https://t.me/${botUsername}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
        >
          Message @{botUsername} in Telegram
        </a>
      )}
    </div>
  );
}
