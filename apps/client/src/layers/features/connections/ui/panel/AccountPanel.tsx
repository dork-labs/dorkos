import { useState, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import type { ConnectorConnectionDetail } from '@dorkos/shared/connector-resource-schemas';
import {
  useConnectorCatalog,
  useConnectorConnection,
  useConnectorUsage,
  useDisconnectConnectorConnection,
  useRecheckConnectorWays,
  usePauseConnectorConnection,
  useReconnectConnectorConnection,
  useRemoveConnectorConnection,
  useResumeConnectorConnection,
} from '@/layers/entities/connectors';
import { useMeshAgentPaths, useRegisteredAgents } from '@/layers/entities/mesh';
import { formatRelativeTime, getAgentDisplayName, toSession } from '@/layers/shared/lib';
import { useSafeNavigate, useSettingsDeepLink } from '@/layers/shared/model';
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
  const gone = connection.readiness.state === 'gone';

  return (
    <div className="space-y-7">
      <ReadinessFix
        detail={detail}
        appName={appName}
        onSignInAgain={signInAgain}
        reconnecting={reconnect.isPending}
        onResume={() => resume.mutate({ connectionId, input: undefined })}
        resuming={resume.isPending}
        onReview={() => onEditExactActions(connectionId)}
        onConnectNew={() => onAddAnother(connection.toolkit)}
        onRemove={() =>
          remove.mutate({ connectionId, input: undefined }, { onSuccess: () => onClose() })
        }
        removing={remove.isPending}
        onRetryDisconnect={() => disconnect.mutate({ connectionId, input: undefined })}
        retryingDisconnect={disconnect.isPending}
      />

      {mutationError && (
        <p role="alert" className="text-destructive bg-destructive/5 rounded-lg p-3 text-sm">
          {accountChangeError(mutationError)}
        </p>
      )}

      {!gone && (
        <ConnectionAccessCard
          mode="page"
          variant="embedded"
          connectionId={connectionId}
          serviceName={appName}
          onEditExactActions={onEditExactActions}
          appActions={{
            toolkit: connection.toolkit,
            providerInstanceId: connection.providerInstanceId,
          }}
        />
      )}

      <Recently detail={detail} />

      {connection.readiness.state === 'ready' && <TryIt detail={detail} />}

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

/**
 * The account's one fix on top of the panel, rendered from the server's
 * readiness: its owner line, and the one button its fix maps to. A ready
 * account shows nothing. A fix that is DorkOS's own (`wait`), or no fix at
 * all, is the line alone: there is never a button that can't work.
 */
function ReadinessFix({
  detail,
  appName,
  onSignInAgain,
  reconnecting,
  onResume,
  resuming,
  onReview,
  onConnectNew,
  onRemove,
  removing,
  onRetryDisconnect,
  retryingDisconnect,
}: {
  detail: ConnectorConnectionDetail;
  appName: string;
  onSignInAgain: () => void;
  reconnecting: boolean;
  onResume: () => void;
  resuming: boolean;
  onReview: () => void;
  onConnectNew: () => void;
  onRemove: () => void;
  removing: boolean;
  onRetryDisconnect: () => void;
  retryingDisconnect: boolean;
}) {
  const settings = useSettingsDeepLink();
  const recheck = useRecheckConnectorWays();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { readiness } = detail.connection;
  if (readiness.state === 'ready') return null;
  const fix = readiness.fix;
  const retryAt = fix?.retryAt ? retryLine(fix.retryAt) : undefined;
  const message = readiness.copy.owner;
  const gone = readiness.state === 'gone';

  const button = ((): { action: string; onAction: () => void; pending?: boolean } | null => {
    switch (fix?.action) {
      case 'sign_in_again':
        return { action: 'Sign in again', onAction: onSignInAgain, pending: reconnecting };
      case 'connect_again':
        return { action: 'Connect again', onAction: onSignInAgain, pending: reconnecting };
      case 'connect_new':
        return { action: `Connect ${appName} again`, onAction: onConnectNew };
      case 'resume':
        return { action: 'Resume', onAction: onResume, pending: resuming };
      case 'review_access':
        return { action: 'Check who can use it', onAction: onReview };
      case 'fix_key':
        return { action: 'Fix the key', onAction: () => settings.open('connections', 'ways') };
      case 'retry':
        if (gone) {
          return {
            action: fix.fixableBy === 'dorkos' ? 'Try again now' : 'Try disconnecting again',
            onAction: onRetryDisconnect,
            pending: retryingDisconnect,
          };
        }
        return {
          action: 'Check again',
          onAction: () => recheck.mutate(),
          pending: recheck.isPending,
        };
      case 'wait':
      case undefined:
        return null;
    }
  })();

  // Only an account with nothing owed at the service can be removed.
  const removable = readiness.reason === 'disconnected';
  return (
    <>
      <PanelFix
        message={message}
        detail={retryAt}
        {...(button ?? {})}
        secondary={
          removable && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRemove(true)}
              disabled={removing}
              data-testid="remove-account"
            >
              Remove from your apps
            </Button>
          )
        }
      />
      {removable && (
        <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {appName} from your apps?</AlertDialogTitle>
              <AlertDialogDescription>
                It leaves this list. What agents did with it stays on record. If you connect it
                again, you choose who can use it again.
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
      )}
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
