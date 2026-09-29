import {
  actionNameFromSlug,
  type ConnectorReconciliationCandidate,
} from '@dorkos/shared/connector-schemas';
import { levelForRequest, type CardAccessLevel } from '../../lib/access-card-selection';
import { joinNames } from './access-labels';

/**
 * What an agent's request asked for, shown on the one-agent access question:
 * its reason, the actions it named, and plainly what the picked level (or
 * either level) leaves out, so the person never allows less than was asked
 * without seeing it.
 */
export function RequestedActions({
  agentName,
  toolkit,
  reason,
  operations,
  candidates,
  level,
}: {
  agentName: string;
  toolkit: string;
  reason: string;
  operations: readonly string[];
  candidates: ConnectorReconciliationCandidate[];
  level: CardAccessLevel | null;
}) {
  const asked = levelForRequest(candidates, operations);
  const label = (operation: string) => actionNameFromSlug(operation, toolkit);
  const leftOutByRead = level === 'read' ? asked.needsWrite.map(label) : [];
  return (
    <div className="bg-muted/40 space-y-1.5 rounded-lg p-3 text-sm" data-testid="requested-actions">
      <p>
        <span className="text-muted-foreground">{agentName} asked: </span>
        {reason}
      </p>
      {operations.length > 0 && (
        <p className="text-muted-foreground text-xs">
          It wants to: {joinNames(operations.map(label))}.
        </p>
      )}
      {leftOutByRead.length > 0 && (
        <p className="text-xs" role="status">
          With Read, {agentName} can’t {joinNames(leftOutByRead).toLowerCase()}.
        </p>
      )}
      {asked.uncovered.length > 0 && (
        <p className="text-xs" role="status">
          Neither choice includes {joinNames(asked.uncovered.map(label)).toLowerCase()}. Pick exact
          actions on Connections if it needs that.
        </p>
      )}
    </div>
  );
}
