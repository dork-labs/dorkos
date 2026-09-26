import { useId } from 'react';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import { Badge, Button, Checkbox, Label } from '@/layers/shared/ui';
import {
  heldAccess,
  rankAgents,
  VISIBLE_AGENT_LIMIT,
  type CardDecision,
} from '../../lib/access-card-selection';
import { selectionsFromPreview } from '../../lib/reconciliation-selection';
import { HELD_LABELS } from './access-labels';

interface AgentChecklistProps {
  /** Server snapshot the checklist reads. */
  preview: ConnectorReconciliationPreview;
  /** The app's display name. */
  serviceName: string;
  /** Agents the caller knows are relevant right now. */
  preferredAgentIds?: string[];
  /** Built-in agents, such as DorkBot. */
  systemAgentIds: string[];
  /** Agents the person has ticked. */
  picked: ReadonlySet<string>;
  /** Replace the ticked set. */
  setPicked: (next: Set<string>) => void;
  /** What saving would do, so losses are said before Save. */
  decision: CardDecision;
  /** Whether every agent is listed. */
  showAll: boolean;
  /** List every agent. */
  setShowAll: (next: boolean) => void;
}

/**
 * The page card's "Only agents I pick" answer: agents most relevant first,
 * each with what it holds today, and a plain line for every agent that would
 * lose access or lose write access on Save.
 *
 * Before "Show all", it lists the first few, every ticked agent, and every
 * agent that has access now, so unticking one never hides it from view.
 */
export function AgentChecklist({
  preview,
  serviceName,
  preferredAgentIds,
  systemAgentIds,
  picked,
  setPicked,
  decision,
  showAll,
  setShowAll,
}: AgentChecklistProps) {
  const baseId = useId();
  const current = selectionsFromPreview(preview);
  const ranked = rankAgents(preview, { preferredAgentIds, systemAgentIds });
  const visible = showAll
    ? ranked
    : ranked.filter(
        (agent, index) =>
          index < VISIBLE_AGENT_LIMIT ||
          picked.has(agent.agentId) ||
          (current[agent.agentId] ?? []).length > 0
      );
  const nameOf = (agentId: string) =>
    preview.agents.find((agent) => agent.agentId === agentId)?.displayName;

  return (
    <fieldset className="space-y-1">
      <legend className="sr-only">Agents that can use {serviceName}</legend>
      {visible.map((agent) => {
        const id = `${baseId}-${agent.agentId}`;
        const held = heldAccess(preview.candidates, current[agent.agentId] ?? []);
        const loses =
          decision.removedAgentIds.includes(agent.agentId) ||
          decision.downgradedAgentIds.includes(agent.agentId);
        return (
          <div
            key={agent.agentId}
            className="hover:bg-muted/60 flex min-h-11 items-center gap-3 rounded-md px-2"
          >
            <Checkbox
              id={id}
              aria-describedby={loses ? `${id}-loss` : undefined}
              checked={picked.has(agent.agentId)}
              onCheckedChange={(next) => {
                const updated = new Set(picked);
                if (next === true) updated.add(agent.agentId);
                else updated.delete(agent.agentId);
                setPicked(updated);
              }}
            />
            <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer py-2 font-normal">
              <span className="truncate">{agent.displayName}</span>
            </Label>
            {held !== 'none' && (
              <Badge size="xs" variant="secondary" aria-label={`Now: ${HELD_LABELS[held]}`}>
                {HELD_LABELS[held]}
              </Badge>
            )}
          </div>
        );
      })}
      {visible.length < ranked.length && (
        <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
          Show all {ranked.length}
        </Button>
      )}
      {/* Each loss line describes its agent's checkbox, and the region
          announces a new one as it appears. */}
      <div aria-live="polite" className="space-y-1">
        {decision.removedAgentIds.map((agentId) => (
          <p key={agentId} id={`${baseId}-${agentId}-loss`} className="text-warning px-2 text-xs">
            {nameOf(agentId)} will lose access to {serviceName}.
          </p>
        ))}
        {decision.downgradedAgentIds.map((agentId) => (
          <p key={agentId} id={`${baseId}-${agentId}-loss`} className="text-warning px-2 text-xs">
            {nameOf(agentId)} will lose write access.
          </p>
        ))}
      </div>
    </fieldset>
  );
}
