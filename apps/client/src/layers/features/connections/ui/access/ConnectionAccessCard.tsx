import { useId, useMemo, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import {
  Button,
  QueryErrorState,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
} from '@/layers/shared/ui';
import {
  cardDecision,
  heldAccess,
  initialCardLevel,
  type CardAccessLevel,
  type CardDecision,
} from '../../lib/access-card-selection';
import {
  revisionIdsForAccessLevel,
  selectionsFromPreview,
} from '../../lib/reconciliation-selection';
import { useAccessReconciliation } from '../../model/use-access-reconciliation';
import { AccessCardFrame } from './AccessCardFrame';
import { AccessOutcome } from './AccessOutcome';
import { AccountChoice } from './AccountChoice';
import { AgentChecklist } from './AgentChecklist';
import { joinNames, LEVEL_LABELS } from './access-labels';

interface SharedCardProps {
  /** The app's display name, e.g. "Gmail". */
  serviceName: string;
  /** Leave without changing anything. Labelled "Skip" on the page and "Not now" for one agent. */
  onSkip?: () => void;
  /** Leave after a save has an outcome. Labelled "Done" once confirmed, "Close" otherwise. */
  onFinished?: () => void;
  /** Open the exact per-action editor for this account. Hidden when omitted. */
  onEditExactActions?: (connectionId: string) => void;
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

/** Who the saved change reaches, including anyone who lost access, for the confirmed-save line. */
function savedSummary(
  props: ConnectionAccessCardProps,
  preview: ConnectorReconciliationPreview,
  picked: ReadonlySet<string>,
  level: CardAccessLevel | null,
  decision: CardDecision
): string {
  const nameOf = (agentId: string) =>
    preview.agents.find((agent) => agent.agentId === agentId)?.displayName ?? 'The agent';
  if (props.mode === 'agent') {
    const name = nameOf(props.agentId);
    return level === 'read-write'
      ? `${name} can read and write in ${props.serviceName}.`
      : `${name} can read ${props.serviceName}.`;
  }
  const kept = preview.agents
    .filter((agent) => picked.has(agent.agentId))
    .map((agent) => agent.displayName);
  const removed = decision.removedAgentIds.map(nameOf);
  const lines = [
    kept.length > 0
      ? `${joinNames(kept)} can use ${props.serviceName}.`
      : `No agent can use ${props.serviceName}.`,
  ];
  const downgraded = decision.downgradedAgentIds.map(nameOf);
  if (downgraded.length > 0) lines.push(`${joinNames(downgraded)} can now only read.`);
  if (removed.length > 0) lines.push(`${joinNames(removed)} can no longer use it.`);
  return lines.join(' ');
}

/** The access question for one known account. */
function AccessStep(
  props: ConnectionAccessCardProps & { connectionId: string; onChangeAccount?: () => void }
) {
  const titleId = useId();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState<CardAccessLevel | null>('read');
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
      setLevel(
        initialCardLevel(
          subjects.map((agentId) => heldAccess(preview.candidates, current[agentId] ?? []))
        )
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
            scope: fixedAgentId ? [fixedAgentId] : preview.agents.map((agent) => agent.agentId),
            picked,
            level,
            levelTouched: fixedAgentId !== null || levelTouched,
            // A chat answer can only raise an agent's access, never lower it.
            allowDowngrade: fixedAgentId === null,
          })
        : { changes: [], removedAgentIds: [], downgradedAgentIds: [], needsLevel: false },
    [preview, picked, level, levelTouched, fixedAgentId]
  );

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
      title={title}
      subtitle={subtitle}
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
          {props.onEditExactActions && (
            <ExactActionsLink onClick={() => props.onEditExactActions?.(props.connectionId)} />
          )}
        </div>
      ) : outcome ? (
        <AccessOutcome
          access={access}
          savedDetail={preview ? savedSummary(props, preview, picked, level, decision) : undefined}
        />
      ) : preview ? (
        <AccessEditor
          props={props}
          preview={preview}
          picked={picked}
          setPicked={setPicked}
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
                onClick={() => access.apply(decision.changes)}
                disabled={decision.changes.length === 0 || decision.needsLevel || access.isSaving}
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
    heldAccess(preview.candidates, current[props.agentId] ?? []) === 'read-write'
      ? offered.filter((option) => option === 'read-write')
      : offered;
  const nothingToGrant = readWriteIds.length === 0;

  const exactActionsLink = props.onEditExactActions && (
    <ExactActionsLink onClick={() => props.onEditExactActions?.(props.connectionId)} />
  );

  let who: ReactNode;
  if (props.mode === 'agent') {
    const agent = preview.agents.find((candidate) => candidate.agentId === props.agentId);
    const held = heldAccess(preview.candidates, current[props.agentId] ?? []);
    who = !agent ? (
      <p role="alert" className="text-destructive text-sm">
        This agent isn’t registered on this computer, so it can’t be given access.
      </p>
    ) : held === 'custom' ? (
      <p className="text-muted-foreground text-sm">
        {agent.displayName} already has exact actions chosen for this account. Change them there.
      </p>
    ) : held === level ? (
      <p className="text-muted-foreground text-sm">{agent.displayName} can already do this.</p>
    ) : null;
  } else if (preview.agents.length === 0) {
    who = (
      <p className="text-muted-foreground text-sm">
        You don’t have any agents yet. Add one, then choose who can use {props.serviceName}.
      </p>
    );
  } else {
    who = (
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
      {who}
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
                Your agents have different access. Pick one to give it to every ticked agent.
              </p>
            )}
          </div>
        )
      )}
      {(props.mode === 'page' || exactActionsLink) && (
        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
          {props.mode === 'page' && <span>Agents you leave out can still ask you in chat.</span>}
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
