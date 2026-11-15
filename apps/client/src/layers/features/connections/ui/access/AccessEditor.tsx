import { useId, type ReactNode } from 'react';
import {
  accessLevelRevisionIds,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { Button, SegmentedControl, SegmentedControlItem } from '@/layers/shared/ui';
import {
  agentHeldAccess,
  heldAccess,
  type CardAccessLevel,
  type CardDecision,
  type WhoCanUse,
} from '../../lib/access-card-selection';
import { requestedWriteOffer } from '../../lib/access-level-offer';
import { selectionsFromPreview } from '../../lib/reconciliation-selection';
import { AppActions } from '../AppActions';
import type { ConnectionAccessCardProps } from './ConnectionAccessCard';
import { AgentChecklist } from './AgentChecklist';
import { LEVEL_LABELS } from './access-labels';
import { EveryAgentWarning } from './EveryAgentWarning';
import { RequestedAccess } from './RequestedAccess';
import { WhoCanUseChoice } from './WhoCanUseChoice';

/** The account snapshot's access choices, shared by the page and one-agent card. */
export function AccessEditor({
  props,
  preview,
  picked,
  setPicked,
  who,
  setWho,
  decision,
  level,
  setLevel,
  showAll,
  setShowAll,
  systemAgentIds,
}: {
  props: ConnectionAccessCardProps & { connectionId: string };
  preview: ConnectorReconciliationPreview;
  picked: Set<string>;
  setPicked: (next: Set<string>) => void;
  who: WhoCanUse;
  setWho: (next: WhoCanUse) => void;
  decision: CardDecision;
  level: CardAccessLevel | null;
  setLevel: (next: CardAccessLevel) => void;
  showAll: boolean;
  setShowAll: (next: boolean) => void;
  systemAgentIds: string[];
}) {
  const baseId = useId();
  const current = selectionsFromPreview(preview);
  const writeOffer = requestedWriteOffer(preview.candidates);
  const readWriteIds = accessLevelRevisionIds(preview.candidates, 'read-write');
  const offered: CardAccessLevel[] = writeOffer === 'level' ? ['read', 'read-write'] : ['read'];
  // The chat's one-agent answer only offers levels at or above what it holds.
  const levels =
    props.mode === 'agent' &&
    writeOffer === 'level' &&
    agentHeldAccess(preview, props.agentId, Boolean(props.onAllowed)) === 'read-write'
      ? offered.filter((option) => option === 'read-write')
      : offered;
  const nothingToGrant = readWriteIds.length === 0;

  const exactActionsLink = props.onEditExactActions && (
    <ExactActionsLink onClick={() => props.onEditExactActions?.(props.connectionId)} />
  );

  let whoView: ReactNode;
  if (props.mode === 'agent') {
    const agent = preview.agents.find((candidate) => candidate.agentId === props.agentId);
    const held = heldAccess(current[props.agentId]);
    const effective = agentHeldAccess(preview, props.agentId, Boolean(props.onAllowed));
    const covered = effective === level || (effective === 'read-write' && level === 'read');
    whoView = !agent ? (
      <p role="alert" className="text-destructive text-sm">
        This agent isn’t registered here, so it can’t get access.
      </p>
    ) : held === 'custom' ? (
      <p className="text-muted-foreground text-sm">
        {agent.displayName} already has exact actions here.{' '}
        {props.onEditExactActions
          ? 'Choose exact actions to change them.'
          : 'Change them on the Connections page.'}
      </p>
    ) : held === level ? (
      <p className="text-muted-foreground text-sm">{agent.displayName} can already do this.</p>
    ) : covered ? (
      <p className="text-muted-foreground text-sm">
        {agent.displayName} already can, like every agent.
      </p>
    ) : null;
  } else if (who === 'every') {
    whoView = null;
  } else if (preview.agents.length === 0) {
    whoView = <p className="text-muted-foreground text-sm">No agents yet. Add one first.</p>;
  } else {
    whoView = (
      <AgentChecklist
        preview={preview}
        serviceName={props.serviceName}
        preferredAgentIds={props.preferredAgentIds}
        systemAgentIds={systemAgentIds}
        picked={picked}
        setPicked={setPicked}
        decision={decision}
        showAll={showAll}
        setShowAll={setShowAll}
      />
    );
  }

  const agentMissing =
    props.mode === 'agent' && !preview.agents.some((agent) => agent.agentId === props.agentId);
  const agentCustom = props.mode === 'agent' && heldAccess(current[props.agentId]) === 'custom';

  return (
    <div className="space-y-4">
      {props.mode === 'page' && (
        <WhoCanUseChoice
          value={who}
          onChange={setWho}
          everyAgentAvailable={preview.everyAgent.available}
        />
      )}
      {props.mode === 'agent' && props.request && (
        <RequestedAccess
          agentName={
            preview.agents.find((agent) => agent.agentId === props.agentId)?.displayName ??
            'The agent'
          }
          serviceName={props.serviceName}
          request={props.request}
          level={level}
          writeOffer={writeOffer}
        />
      )}
      {whoView}
      {nothingToGrant ? (
        <p className="text-muted-foreground text-sm">
          {props.serviceName} has no actions for agents yet.
        </p>
      ) : (
        !agentMissing &&
        !agentCustom && (
          <div className="space-y-1.5">
            <p id={`${baseId}-level`} className="text-muted-foreground text-xs font-medium">
              {props.mode === 'page' ? 'They can' : 'It can'}
            </p>
            {levels.length > 1 ? (
              <SegmentedControl
                aria-labelledby={`${baseId}-level`}
                // Mixed: no segment is selected until the person picks one for everyone.
                value={level ?? ''}
                onValueChange={(next) => setLevel(next as CardAccessLevel)}
              >
                {levels.map((option) => (
                  <SegmentedControlItem key={option} value={option} className="min-h-9">
                    {LEVEL_LABELS[option]}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            ) : (
              <p className="text-sm">{LEVEL_LABELS[levels[0]]}</p>
            )}
            {props.mode === 'page' && writeOffer !== 'level' && (
              <p className="text-muted-foreground text-xs">
                Only Read is available for {props.serviceName}. DorkOS can’t make changes there yet.
              </p>
            )}
            {level === null && (
              <p className="text-muted-foreground text-xs">
                {who === 'every'
                  ? preview.everyAgent.operationRevisionIds.length > 0
                    ? 'Every agent has exact actions now. Pick a level to replace them.'
                    : 'Pick what every agent can do.'
                  : 'Your agents have different access. Pick one for every ticked agent.'}
              </p>
            )}
            {props.mode === 'page' && who === 'every' && (
              <EveryAgentWarning preview={preview} level={level} serviceName={props.serviceName} />
            )}
          </div>
        )
      )}
      {props.mode === 'page' && props.appActions && (
        <AppActions
          toolkit={props.appActions.toolkit}
          appName={props.serviceName}
          providerInstanceId={props.appActions.providerInstanceId}
          // The buckets come from this account's own snapshot, so they are
          // exactly what the picked level grants. With no level on offer
          // there is nothing to tie them to.
          grant={{ candidates: preview.candidates, level: nothingToGrant ? null : level }}
        />
      )}
      {(props.mode === 'page' || exactActionsLink) && (
        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
          {props.mode === 'page' && who === 'picked' && (
            <span>Others can still ask you in chat.</span>
          )}
          {exactActionsLink}
        </div>
      )}
    </div>
  );
}

/** Opens the account’s exact-action editor from either access surface. */
export function ExactActionsLink({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="link" size="xs" className="h-auto p-0" onClick={onClick}>
      Choose exact actions
    </Button>
  );
}
