import type { CardAccessLevel } from '../../lib/access-card-selection';

/** What an agent can do in an app at each level, as the request line says it. */
const ASKED_FOR: Record<CardAccessLevel, (serviceName: string) => string> = {
  read: (serviceName) => `It wants to read ${serviceName}.`,
  'read-write': (serviceName) => `It wants to read and change things in ${serviceName}.`,
};

/**
 * What an agent's request asked for, shown on the one-agent access question:
 * its reason, the level it asked for, and plainly what a lower pick leaves
 * out, so the person never allows less than was asked without seeing it.
 * Agents ask by level (DOR-2503), so this compares levels, never action names.
 */
export function RequestedAccess({
  agentName,
  serviceName,
  reason,
  access,
  level,
}: {
  agentName: string;
  serviceName: string;
  reason: string;
  access: CardAccessLevel;
  level: CardAccessLevel | null;
}) {
  return (
    <div className="bg-muted/40 space-y-1.5 rounded-lg p-3 text-sm" data-testid="requested-access">
      <p>
        <span className="text-muted-foreground">{agentName} asked: </span>
        {reason}
      </p>
      <p className="text-muted-foreground text-xs">{ASKED_FOR[access](serviceName)}</p>
      {access === 'read-write' && level === 'read' && (
        <p className="text-xs" role="status">
          With Read, {agentName} can’t change anything in {serviceName}.
        </p>
      )}
    </div>
  );
}
