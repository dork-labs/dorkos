import {
  accessLevelRevisionIds,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import type { CardAccessLevel } from '../../lib/access-card-selection';

/** What an agent can do in an app at each level, as the request line says it. */
const ASKED_FOR: Record<CardAccessLevel, (serviceName: string) => string> = {
  read: (serviceName) => `It wants to read ${serviceName}.`,
  'read-write': (serviceName) => `It wants to read and change things in ${serviceName}.`,
};

/**
 * How the account offers changing things: as the Read and write level, only
 * one action at a time (no level covers them), or not at all.
 */
export type RequestedWriteOffer = 'level' | 'exact' | 'none';

/**
 * How an account's actions offer changing things (DOR-4193): Read and write
 * adds actions over Read, or every change action is destructive (allowed one
 * at a time), or there are none.
 *
 * @param candidates - The account's actions in one access snapshot.
 */
export function requestedWriteOffer(
  candidates: ConnectorReconciliationPreview['candidates']
): RequestedWriteOffer {
  const readWrite = accessLevelRevisionIds(candidates, 'read-write').length;
  if (readWrite > accessLevelRevisionIds(candidates, 'read').length) return 'level';
  return candidates.some((c) => c.supported && c.capabilityClassification !== 'read')
    ? 'exact'
    : 'none';
}

/**
 * What an agent's request asked for, shown on the one-agent access question:
 * its reason, the level it asked for, and plainly what a lower pick leaves
 * out, so the person never allows less than was asked without seeing it.
 * When the account cannot give Read and write at all, it says so before
 * anyone answers, and what the person can do instead (DOR-3616, DOR-4193).
 * Agents ask by level (DOR-2503), so this compares levels, never action names.
 */
export function RequestedAccess({
  agentName,
  serviceName,
  request: { reason, access },
  level,
  writeOffer,
}: {
  agentName: string;
  serviceName: string;
  /** What the agent asked for: its reason and the level it named. */
  request: { readonly reason: string; readonly access: CardAccessLevel };
  level: CardAccessLevel | null;
  writeOffer: RequestedWriteOffer;
}) {
  const wantsWrite = access === 'read-write';
  return (
    <div className="bg-muted/40 space-y-1.5 rounded-lg p-3 text-sm" data-testid="requested-access">
      <p>
        <span className="text-muted-foreground">{agentName} asked: </span>
        {reason}
      </p>
      <p className="text-muted-foreground text-xs">{ASKED_FOR[access](serviceName)}</p>
      {wantsWrite && writeOffer !== 'level' ? (
        <div className="space-y-0.5 text-xs" role="status" data-testid="requested-write-missing">
          <p>Allow gives Read only. {serviceName} has no Read and write here.</p>
          <p className="text-muted-foreground">
            {writeOffer === 'none'
              ? `If that seems wrong, connect ${serviceName} again.`
              : 'To let it change things, choose exact actions on the Connections page.'}
          </p>
        </div>
      ) : (
        wantsWrite &&
        level === 'read' && (
          <p className="text-xs" role="status">
            With Read, {agentName} can’t change {serviceName}.
          </p>
        )
      )}
    </div>
  );
}
