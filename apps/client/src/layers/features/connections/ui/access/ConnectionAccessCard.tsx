import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import type { ServiceLogo } from '@/layers/entities/connectors';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { Button, Skeleton } from '@/layers/shared/ui';
import {
  agentHeldAccess,
  cardDecision,
  everyAgentDecision,
  heldAccess,
  initialCardLevel,
  initialEveryAgentLevel,
  initialWhoCanUse,
  type CardAccessLevel,
  type CardDecision,
  type EveryAgentDecision,
  type WhoCanUse,
} from '../../lib/access-card-selection';
import { requestedWriteOffer } from '../../lib/access-level-offer';
import { selectionsFromPreview } from '../../lib/reconciliation-selection';
import { useAccessReconciliation } from '../../model/use-access-reconciliation';
import { LoadFailedState } from '../LoadFailedState';
import { AccessCardFrame, type AccessCardVariant } from './AccessCardFrame';
import { AccessEditor, ExactActionsLink } from './AccessEditor';
import { AccessOutcome } from './AccessOutcome';
import { AccountChoice } from './AccountChoice';
import { savedSummary } from './saved-summary';
import { StopSharingFallback } from './StopSharingFallback';

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
 * The agent checklist is the "Only agents you pick" answer. An "Every agent"
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
   * Start "Who can use it?" on this answer instead of the account's own, the
   * first time the card loads (the trust notice's Choose agents). Nothing
   * changes until Save.
   */
  startWho?: WhoCanUse;
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
   * on the one it asked for, and the card shows the reason and the level
   * asked for, and says plainly what a lower pick leaves out.
   */
  request?: { readonly reason: string; readonly access: CardAccessLevel };
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
  // Read once: a later refresh (after Save) shows what was saved.
  const requestedWho = useRef(props.mode === 'page' ? props.startWho : undefined);
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
              .filter((agentId) => heldAccess(current[agentId]) !== 'none');
      setPicked(new Set(props.mode === 'agent' ? [props.agentId] : subjects));
      // The chat's one-agent card never offers "every agent" (DOR-2420).
      const startWho =
        props.mode === 'page' ? (requestedWho.current ?? initialWhoCanUse(preview)) : 'picked';
      requestedWho.current = undefined;
      setWho(startWho);
      const heldLevel =
        startWho === 'every'
          ? initialEveryAgentLevel(preview)
          : props.mode === 'agent'
            ? // Counts an "Every agent" grant: the question is what THIS agent can do.
              initialCardLevel([agentHeldAccess(preview, props.agentId, Boolean(props.onAllowed))])
            : initialCardLevel(subjects.map((agentId) => heldAccess(current[agentId])));
      // Start on the requested or held level when available. An app whose
      // write level adds nothing starts on Read, matching what the card shows.
      const asked = props.mode === 'agent' && props.request ? props.request.access : null;
      const requestedLevel =
        asked === 'read-write' || heldLevel === 'read-write' ? 'read-write' : heldLevel;
      setLevel(
        requestedLevel === 'read-write' && requestedWriteOffer(preview.candidates) !== 'level'
          ? 'read'
          : requestedLevel
      );
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
          <LoadFailedState
            error={access.loadError}
            title="Couldn’t load who can use it"
            description="Nothing changed. Try again."
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

      {/* Another agent can approve Read, never more, so a request for write access is always the
          person's to answer: said once, quietly, just above the buttons it is about (DOR-3959). */}
      {props.mode === 'agent' && props.request?.access === 'read-write' && preview && !outcome && (
        <p data-testid="agent-request-write-note" className="text-muted-foreground text-xs">
          Write access needs you.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {access.needsReconciliation ? (
          <Button variant="secondary" onClick={access.refresh}>
            Reload current access
          </Button>
        ) : access.saveOutcome && !access.saved ? (
          <Button variant="secondary" onClick={access.checkSync} disabled={access.isCheckingSync}>
            <RefreshCw className="size-4" aria-hidden />
            {access.isCheckingSync ? 'Checking…' : 'Check if it’s done'}
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
