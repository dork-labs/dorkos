import { useState, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import type {
  ConnectorConnectionDetail,
  ConnectorLifecycleResult,
} from '@dorkos/shared/connector-resource-schemas';
import {
  useConnectorCatalog,
  useConnectorConnection,
  useConnectorUsage,
  useDisconnectConnectorConnection,
  usePauseConnectorConnection,
  useReconnectConnectorConnection,
  useRemoveConnectorConnection,
  useResumeConnectorConnection,
} from '@/layers/entities/connectors';
import { useMeshAgentPaths, useRegisteredAgents } from '@/layers/entities/mesh';
import { formatRelativeTime, getAgentDisplayName, toSession } from '@/layers/shared/lib';
import { useSafeNavigate } from '@/layers/shared/model';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  QueryErrorState,
  Skeleton,
} from '@/layers/shared/ui';
import { accountAppName } from '../../lib/app-list';
import { retryLine, tryItPrompts, usageLine } from '../../lib/app-panel-copy';
import { ConnectionAccessCard } from '../access/ConnectionAccessCard';
import { AccountPanelMore } from './AccountPanelMore';
import { PanelFix, PanelSection } from './panel-parts';

/** How many recent actions show before "See all". */
const RECENT_LIMIT = 3;

/** Props for {@link AccountPanel}. */
export interface AccountPanelProps {
  /** The connected account the panel is about. */
  connectionId: string;
  /** A sign-in started for this account; the page opens it. */
  onSignInStarted: (flowId: string) => void;
  /** Open the exact per-action editor for this account. */
  onEditExactActions: (connectionId: string) => void;
  /** Start connecting another account of the same app. */
  onAddAnother: (toolkit: string) => void;
  /** Close the panel (after the account is disconnected or removed). */
  onClose: () => void;
}

/**
 * An app account's side panel (design record §5). Up top, only what you came
 * for: who can use it, what they have done lately, and a few things to try.
 * Everything else (its name, new-event notifications, exact actions, pause,
 * how it's connected, disconnect) is folded under "More".
 *
 * A broken account puts its one fix on top; nothing else moves.
 */
export function AccountPanel(props: AccountPanelProps) {
  const detail = useConnectorConnection(props.connectionId);
  if (detail.isPending) {
    return (
      <div className="space-y-3" aria-label="Loading app details">
        <Skeleton className="h-28 rounded-lg" />
        <Skeleton className="h-20 rounded-lg" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <QueryErrorState
        title="Couldn’t load this app"
        description="Try again. Nothing about it was changed."
        onRetry={() => void detail.refetch()}
        isRetrying={detail.isFetching}
      />
    );
  }
  return <AccountPanelBody {...props} detail={detail.data} />;
}

function AccountPanelBody({
  connectionId,
  detail,
  onSignInStarted,
  onEditExactActions,
  onAddAnother,
  onClose,
}: AccountPanelProps & { detail: ConnectorConnectionDetail }) {
  const { connection } = detail;
  const catalog = useConnectorCatalog('');
  const services = new Map(
    (catalog.data?.pages.flatMap((page) => page.services) ?? []).map((service) => [
      service.serviceSlug,
      service,
    ])
  );
  const appName = accountAppName(connection.toolkit, services);
  const reconnect = useReconnectConnectorConnection();
  const pause = usePauseConnectorConnection();
  const resume = useResumeConnectorConnection();
  const disconnect = useDisconnectConnectorConnection();
  const remove = useRemoveConnectorConnection();
  const mutationError =
    reconnect.error ?? pause.error ?? resume.error ?? disconnect.error ?? remove.error;

  const signInAgain = () =>
    reconnect.mutate({ connectionId }, { onSuccess: (result) => onSignInStarted(result.flowId) });
  const disconnected = connection.lifecycle === 'disconnected';
  const signedOut =
    connection.authenticationStatus === 'expired' ||
    connection.authenticationStatus === 'revoked' ||
    connection.authenticationStatus === 'pending';
  const usable =
    connection.lifecycle === 'connected' &&
    connection.authenticationStatus === 'active' &&
    connection.authoritySync.status !== 'failed';

  return (
    <div className="space-y-7">
      {disconnected ? (
        <DisconnectedFix
          detail={detail}
          appName={appName}
          onSignInAgain={signInAgain}
          reconnecting={reconnect.isPending}
          onRemove={() =>
            remove.mutate({ connectionId, input: undefined }, { onSuccess: () => onClose() })
          }
          removing={remove.isPending}
          onFinishDisconnecting={() => disconnect.mutate({ connectionId, input: undefined })}
          finishing={disconnect.isPending}
          lastTry={disconnect.data}
        />
      ) : connection.lifecycle === 'paused' ? (
        <PanelFix
          message={`Paused. Agents can’t use ${appName} until you resume it.`}
          action="Resume"
          pending={resume.isPending}
          onAction={() => resume.mutate({ connectionId, input: undefined })}
        />
      ) : signedOut ? (
        <PanelFix
          message={
            connection.authenticationStatus === 'pending'
              ? `Sign-in didn’t finish. Agents can’t use ${appName} yet.`
              : `Signed out. Agents can’t use ${appName}.`
          }
          action="Sign in again"
          pending={reconnect.isPending}
          onAction={signInAgain}
        />
      ) : connection.authoritySync.status === 'failed' ? (
        <PanelFix
          message={`Couldn’t update who can use ${appName}. ${connection.authoritySync.reason}`}
          action="Check exact actions"
          onAction={() => onEditExactActions(connectionId)}
        />
      ) : connection.reconciliationStatus !== 'ready' ? (
        <PanelFix
          message={`Some of ${appName}’s actions changed. Check who can use them.`}
          action="Review"
          onAction={() => onEditExactActions(connectionId)}
        />
      ) : null}

      {mutationError && (
        <p role="alert" className="text-destructive bg-destructive/5 rounded-lg p-3 text-sm">
          {accountChangeError(mutationError)}
        </p>
      )}

      {!disconnected && (
        <ConnectionAccessCard
          mode="page"
          variant="embedded"
          connectionId={connectionId}
          serviceName={appName}
          onEditExactActions={onEditExactActions}
        />
      )}

      <Recently detail={detail} />

      {usable && <TryIt detail={detail} />}

      <AccountPanelMore
        detail={detail}
        onSignInAgain={signInAgain}
        signingIn={reconnect.isPending}
        appName={appName}
        onEditExactActions={onEditExactActions}
        onAddAnother={onAddAnother}
        onClose={onClose}
      />
    </div>
  );
}

/** The fix for a disconnected account: connect it again, or take it off the list. */
function DisconnectedFix({
  detail,
  appName,
  onSignInAgain,
  reconnecting,
  onRemove,
  removing,
  onFinishDisconnecting,
  finishing,
  lastTry,
}: {
  detail: ConnectorConnectionDetail;
  appName: string;
  onSignInAgain: () => void;
  reconnecting: boolean;
  onRemove: () => void;
  removing: boolean;
  onFinishDisconnecting: () => void;
  finishing: boolean;
  /** What the last "Finish disconnecting" in this panel came back with, if it ran. */
  lastTry: ConnectorLifecycleResult | undefined;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const stored = detail.connection.authoritySync;
  const storedKey = JSON.stringify(stored);
  // The stored state the last "Finish disconnecting" was pressed against.
  const [triedAgainst, setTriedAgainst] = useState<string | null>(null);
  const finish = () => {
    setTriedAgainst(storedKey);
    onFinishDisconnecting();
  };
  const cleanup = detail.connection.externalCleanup;
  const cleanedUp = cleanup === 'complete' || cleanup === 'not_required';
  if (!cleanedUp) {
    // A refusal from the last try outranks the stored state while it is the
    // newer of the two: some refusals (an unlinked instance) leave nothing
    // stored at all. Once the stored state moves on (relinked elsewhere, and
    // DorkOS is retrying again), the stored state is the truth.
    const sync =
      lastTry?.authoritySync.status === 'failed' && triedAgainst === storedKey
        ? lastTry.authoritySync
        : stored;
    if (cleanup === 'failed' || sync.status === 'failed') {
      // Nothing is retrying on its own here, so never say it is.
      return (
        <PanelFix
          message={`Disconnecting didn’t finish. Agents already can’t use ${appName}.`}
          detail={sync.status === 'failed' ? sync.reason : undefined}
          action="Try disconnecting again"
          pending={finishing}
          onAction={finish}
        />
      );
    }
    // Pending: DorkOS keeps trying on its own. Say why it is waiting and when
    // it tries next; the button asks for a try right now. The stored state can
    // lag the last try (another pass held the request), so either counts.
    const waiting = [detail.connection.authoritySync, lastTry?.authoritySync].filter(
      (state) => state?.status === 'pending'
    );
    const explained = waiting.find((state) => state?.status === 'pending' && state.reason);
    const stillFinishing = waiting.length > 0 && lastTry !== undefined;
    const why =
      explained?.status === 'pending' && explained.reason && explained.retryAt
        ? `${explained.reason} ${retryLine(explained.retryAt)}`
        : stillFinishing
          ? 'DorkOS keeps trying on its own.'
          : undefined;
    return (
      <PanelFix
        message={
          stillFinishing
            ? `Still finishing disconnecting ${appName}. Agents already can’t use it.`
            : `Disconnecting didn’t finish. Agents already can’t use ${appName}.`
        }
        detail={why}
        action={stillFinishing ? 'Try again now' : 'Finish disconnecting'}
        pending={finishing}
        onAction={finish}
      />
    );
  }
  return (
    <>
      <PanelFix
        message={`Disconnected. Agents can’t use ${appName}.`}
        action="Connect again"
        pending={reconnecting}
        onAction={onSignInAgain}
        secondary={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmRemove(true)}
            disabled={removing}
            data-testid="remove-account"
          >
            Remove from your apps
          </Button>
        }
      />
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {appName} from your apps?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves this list. What agents did with it stays on record. If you connect it again,
              you choose who can use it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction disabled={removing} onClick={onRemove}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Three plain lines of what agents did lately, and "See all". */
function Recently({ detail }: { detail: ConnectorConnectionDetail }) {
  const { connection } = detail;
  const usage = useConnectorUsage(connection.connectionId);
  const { data: agentsData } = useRegisteredAgents();
  const [showAll, setShowAll] = useState(false);
  const agentNames: Record<string, string> = Object.fromEntries(
    detail.agents.map((agent) => [agent.agentId, agent.displayName])
  );
  for (const agent of agentsData?.agents ?? []) {
    agentNames[agent.id] ??= getAgentDisplayName(agent);
  }
  const items = usage.data?.items ?? [];
  const shown = showAll ? items : items.slice(0, RECENT_LIMIT);

  let body: ReactNode;
  if (connection.usage.status === 'unavailable') {
    body = (
      <p className="text-muted-foreground text-sm">What agents did isn’t available right now.</p>
    );
  } else if (usage.isPending) {
    body = <Skeleton className="h-16 rounded-lg" />;
  } else if (usage.isError) {
    body = (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        Couldn’t load what agents did.
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0"
          onClick={() => void usage.refetch()}
        >
          Try again
        </Button>
      </p>
    );
  } else if (items.length === 0) {
    body = <p className="text-muted-foreground text-sm">Nothing yet.</p>;
  } else {
    body = (
      <ul className="space-y-1.5">
        {shown.map((item) => (
          <li
            key={`${item.logicalOperationId}-${item.attemptIndex}`}
            className="flex items-baseline justify-between gap-3 text-sm"
          >
            <span className="min-w-0 truncate">
              {usageLine(item, connection.toolkit, agentNames)}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">
              {formatRelativeTime(item.startedAt)}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <PanelSection
      title="Recently"
      action={
        items.length > RECENT_LIMIT && (
          <Button
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Show less' : 'See all'}
          </Button>
        )
      }
    >
      {body}
    </PanelSection>
  );
}

/**
 * One-click prompts that open a chat with the message already typed (never
 * sent). The chat goes to the first agent that can use the app; with none,
 * DorkBot, who asks for access in the chat itself.
 */
function TryIt({ detail }: { detail: ConnectorConnectionDetail }) {
  const prompts = tryItPrompts(detail.connection.toolkit);
  const { data: agentsData } = useRegisteredAgents();
  const { data: pathsData } = useMeshAgentPaths();
  const navigate = useSafeNavigate();
  if (prompts.length === 0) return null;
  const paths = pathsData?.agents ?? [];
  const pathOf = (agentId: string | undefined) =>
    paths.find((entry) => entry.id === agentId) ?? null;
  const dorkBot = (agentsData?.agents ?? []).find((agent) => agent.isSystem);
  const target =
    detail.agents.map((access) => pathOf(access.agentId)).find((entry) => entry !== null) ??
    pathOf(dorkBot?.id);
  const agentName = target ? (target.displayName ?? target.name) : null;

  return (
    <PanelSection
      title="Try it"
      description={agentName ? `Opens a chat with ${agentName}, message already typed.` : undefined}
    >
      <div className="flex flex-wrap gap-2">
        {prompts.map((prompt) => (
          <Button
            key={prompt}
            variant="outline"
            size="sm"
            className="h-auto min-h-8 justify-start py-1.5 text-left whitespace-normal"
            disabled={!target || !navigate}
            onClick={() =>
              target &&
              navigate &&
              void navigate(
                toSession({ session: crypto.randomUUID(), dir: target.projectPath, prompt })
              )
            }
          >
            <Sparkles className="text-muted-foreground size-3.5" aria-hidden />
            {prompt}
          </Button>
        ))}
      </div>
    </PanelSection>
  );
}

/** Present only known account failure codes; never expose arbitrary server text. */
function accountChangeError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'connection_cleanup_pending':
      return 'Finish disconnecting this app, then try again. Agents already can’t use it.';
    case 'connection_not_disconnected':
      return 'Disconnect this app before removing it.';
    case 'connection_not_found':
      return 'This app is no longer connected. Close this panel and pick it again from the list.';
    case 'provider_not_found':
    case 'authentication_unavailable':
      return 'Sign-in isn’t available for this app right now. Check how DorkOS reaches your apps in Settings › Connections, then try again.';
    case 'idempotency_conflict':
      return 'This sign-in was already used. Close this panel and start again.';
    default:
      return 'We couldn’t confirm that change. Check the app’s current state before trying again.';
  }
}
