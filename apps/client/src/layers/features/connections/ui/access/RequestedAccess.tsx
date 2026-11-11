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
 * The level a card starts on: what the agent asked for, never below what it
 * holds, and Read when it asked to change things the account can't give a
 * level for (DOR-4193).
 *
 * @param asked - The level a request asked for, or null without one.
 * @param held - The level the card would start on from current access.
 * @param candidates - The account's actions in the card's snapshot.
 */
export function startLevel(
  asked: CardAccessLevel | null,
  held: CardAccessLevel | null,
  candidates: ConnectorReconciliationPreview['candidates']
): CardAccessLevel | null {
  if (asked === 'read-write' && requestedWriteOffer(candidates) !== 'level') return 'read';
  return asked === 'read-write' || held === 'read-write' ? 'read-write' : held;
}

/**
 * Whether a request asks to change things the account can give a level for,
 * so the card says that answer is the person's.
 *
 * @param request - What the agent asked for, when a request opened the card.
 * @param preview - The card's snapshot.
 */
export function asksGrantableWrite(
  request: { readonly access: CardAccessLevel } | undefined,
  preview: Pick<ConnectorReconciliationPreview, 'candidates'>
): boolean {
  return request?.access === 'read-write' && requestedWriteOffer(preview.candidates) === 'level';
}

/**
 * The card's save button: "Save" on the page, and for one agent "Allow", or
 * "Allow read only" when it asked to change things and the account can only
 * give Read (DOR-4193).
 *
 * @param mode - Which card this is.
 * @param request - What the agent asked for, when a request opened the card.
 * @param preview - The card's snapshot.
 */
export function allowLabel(
  mode: 'page' | 'agent',
  request: { readonly access: CardAccessLevel } | undefined,
  preview: Pick<ConnectorReconciliationPreview, 'candidates'>
): string {
  if (mode === 'page') return 'Save';
  const readOnly =
    request?.access === 'read-write' && requestedWriteOffer(preview.candidates) !== 'level';
  return readOnly ? 'Allow read only' : 'Allow';
}

/**
 * What an agent's request asked for, shown on the one-agent access question:
 * its reason, the level it asked for, and plainly what a lower pick leaves
 * out, so the person never allows less than was asked without seeing it.
 * When the account cannot give Read and write at all, the level switch says
 * so once, before anyone answers (DOR-3616, DOR-4193).
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
      {/* An app with no Read and write says so once, under the level switch (LevelPicker). */}
      {wantsWrite && writeOffer === 'level' && level === 'read' && (
        <p className="text-xs" role="status">
          With Read, {agentName} can’t change {serviceName}.
        </p>
      )}
    </div>
  );
}
