import { useId } from 'react';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import { Badge, Button, Checkbox, Label } from '@/layers/shared/ui';
import { heldAccess, rankAgents, VISIBLE_AGENT_LIMIT } from '../../lib/access-card-selection';
import { displayedAccessLevel } from '../../lib/access-level-offer';
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
  /** Whether every agent is listed. */
  showAll: boolean;
  /** List every agent. */
  setShowAll: (next: boolean) => void;
}

/**
 * The page card's "Only agents you pick" answer: agents most relevant first,
 * each with what it holds today. A ticked agent that holds its own grant says
 * so ("Own access"), so a pre-tick never reads like a default (DOR-4899). What
 * Save would do is said once, in the card's result line above Save.
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
          heldAccess(current[agent.agentId]) !== 'none'
      );

  return (
    <fieldset className="space-y-1">
      <legend className="sr-only">Agents that can use {serviceName}</legend>
      {visible.map((agent) => {
        const id = `${baseId}-${agent.agentId}`;
        const held = displayedAccessLevel(heldAccess(current[agent.agentId]), preview.candidates);
        const ownAccess = held !== 'none' && picked.has(agent.agentId);
        return (
          <div
            key={agent.agentId}
            className="hover:bg-muted/60 flex min-h-11 items-center gap-3 rounded-md px-2"
          >
            <Checkbox
              id={id}
              aria-describedby={ownAccess ? `${id}-own` : undefined}
              checked={picked.has(agent.agentId)}
              onCheckedChange={(next) => {
                const updated = new Set(picked);
                if (next === true) updated.add(agent.agentId);
                else updated.delete(agent.agentId);
                setPicked(updated);
              }}
            />
            {/* The tag sits under the name, so a phone never cuts the name short. */}
            <div className="flex min-w-0 flex-1 flex-col py-1.5">
              <Label htmlFor={id} className="cursor-pointer py-0.5 font-normal">
                <span className="truncate">{agent.displayName}</span>
              </Label>
              {ownAccess && (
                <span id={`${id}-own`} className="text-muted-foreground text-xs">
                  Own access
                </span>
              )}
            </div>
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
    </fieldset>
  );
}
