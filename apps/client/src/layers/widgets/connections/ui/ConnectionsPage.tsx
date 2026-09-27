import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { CatalogEntry } from '@dorkos/shared/relay-schemas';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import {
  useConnectorAuthentication,
  useReconnectConnectorConnection,
  useResumeConnectorConnection,
} from '@/layers/entities/connectors';
import { useRelayEventStream, useToggleAdapter } from '@/layers/entities/relay';
import {
  AccountPanel,
  AgentRequestDialog,
  AppList,
  appUses,
  ConnectDialog,
  ConnectionAccessDialog,
  ManagementReviewDialog,
  NeedsYou,
  remainingUses,
  useAppList,
  type PendingSignIn,
  type YourAppRow,
} from '@/layers/features/connections';
import { useSettingsDeepLink } from '@/layers/shared/model';
import { Button, focusPageHeading, PageContainer, PageHeading } from '@/layers/shared/ui';
import { AppPanel } from './AppPanel';
import { AppUseChoice } from './AppUseChoice';
import { ChatAppPanel } from './ChatAppPanel';
import { useChatAppSetup } from './ChatAppSetup';

/** The page's URL state: which panel, dialog or sign-in is open. */
type ConnectionsSearch = {
  app?: string;
  review?: string;
  flow?: string;
  request?: string;
};

/**
 * The /connections page: one plain list of apps (design record
 * `connections-one-list`, ADR `260927-033250`).
 *
 * "Yours" holds every app you connected, one row each, with its state and the
 * one thing to do next; "All apps" holds everything you could connect. A
 * connected row opens a side panel whose address is `?app=<id>`, so a chat
 * card or any link can open it. Decisions waiting on you (an agent asking to
 * use an app, a program asking to change one) sit in a small "Needs you" strip
 * on top, and only when there is one.
 *
 * The plumbing is elsewhere on purpose: how DorkOS reaches your apps, and how
 * chat apps behave, live in Settings › Connections.
 */
export function ConnectionsPage() {
  const search = useSearch({ from: '/_shell/connections' });
  const navigate = useNavigate({ from: '/connections' });
  const setSearch = useCallback(
    (patch: ConnectionsSearch) =>
      void navigate({
        search: (previous) => {
          const next: Record<string, unknown> = { ...previous, ...patch };
          for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key];
          return next as typeof previous;
        },
      }),
    [navigate]
  );

  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [connectService, setConnectService] = useState<ConnectorCatalogService | null>(null);
  const [connectOpen, setConnectOpen] = useState(Boolean(search.flow));
  const [connectingForRequest, setConnectingForRequest] = useState(false);
  const [accessConnectionId, setAccessConnectionId] = useState<string | null>(null);
  const [useChoice, setUseChoice] = useState<ConnectorCatalogService | null>(null);
  const chatAppSetup = useChatAppSetup();
  // What opened a "Needs you" dialog, so closing it can hand focus back. A
  // decided item leaves the strip, and then focus lands on the page heading.
  const decisionOpener = useRef<HTMLElement | null>(null);
  const returnDecisionFocus = (event: Event) => returnFocus(event, decisionOpener);
  // The same for the side panel: back to the row that opened it, or the
  // heading when it was opened by a link or its row has gone.
  const panelOpener = useRef<HTMLElement | null>(null);
  const returnPanelFocus = (event: Event) => returnFocus(event, panelOpener);

  // A sign-in left open in the address (the dialog closed, or the page
  // reloaded) is a "Connecting" row until it finishes or is cancelled.
  const flowId = search.request ? null : (search.flow ?? null);
  const flow = useConnectorAuthentication(flowId);
  const flowState = flow.data?.state;
  const flowToolkit = flow.data?.toolkit;
  const pendingSignIn = useMemo<PendingSignIn | null>(
    () =>
      !connectOpen && flowId && flowToolkit && (flowState === 'starting' || flowState === 'pending')
        ? { flowId, toolkit: flowToolkit }
        : null,
    [connectOpen, flowId, flowState, flowToolkit]
  );

  const data = useAppList(deferredQuery, pendingSignIn);
  const { relay } = data;
  useRelayEventStream(relay.enabled);

  const reconnect = useReconnectConnectorConnection();
  const resume = useResumeConnectorConnection();
  const toggle = useToggleAdapter();
  const pendingRowId =
    (reconnect.isPending && reconnect.variables?.connectionId) ||
    (resume.isPending && resume.variables?.connectionId) ||
    (toggle.isPending && toggle.variables?.id) ||
    null;

  const openSignIn = (nextFlowId: string) => {
    setConnectService(null);
    setSearch({ flow: nextFlowId, app: undefined });
    setConnectOpen(true);
  };

  const startAccount = (service: ConnectorCatalogService) => {
    setConnectService(service);
    setConnectOpen(true);
  };

  const onConnect = (service: ConnectorCatalogService) => {
    const left = remainingUses(service, data.owned);
    const chatType = relay.enabled ? left.chatType : null;
    if (left.account && chatType) {
      setUseChoice(service);
      return;
    }
    if (chatType) {
      chatAppSetup.open(chatType);
      return;
    }
    startAccount(service);
  };

  const onRowAction = (row: YourAppRow) => {
    switch (row.action) {
      case 'sign-in-again':
        reconnect.mutate(
          { connectionId: row.id },
          { onSuccess: (result) => openSignIn(result.flowId) }
        );
        return;
      case 'resume':
        if (row.kind === 'chat') toggle.mutate({ id: row.id, enabled: true });
        else resume.mutate({ connectionId: row.id, input: undefined });
        return;
      case 'cancel':
        setSearch({ flow: undefined });
        return;
      case 'review':
        setAccessConnectionId(row.id);
        return;
      case 'fix':
        setSearch({ app: row.id });
        return;
      case null:
        return;
    }
  };

  // The panel's row comes from every row, so a search never hides an open panel.
  const panelRow = search.app
    ? (data.allYours.find((row) => row.id === search.app && row.kind !== 'connecting') ?? null)
    : null;
  const panelChat = panelRow?.kind === 'chat' ? chatEntryFor(data.chatApps, panelRow.id) : null;
  // A link to an app that is gone (removed, or a stale bookmark) closes rather
  // than holding an empty panel open.
  useEffect(() => {
    if (
      search.app &&
      !data.yoursLoading &&
      !data.yoursRefreshing &&
      !data.yoursError &&
      !panelRow
    ) {
      setSearch({ app: undefined });
    }
  }, [search.app, data.yoursLoading, data.yoursRefreshing, data.yoursError, panelRow, setSearch]);

  const closePanel = () => setSearch({ app: undefined });

  return (
    <PageContainer width="reading">
      <header className="mb-6">
        {/* The bar overhead already says "Connections" (design decision E1);
            the heading stays for the outline and as the place focus lands. */}
        <PageHeading>Connections</PageHeading>
        <p className="text-muted-foreground text-sm">
          Apps your agents can use, and places you can reach them.
        </p>
      </header>

      <div className="space-y-8">
        <NeedsYou
          services={data.services}
          onOpenRequest={(requestId) => {
            decisionOpener.current = document.activeElement as HTMLElement | null;
            setSearch({ request: requestId });
          }}
          onOpenReview={(reviewRequestId) => {
            decisionOpener.current = document.activeElement as HTMLElement | null;
            setSearch({ review: reviewRequestId });
          }}
        />

        <AppList
          query={query}
          onQueryChange={setQuery}
          data={data}
          onOpenRow={(row) => {
            if (row.kind === 'connecting') {
              setConnectOpen(true);
              return;
            }
            panelOpener.current = document.activeElement as HTMLElement | null;
            setSearch({ app: row.id });
          }}
          onRowAction={onRowAction}
          pendingRowId={pendingRowId}
          onConnect={onConnect}
        />

        <OwnKeyPointer />
      </div>

      <AppPanel
        row={panelRow}
        open={panelRow !== null}
        onOpenChange={(open) => {
          if (!open) closePanel();
        }}
        onCloseAutoFocus={returnPanelFocus}
      >
        {panelRow?.kind === 'account' && (
          <AccountPanel
            key={panelRow.id}
            connectionId={panelRow.id}
            onSignInStarted={openSignIn}
            onEditExactActions={setAccessConnectionId}
            onAddAnother={(toolkit) => {
              closePanel();
              startAccount(
                data.services.get(toolkit) ?? accountOnlyService(toolkit, panelRow.name)
              );
            }}
            onClose={closePanel}
          />
        )}
        {panelRow?.kind === 'chat' && panelChat && (
          <ChatAppPanel
            key={panelRow.id}
            entry={panelChat.entry}
            instance={panelChat.instance}
            onClose={closePanel}
          />
        )}
      </AppPanel>

      {connectOpen && (
        <ConnectDialog
          key={search.flow ?? connectService?.serviceSlug ?? 'idle'}
          service={connectService}
          flowId={search.flow ?? null}
          agentRequestId={
            search.request && (connectingForRequest || search.flow) ? search.request : null
          }
          onFlowIdChange={(next) => setSearch({ flow: next ?? undefined })}
          onClose={() => {
            setConnectOpen(false);
            setConnectService(null);
            if (!search.flow) setConnectingForRequest(false);
          }}
          onChooseAccess={(connectionId) => {
            if (connectingForRequest) {
              setConnectingForRequest(false);
              setConnectOpen(false);
              setConnectService(null);
              return;
            }
            setAccessConnectionId(connectionId);
          }}
          onConnected={(connectionId) => setSearch({ app: connectionId })}
        />
      )}

      <AgentRequestDialog
        requestId={search.request ?? null}
        open={Boolean(search.request) && !connectOpen}
        onOpenChange={(open) => {
          if (!open) setSearch({ request: undefined });
        }}
        onConnectService={(service) => {
          setConnectingForRequest(true);
          startAccount(service);
        }}
        onCloseAutoFocus={returnDecisionFocus}
      />

      <ManagementReviewDialog
        key={search.review ?? 'closed'}
        reviewRequestId={search.review ?? null}
        open={Boolean(search.review)}
        onOpenChange={(open) => {
          if (!open) setSearch({ review: undefined });
        }}
        onCloseAutoFocus={returnDecisionFocus}
      />

      <ConnectionAccessDialog
        key={accessConnectionId ?? 'closed'}
        connectionId={accessConnectionId}
        open={accessConnectionId !== null}
        onOpenChange={(open) => {
          if (!open) setAccessConnectionId(null);
        }}
      />

      <AppUseChoice
        service={useChoice}
        onClose={() => setUseChoice(null)}
        onChooseChat={(service) => {
          setUseChoice(null);
          const chatType = appUses(service).chatType;
          if (chatType) chatAppSetup.open(chatType);
        }}
        onChooseAccount={(service) => {
          setUseChoice(null);
          startAccount(service);
        }}
      />

      {chatAppSetup.dialog}
    </PageContainer>
  );
}

/**
 * Hand focus back after a dialog or the panel closes: to what opened it while
 * that is still on the page, else to the page heading, never to nothing.
 */
function returnFocus(event: Event, opener: { current: HTMLElement | null }) {
  event.preventDefault();
  const target = opener.current;
  opener.current = null;
  if (target?.isConnected) target.focus();
  else void focusPageHeading();
}

/** The catalog entry and setup behind a chat app row. */
function chatEntryFor(chatApps: readonly CatalogEntry[], instanceId: string) {
  for (const entry of chatApps) {
    const instance = entry.instances.find((candidate) => candidate.id === instanceId);
    if (instance) return { entry, instance };
  }
  return null;
}

/**
 * A catalog entry for an app the list has no entry for, so "Connect another"
 * still works for an app only the live catalog knows: the connect dialog reads
 * its sign-in routes fresh by id.
 */
function accountOnlyService(toolkit: string, displayName: string): ConnectorCatalogService {
  return {
    serviceSlug: toolkit,
    displayName,
    iconKey: toolkit,
    intents: [{ kind: 'account', displayName: `Use a ${displayName} account`, routes: [] }],
  };
}

/**
 * The page's one pointer to Settings › Connections, where your own Composio or
 * Nango key lives. Static on purpose: it reads nothing, so it can't fail and
 * it never waits on a server call.
 */
function OwnKeyPointer() {
  const settings = useSettingsDeepLink();
  return (
    <p className="text-muted-foreground text-xs">
      Prefer your own Composio or Nango account?{' '}
      <Button
        variant="link"
        className="h-auto p-0 text-xs"
        onClick={() => settings.open('connections', 'ways')}
      >
        Set it up in Settings › Connections
      </Button>
    </p>
  );
}
