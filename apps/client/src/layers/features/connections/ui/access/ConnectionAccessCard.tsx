import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import type { ServiceLogo } from '@/layers/entities/connectors';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import {
  Button,
  QueryErrorState,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
} from '@/layers/shared/ui';
import {
  agentHeldAccess,
  cardDecision,
  everyAgentDecision,
  heldAccess,
  initialCardLevel,
  levelForRequest,
  initialEveryAgentLevel,
  initialWhoCanUse,
  type CardAccessLevel,
  type CardDecision,
  type EveryAgentDecision,
  type WhoCanUse,
} from '../../lib/access-card-selection';
import {
  revisionIdsForAccessLevel,
  selectionsFromPreview,
} from '../../lib/reconciliation-selection';
import { useAccessReconciliation } from '../../model/use-access-reconciliation';
import { AppActions } from '../AppActions';
import { AccessCardFrame, type AccessCardVariant } from './AccessCardFrame';
import { AccessOutcome } from './AccessOutcome';
import { AccountChoice } from './AccountChoice';
import { AgentChecklist } from './AgentChecklist';
import { LEVEL_LABELS } from './access-labels';
import { EveryAgentWarning } from './EveryAgentWarning';
import { RequestedActions } from './RequestedActions';
import { savedSummary } from './saved-summary';
import { StopSharingFallback } from './StopSharingFallback';
import { WhoCanUseChoice } from './WhoCanUseChoice';

interface SharedCardProps {
  /** The app's display name, e.g. "Gmail". */
  serviceName: string;
  /** What the catalog says about the app's logo, when the caller has its entry. */
  logo?: ServiceLogo;
  /** Leave without changing anything. Labelled "Skip" on the page and "Not now" for one agent. */
  onSkip?: () => void;
  /** Leave after a save has an outcome. Labelled "Done" once confirmed, "Close" otherwise. */
  onFinished?: () => void;
  /** Open the exact per-action editor for this account. Hidden when omitted. */
  onEditExactActions?: (connectionId: string) => void;
  /** A framed card of its own, or one section of a panel (see {@link AccessCardVariant}). */
  variant?: AccessCardVariant;
  /** Extra classes for the card's outer frame. */
  className?: string;
}

/**
 * The page's planning question: pick which agents can use one account.
 *
 * The agent checklist is the "Only agents I pick" answer. An "Every agent"
 * answer (DOR-2420) sits beside it as a sibling choice above the checklist;
 * the level switch and the save path below do not change for it.
 */
export interface PageAccessCardProps extends SharedCardProps {
  /** Pick agents for one connected account. */
  mode: 'page';
  /** The connected account whose access is chosen. */
  connectionId: string;
  /** Agents the caller knows are relevant right now; listed first after agents with access. */
  preferredAgentIds?: string[];
  /**
   * Show what the picked level lets agents do in this app, right under the
   * level switch (the app's side panel). Hidden when omitted.
   */
  appActions?: { toolkit: string; providerInstanceId: string };
}

/** The chat's question: may this one agent use the app? It never offers "every agent". */
export interface AgentAccessCardProps extends SharedCardProps {
  /** Answer for one fixed agent. */
  mode: 'agent';
  /** The agent asking. */
  agentId: string;
  /** The app's slug; with two connected accounts of it, the card asks which one first. */
  toolkit: string;
  /** A known account; skips the account question. */
  connectionId?: string;
  /**
   * Called once this agent's access is live on an account: after a save the
   * server confirmed and finished applying, or straight away when the agent
   * already holds what is picked. The chat card answers the agent's request
   * with it. When set, "Allow" stays pressable for an agent that can already
   * do this, since the question still needs an answer.
   */
  onAllowed?: (connectionId: string) => void;
  /**
   * What the agent asked for, when a request opened the card: the level starts
   * on the one that covers it, and the card shows the reason and the actions
   * asked for, and says plainly what a level leaves out.
   */
  request?: { readonly reason: string; readonly operations: readonly string[] };
}

/** Props for {@link ConnectionAccessCard}. */
export type ConnectionAccessCardProps = PageAccessCardProps | AgentAccessCardProps;

/**
 * "Who can use this app, and what can they do?" as one card, shared by the
 * chat (one fixed agent) and the Connections page (pick agents).
 *
 * It offers two levels, Read and Read and write, which map exactly onto the
 * presets the exact access editor uses, and saves through the same
 * reconciliation boundary. Exact per-action picks stay in that editor. An
 * agent that already has exact per-action access keeps it untouched.
 */
export function ConnectionAccessCard(props: ConnectionAccessCardProps) {
  if (props.mode === 'agent' && !props.connectionId) {
    return (
      <AccountChoice
        props={props}
        renderAccess={(connectionId, onChangeAccount) => (
          <AccessStep
            key={connectionId}
            {...props}
            connectionId={connectionId}
            onChangeAccount={onChangeAccount}
          />
        )}
      />
    );
  }
  return (
    <AccessStep key={props.connectionId} {...props} connectionId={props.connectionId as string} />
  );
}

/** The access question for one known account. */
function AccessStep(
  props: ConnectionAccessCardProps & { connectionId: string; onChangeAccount?: () => void }
) {
  const titleId = useId();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState<CardAccessLevel | null>('read');
  const [who, setWho] = useState<WhoCanUse>('picked');
  const [levelTouched, setLevelTouched] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { data: meshAgents } = useRegisteredAgents(undefined, props.mode === 'page');
  // A save that can't be confirmed discards the snapshot; the card still names the account.
  const [connection, setConnection] = useState<ConnectorReconciliationPreview['connection'] | null>(
    null
  );

  const access = useAccessReconciliation({
    connectionId: props.connectionId,
    active: true,
    onPreview: (preview) => {
      setConnection(preview.connection);
      const current = selectionsFromPreview(preview);
      const subjects =
        props.mode === 'agent'
          ? [props.agentId]
          : preview.agents
              .map((agent) => agent.agentId)
              .filter((agentId) => (current[agentId] ?? []).length > 0);
      setPicked(new Set(props.mode === 'agent' ? [props.agentId] : subjects));
      // The chat's one-agent card never offers "every agent" (DOR-2420).
      const startWho = props.mode === 'page' ? initialWhoCanUse(preview) : 'picked';
      setWho(startWho);
      const heldLevel =
        startWho === 'every'
          ? initialEveryAgentLevel(preview)
          : props.mode === 'agent'
            ? // Counts an "Every agent" grant: the question is what THIS agent can do.
              initialCardLevel([agentHeldAccess(preview, props.agentId, Boolean(props.onAllowed))])
            : initialCardLevel(
                subjects.map((agentId) => heldAccess(preview.candidates, current[agentId] ?? []))
              );
      // A request starts on the level that covers what the agent asked for, and
      // never below what it already holds.
      const asked =
        props.mode === 'agent' && props.request
          ? levelForRequest(preview.candidates, props.request.operations).level
          : null;
      setLevel(asked === 'read-write' || heldLevel === 'read-write' ? 'read-write' : heldLevel);
      setLevelTouched(false);
    },
  });
  const { preview } = access;

  const fixedAgentId = props.mode === 'agent' ? props.agentId : null;
  const decision = useMemo<CardDecision>(
    () =>
      preview
        ? cardDecision(preview, {
            // One-agent mode decides for that agent only; nobody else is ever written.
            // "Every agent" hides the checklist, so it writes no named agent either.
            scope: fixedAgentId
              ? [fixedAgentId]
              : who === 'every'
                ? []
                : preview.agents.map((agent) => agent.agentId),
            picked,
            level,
            levelTouched: fixedAgentId !== null || levelTouched,
            // A chat answer can only raise an agent's access, never lower it.
            allowDowngrade: fixedAgentId === null,
          })
        : { changes: [], removedAgentIds: [], downgradedAgentIds: [], needsLevel: false },
    [preview, picked, level, levelTouched, fixedAgentId, who]
  );
  const every = useMemo<EveryAgentDecision>(
    () =>
      preview && fixedAgentId === null
        ? everyAgentDecision(preview, { who, level, levelTouched })
        : { needsLevel: false },
    [preview, fixedAgentId, who, level, levelTouched]
  );

  // What the agent can do today, its own grant and "Every agent" together.
  const heldNow =
    preview && fixedAgentId
      ? agentHeldAccess(preview, fixedAgentId, props.mode === 'agent' && Boolean(props.onAllowed))
      : 'none';
  const onAllowed = props.mode === 'agent' ? props.onAllowed : undefined;
  // Nothing to write, but the agent already holds access here: Allow answers
  // with it rather than sitting disabled over a question that needs an answer.
  const allowAsHeld =
    onAllowed !== undefined &&
    preview !== undefined &&
    // Nothing to write, or the picked level is already covered (through
    // "Every agent", say), so writing a grant of its own would add nothing.
    (decision.changes.length === 0 || heldNow === level || heldNow === 'read-write') &&
    !decision.needsLevel &&
    heldNow !== 'none' &&
    preview.agents.some((agent) => agent.agentId === fixedAgentId);
  const allowedReported = useRef(false);
  useEffect(() => {
    if (!access.saved || !onAllowed || allowedReported.current) return;
    allowedReported.current = true;
    onAllowed(props.connectionId);
    // Keyed on the outcome itself, not on `saved`: every answer the server
    // gives re-checks, so only a confirmed, applied save ever reports.
  }, [access.saveOutcome, access.saved, onAllowed, props.connectionId]);

  const agentName =
    props.mode === 'agent'
      ? preview?.agents.find((agent) => agent.agentId === props.agentId)?.displayName
      : undefined;
  const title =
    props.mode === 'page'
      ? `Who can use ${props.serviceName}?`
      : `Let ${agentName ?? 'this agent'} use ${props.serviceName}?`;

  const outcome = access.needsRefresh || access.saveOutcome !== null;
  const subtitle = (connection || props.onChangeAccount) && (
    <span className="flex flex-wrap items-center gap-x-2">
      {connection && <span className="truncate">{connection.label}</span>}
      {props.onChangeAccount && !outcome && (
        <Button variant="link" size="xs" className="h-auto p-0" onClick={props.onChangeAccount}>
          Change account
        </Button>
      )}
    </span>
  );

  return (
    <AccessCardFrame
      titleId={titleId}
      toolkit={connection?.toolkit ?? (props.mode === 'agent' ? props.toolkit : undefined)}
      serviceName={props.serviceName}
      logo={props.logo}
      title={title}
      // Embedded in a panel that already names the account, the line would repeat it.
      subtitle={props.variant === 'embedded' ? undefined : subtitle}
      variant={props.variant}
      className={props.className}
    >
      {access.isLoading ? (
        <div className="space-y-2" aria-label="Loading access">
          <Skeleton className="h-10 rounded-lg" />
          <Skeleton className="h-8 rounded-lg" />
        </div>
      ) : access.loadFailed ? (
        <div className="space-y-2">
          <QueryErrorState
            title="Couldn’t load who can use it"
            description="Nothing changed. Try loading the current access again."
            onRetry={access.refresh}
            isRetrying={access.isLoading}
          />
          {props.mode === 'page' && (
            <StopSharingFallback
              connectionId={props.connectionId}
              serviceName={props.serviceName}
            />
          )}
          {props.onEditExactActions && (
            <ExactActionsLink onClick={() => props.onEditExactActions?.(props.connectionId)} />
          )}
        </div>
      ) : outcome ? (
        <AccessOutcome
          access={access}
          savedDetail={
            preview
              ? savedSummary({
                  mode: props.mode,
                  ...(props.mode === 'agent' && { agentId: props.agentId }),
                  serviceName: props.serviceName,
                  preview,
                  picked,
                  level,
                  decision,
                  who,
                  every,
                })
              : undefined
          }
        />
      ) : preview ? (
        <AccessEditor
          props={props}
          preview={preview}
          picked={picked}
          setPicked={setPicked}
          who={who}
          setWho={setWho}
          decision={decision}
          level={level}
          setLevel={(next) => {
            setLevel(next);
            setLevelTouched(true);
          }}
          showAll={showAll}
          setShowAll={setShowAll}
          systemAgentIds={(meshAgents?.agents ?? [])
            .filter((agent) => agent.isSystem)
            .map((agent) => agent.id)}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {access.needsReconciliation ? (
          <Button variant="secondary" onClick={access.refresh}>
            Reload current access
          </Button>
        ) : access.saveOutcome && !access.saved ? (
          <Button variant="secondary" onClick={access.checkSync} disabled={access.isCheckingSync}>
            <RefreshCw className="size-4" aria-hidden />
            {access.isCheckingSync ? 'Checking…' : 'Check sync status'}
          </Button>
        ) : null}
        {outcome ? (
          props.onFinished ? (
            <Button variant={access.saved ? 'default' : 'ghost'} onClick={props.onFinished}>
              {access.saved ? 'Done' : 'Close'}
            </Button>
          ) : (
            access.saveOutcome && (
              // A card with nowhere to go (a panel, not a dialog) returns to
              // the question, reading the current access fresh.
              <Button variant="ghost" onClick={access.refresh}>
                Edit again
              </Button>
            )
          )
        ) : (
          preview && (
            <>
              {props.onSkip && (
                <Button variant="ghost" onClick={props.onSkip}>
                  {props.mode === 'page' ? 'Skip' : 'Not now'}
                </Button>
              )}
              <Button
                onClick={() =>
                  allowAsHeld
                    ? onAllowed?.(props.connectionId)
                    : access.apply(decision.changes, every.everyAgent)
                }
                disabled={
                  !allowAsHeld &&
                  ((decision.changes.length === 0 && !every.everyAgent) ||
                    decision.needsLevel ||
                    every.needsLevel ||
                    access.isSaving)
                }
              >
                {access.isSaving ? 'Saving…' : props.mode === 'page' ? 'Save' : 'Allow'}
              </Button>
            </>
          )
        )}
      </div>
    </AccessCardFrame>
  );
}

function AccessEditor({
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
  const readIds = revisionIdsForAccessLevel(preview.candidates, 'read');
  const readWriteIds = revisionIdsForAccessLevel(preview.candidates, 'read-write');
  const offered: CardAccessLevel[] =
    readWriteIds.length > readIds.length ? ['read', 'read-write'] : ['read'];
  // The chat's one-agent answer only offers levels at or above what it holds.
  const levels =
    props.mode === 'agent' &&
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
    const held = heldAccess(preview.candidates, current[props.agentId] ?? []);
    const effective = agentHeldAccess(preview, props.agentId, Boolean(props.onAllowed));
    const covered = effective === level || (effective === 'read-write' && level === 'read');
    whoView = !agent ? (
      <p role="alert" className="text-destructive text-sm">
        This agent isn’t registered on this computer, so it can’t be given access.
      </p>
    ) : held === 'custom' ? (
      <p className="text-muted-foreground text-sm">
        {agent.displayName} already has exact actions chosen for this account. Change them there.
      </p>
    ) : held === level ? (
      <p className="text-muted-foreground text-sm">{agent.displayName} can already do this.</p>
    ) : covered ? (
      <p className="text-muted-foreground text-sm">
        {agent.displayName} can already do this, because every agent can.
      </p>
    ) : null;
  } else if (who === 'every') {
    whoView = null;
  } else if (preview.agents.length === 0) {
    whoView = (
      <p className="text-muted-foreground text-sm">
        You don’t have any agents yet. Add one, then choose who can use {props.serviceName}.
      </p>
    );
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
  const agentCustom =
    props.mode === 'agent' &&
    heldAccess(preview.candidates, current[props.agentId] ?? []) === 'custom';

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
        <RequestedActions
          agentName={
            preview.agents.find((agent) => agent.agentId === props.agentId)?.displayName ??
            'The agent'
          }
          toolkit={props.toolkit}
          reason={props.request.reason}
          operations={props.request.operations}
          candidates={preview.candidates}
          level={level}
        />
      )}
      {whoView}
      {nothingToGrant ? (
        <p className="text-muted-foreground text-sm">
          {props.serviceName} has no actions agents can use yet.
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
            {level === null && (
              <p className="text-muted-foreground text-xs">
                {who === 'every'
                  ? preview.everyAgent.operationRevisionIds.length > 0
                    ? 'Every agent has exact actions chosen now. Pick a level to replace them.'
                    : 'Pick what every agent can do.'
                  : 'Your agents have different access. Pick one to give it to every ticked agent.'}
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
            <span>Agents you leave out can still ask you in chat.</span>
          )}
          {exactActionsLink}
        </div>
      )}
    </div>
  );
}

function ExactActionsLink({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="link" size="xs" className="h-auto p-0" onClick={onClick}>
      Choose exact actions
    </Button>
  );
}
