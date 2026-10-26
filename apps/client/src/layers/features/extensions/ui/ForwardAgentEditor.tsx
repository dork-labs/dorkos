/**
 * "Forwards your comments to" for one mini app that asks to forward
 * (`capabilities.forward`, DOR-3325), on its card in Settings → Extensions.
 *
 * What the person types in the mini app reaches this one agent, in their
 * Direct chat, as their own words. With none picked it forwards nothing.
 *
 * @module features/extensions/ui/ForwardAgentEditor
 */
import { toast } from 'sonner';
import { getAgentDisplayName } from '@dorkos/shared/validation';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/layers/shared/ui';
import { useForwardAgent, useSetForwardAgent } from '../api/forward-agent';

/** The Select's value for "nobody". Not an agent id: those are ULIDs. */
const NONE = 'none';

/**
 * The editor for one mini app's agent.
 *
 * @param props.extensionId - The mini app.
 * @param props.name - Its name, for labels.
 */
export function ForwardAgentEditor({ extensionId, name }: { extensionId: string; name: string }) {
  const choice = useForwardAgent(extensionId).data;
  const { mutate } = useSetForwardAgent(extensionId);
  const agents = useRegisteredAgents().data?.agents ?? [];
  const picked = choice?.agent?.id ?? NONE;

  const save = (value: string) =>
    mutate(value === NONE ? null : value, { onError: (err) => toast.error(err.message) });

  return (
    <div className="space-y-1.5 pt-1" data-testid={`forward-agent-${extensionId}`}>
      <p className="text-sm">Forwards your comments to</p>
      <Select value={picked} onValueChange={save}>
        <SelectTrigger className="h-8 w-56" aria-label={`Agent ${name} forwards to`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Nobody</SelectItem>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {getAgentDisplayName(agent)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs">
        {choice?.missingAgentId
          ? 'The agent it forwarded to is gone. Pick another.'
          : picked === NONE
            ? 'None yet. It can’t send your comments anywhere.'
            : 'Your comments reach this agent as your own words.'}
      </p>
    </div>
  );
}
