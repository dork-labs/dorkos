import { useId, useMemo, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import { useConnectorConnections } from '@/layers/entities/connectors';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { cn } from '@/layers/shared/lib';
import {
  Badge,
  Button,
  Checkbox,
  Label,
  QueryErrorState,
  RadioGroup,
  RadioGroupItem,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
} from '@/layers/shared/ui';
import {
  cardGrantChanges,
  heldAccess,
  initialCardLevel,
  rankAgents,
  VISIBLE_AGENT_LIMIT,
  type CardAccessLevel,
} from '../lib/access-card-selection';
import { FALLBACK_SERVICE_ICON, SERVICE_ICONS } from '../lib/presentation';
import { revisionIdsForAccessLevel, selectionsFromPreview } from '../lib/reconciliation-selection';
import { useAccessReconciliation } from '../model/use-access-reconciliation';
import { AccessOutcome } from './AccessOutcome';

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

const LEVEL_LABELS: Record<CardAccessLevel, string> = {
  read: 'Read',
  'read-write': 'Read and write',
};

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
    return <AgentAccountChoice {...props} />;
  }
  return (
    <AccessStep key={props.connectionId} {...props} connectionId={props.connectionId as string} />
  );
}

function CardFrame({
  titleId,
  toolkit,
  title,
  subtitle,
  className,
  children,
}: {
  titleId: string;
  toolkit: string | undefined;
  title: string;
  subtitle?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const Icon = (toolkit ? SERVICE_ICONS[toolkit] : undefined) ?? FALLBACK_SERVICE_ICON;
  return (
    <section
      aria-labelledby={titleId}
      data-testid="connection-access-card"
      className={cn('bg-card space-y-4 rounded-xl border p-4', className)}
    >
      <header className="flex items-start gap-3">
        <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
          <Icon className="text-muted-foreground size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 id={titleId} className="text-sm font-semibold">
            {title}
          </h3>
          {subtitle && <div className="text-muted-foreground mt-0.5 text-xs">{subtitle}</div>}
        </div>
      </header>
      {children}
    </section>
  );
}

/** Fixed-agent mode without a known account: find it, and ask which one when there are two. */
function AgentAccountChoice(props: AgentAccessCardProps) {
  const titleId = useId();
  const query = useConnectorConnections();
  const accounts = (query.data?.connections ?? []).filter(
    (connection) => connection.toolkit === props.toolkit && connection.lifecycle !== 'disconnected'
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const only = accounts.length === 1 ? accounts[0].connectionId : null;
  const connectionId = only ?? chosen;
  if (connectionId) {
    return (
      <AccessStep
        key={connectionId}
        {...props}
        connectionId={connectionId}
        onChangeAccount={only ? undefined : () => setChosen(null)}
      />
    );
  }

  const title = `Which ${props.serviceName} account?`;
  return (
    <CardFrame titleId={titleId} toolkit={props.toolkit} title={title} className={props.className}>
      {query.isPending ? (
        <Skeleton className="h-16 rounded-lg" aria-label="Loading accounts" />
      ) : query.isError ? (
        <QueryErrorState
          title="Couldn’t load your accounts"
          description="Nothing changed. Try again."
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      ) : accounts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No {props.serviceName} account is connected yet.
        </p>
      ) : (
        <RadioGroup
          aria-labelledby={titleId}
          value={picked ?? ''}
          onValueChange={setPicked}
          className="gap-2"
        >
          {accounts.map((account) => {
            const id = `${titleId}-${account.connectionId}`;
            return (
              <div
                key={account.connectionId}
                className="bg-muted/40 flex min-h-11 items-center gap-3 rounded-lg px-3"
              >
                <RadioGroupItem id={id} value={account.connectionId} />
                <Label
                  htmlFor={id}
                  className="min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 py-2 leading-snug font-normal"
                >
                  <span className="block max-w-full truncate text-sm font-medium">
                    {account.label}
                  </span>
                  {account.identityHint && (
                    <span className="text-muted-foreground block max-w-full truncate text-xs">
                      {account.identityHint}
                    </span>
                  )}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {props.onSkip && (
          <Button variant="ghost" onClick={props.onSkip}>
            Not now
          </Button>
        )}
        {accounts.length > 1 && (
          <Button disabled={!picked} onClick={() => setChosen(picked)}>
            Continue
          </Button>
        )}
      </div>
    </CardFrame>
  );
}

/** Who the saved change reaches, for the confirmed-save line. */
function savedSummary(
  props: ConnectionAccessCardProps,
  preview: ConnectorReconciliationPreview,
  picked: ReadonlySet<string>,
  level: CardAccessLevel
): string {
  if (props.mode === 'agent') {
    const name =
      preview.agents.find((agent) => agent.agentId === props.agentId)?.displayName ?? 'The agent';
    return level === 'read'
      ? `${name} can read ${props.serviceName}.`
      : `${name} can read and write in ${props.serviceName}.`;
  }
  const names = preview.agents
    .filter((agent) => picked.has(agent.agentId))
    .map((agent) => agent.displayName);
  if (names.length === 0) return `No agent can use ${props.serviceName}.`;
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} can use ${props.serviceName}.`;
}

/** The access question for one known account. */
function AccessStep(
  props: ConnectionAccessCardProps & { connectionId: string; onChangeAccount?: () => void }
) {
  const titleId = useId();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState<CardAccessLevel>('read');
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

  const changes = useMemo(
    () =>
      preview
        ? cardGrantChanges(preview, picked, level, props.mode === 'agent' || levelTouched)
        : [],
    [preview, picked, level, levelTouched, props.mode]
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
    <CardFrame
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
        <QueryErrorState
          title="Couldn’t load who can use it"
          description="Nothing changed. Try loading the current access again."
          onRetry={access.refresh}
          isRetrying={access.isLoading}
        />
      ) : outcome ? (
        <AccessOutcome
          access={access}
          savedDetail={preview ? savedSummary(props, preview, picked, level) : undefined}
        />
      ) : preview ? (
        <AccessEditor
          props={props}
          preview={preview}
          picked={picked}
          setPicked={setPicked}
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
        {outcome
          ? props.onFinished && (
              <Button variant={access.saved ? 'default' : 'ghost'} onClick={props.onFinished}>
                {access.saved ? 'Done' : 'Close'}
              </Button>
            )
          : preview && (
              <>
                {props.onSkip && (
                  <Button variant="ghost" onClick={props.onSkip}>
                    {props.mode === 'page' ? 'Skip' : 'Not now'}
                  </Button>
                )}
                <Button
                  onClick={() => access.apply(changes)}
                  disabled={changes.length === 0 || access.isSaving}
                >
                  {access.isSaving ? 'Saving…' : props.mode === 'page' ? 'Save' : 'Allow'}
                </Button>
              </>
            )}
      </div>
    </CardFrame>
  );
}

function AccessEditor({
  props,
  preview,
  picked,
  setPicked,
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
  level: CardAccessLevel;
  setLevel: (next: CardAccessLevel) => void;
  showAll: boolean;
  setShowAll: (next: boolean) => void;
  systemAgentIds: string[];
}) {
  const baseId = useId();
  const current = selectionsFromPreview(preview);
  const readIds = revisionIdsForAccessLevel(preview.candidates, 'read');
  const readWriteIds = revisionIdsForAccessLevel(preview.candidates, 'read-write');
  const levels: CardAccessLevel[] =
    readWriteIds.length > readIds.length ? ['read', 'read-write'] : ['read'];
  const nothingToGrant = readWriteIds.length === 0;

  const exactActionsLink = props.onEditExactActions && (
    <Button
      variant="link"
      size="xs"
      className="h-auto p-0"
      onClick={() => props.onEditExactActions?.(props.connectionId)}
    >
      Choose exact actions
    </Button>
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
    const ranked = rankAgents(preview, {
      preferredAgentIds: props.preferredAgentIds,
      systemAgentIds,
    });
    const visible = showAll
      ? ranked
      : ranked.filter((agent, index) => index < VISIBLE_AGENT_LIMIT || picked.has(agent.agentId));
    who = (
      <fieldset className="space-y-1">
        <legend className="sr-only">Agents that can use {props.serviceName}</legend>
        {visible.map((agent) => {
          const id = `${baseId}-${agent.agentId}`;
          const custom = heldAccess(preview.candidates, current[agent.agentId] ?? []) === 'custom';
          return (
            <div
              key={agent.agentId}
              className="hover:bg-muted/60 flex min-h-11 items-center gap-3 rounded-md px-2"
            >
              <Checkbox
                id={id}
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
              {custom && (
                <Badge size="xs" variant="secondary">
                  Exact actions
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
                value={level}
                onValueChange={(next) => setLevel(next as CardAccessLevel)}
              >
                {levels.map((option) => (
                  <SegmentedControlItem key={option} value={option} className="min-h-9">
                    {LEVEL_LABELS[option]}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            ) : (
              <p className="text-sm">Read</p>
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
