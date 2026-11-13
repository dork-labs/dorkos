import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  LocalBrowserMode,
  LocalBrowserPersonState,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';
import { useLocalBrowser, LOCAL_BROWSER_STATE_KEY } from '@/layers/entities/local-browser';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { Button, Input } from '@/layers/shared/ui';
import { BrowserModeChoice } from './BrowserModeChoice';
import { useNativeBrowserSurface } from '../model/use-native-browser-surface';
import { browserErrorMessage } from '../lib/browser-error-message';
import { useActionFocusReturn } from '../model/use-action-focus-return';
import { BrowserPreparation } from './BrowserPreparation';
import { WaitingElsewhere } from './WaitingElsewhere';
import { SavedSignIns } from './SavedSignIns';
import { SharedElsewhere } from './SharedElsewhere';

export interface LocalBrowserPanelProps {
  visible?: boolean;
  /** Only the current direct chat may grant its agent access. Rooms pass null. */
  sessionId?: string | null;
  /** Display identity for the current direct chat; never an unrelated retained panel. */
  agentName?: string | null;
}

/** Controls one exact live page; embedded rendering belongs to the desktop host. */
export function LocalBrowserPanel({
  visible = true,
  sessionId = null,
  agentName = null,
}: LocalBrowserPanelProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { state: query, capabilities: capabilityQuery } = useLocalBrowser();
  const state = query.data;
  const capabilities = capabilityQuery.data;
  const readCode = ((query.error ?? capabilityQuery.error) as { code?: string } | null)?.code;
  const readError =
    readCode === 'local_only'
      ? 'Open DorkOS on your computer to use its browser.'
      : readCode === 'owner_only'
        ? 'Only this DorkOS owner can choose its browser.'
        : 'Couldn’t reach the browser. Reconnect and try again.';
  const choice = useAppStore((store) => store.localBrowserChoice);
  const choiceIssue = useAppStore((store) => store.localBrowserChoiceIssue);
  const saveChoice = useAppStore((store) => store.setLocalBrowserChoice);
  const needsChoice = !choice && choiceIssue !== null;
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openingRequest, setOpeningRequest] = useState<{
    sessionId: string | null;
    mode: LocalBrowserMode;
    previousConnectionId: string | null;
    startedAt: number;
  } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const operation = useRef(0);
  const pendingSetup = useRef<Promise<boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [surfaceUnavailable, setSurfaceUnavailable] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const connected = state?.status === 'connected';
  // "Disconnected" before anything was ever opened reads as broken (DOR-4104).
  const [hadConnection, setHadConnection] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- remembering a fact the server forgets on Disconnect
    if (connected) setHadConnection(true);
  }, [connected]);
  const sharedElsewhere = !!state?.sessionId && state.sessionId !== sessionId;
  // Another chat's agent is waiting on a person. Nothing here may answer for that chat.
  const waitingElsewhere =
    state?.handoff?.outcome === null && state.handoff.sessionId !== sessionId
      ? state.handoff
      : null;
  const mode =
    connected && state.mode
      ? state.mode
      : (choice?.mode ??
        (capabilities?.embedded && window.electronAPI?.localBrowser ? 'embedded' : 'new-window'));
  const selected = state?.tabs.find((tab) => tab.id === state.selectedTabId);
  const unavailable = useCallback(() => setSurfaceUnavailable(true), []);
  useEffect(
    () => () => {
      operation.current += 1;
    },
    []
  );
  useNativeBrowserSurface(
    surface,
    state?.connectionId ?? null,
    visible &&
      connected &&
      !query.isError &&
      !sharedElsewhere &&
      mode === 'embedded' &&
      !surfaceUnavailable,
    unavailable
  );

  const action = async (run: () => Promise<LocalBrowserState>, setup = false) => {
    const ticket = ++operation.current;
    setBusy(true);
    setOpening(setup);
    setError(null);
    try {
      if (setup) {
        // A poll from a previous setup cannot become the new request's progress.
        await queryClient.cancelQueries({ queryKey: LOCAL_BROWSER_STATE_KEY });
        if (ticket !== operation.current) return false;
      }
      const next = await run();
      if (ticket !== operation.current) return false;
      // An older poll must not overwrite a just-observed connect, tab choice, or pause.
      await queryClient.cancelQueries({ queryKey: LOCAL_BROWSER_STATE_KEY });
      if (ticket !== operation.current) return false;
      // A plain browser answer says nothing about a handoff, so what's known about it stays.
      queryClient.setQueryData<LocalBrowserPersonState>(LOCAL_BROWSER_STATE_KEY, (known) => ({
        handoff: known?.handoff ?? null,
        signIn: known?.signIn ?? null,
        ...next,
      }));
      return true;
    } catch (cause) {
      if (ticket !== operation.current) return false;
      setError(browserErrorMessage(cause));
      return false;
    } finally {
      if (ticket === operation.current) {
        setBusy(false);
        setOpening(false);
      }
    }
  };
  const open = () => {
    saveChoice({ mode });
    setOpeningRequest({
      sessionId,
      mode,
      previousConnectionId: state?.connectionId ?? null,
      startedAt: Date.now(),
    });
    setSurfaceUnavailable(false);
    const setup = action(
      () =>
        transport.openLocalBrowser({
          mode,
          ...(sessionId ? { sessionId } : {}),
        }),
      true
    );
    pendingSetup.current = setup;
    void setup.finally(() => {
      if (pendingSetup.current === setup) pendingSetup.current = null;
    });
  };
  const cancelOpening = async () => {
    const setup = pendingSetup.current;
    setCancelling(true);
    try {
      const stopped = await action(() => transport.disconnectLocalBrowser());
      if (stopped) {
        await queryClient.invalidateQueries({ queryKey: LOCAL_BROWSER_STATE_KEY });
      }
      // Disconnect can answer before the original setup has finished cancelling.
      await setup;
    } finally {
      setCancelling(false);
    }
  };
  const supported =
    capabilities &&
    (mode === 'embedded'
      ? capabilities.embedded && !!window.electronAPI?.localBrowser
      : capabilities.newWindow);
  const { openButton, rememberFocus } = useActionFocusReturn(
    busy || cancelling || connected || needsChoice || !supported
  );
  const preparation =
    opening &&
    !cancelling &&
    openingRequest &&
    state?.preparation &&
    state.status === 'disconnected' &&
    state.sessionId === openingRequest.sessionId &&
    state.mode === openingRequest.mode &&
    !!state.connectionId &&
    state.connectionId !== openingRequest.previousConnectionId &&
    query.dataUpdatedAt >= openingRequest.startedAt
      ? state.preparation
      : null;

  return (
    <section
      aria-label="Agent browser"
      data-slot="local-browser-panel"
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Agent browser</h3>
        <span role="status" className="text-muted-foreground text-xs">
          {cancelling
            ? 'Cancelling…'
            : opening
              ? 'Preparing browser'
              : busy
                ? 'Updating…'
                : state?.status === 'closed'
                  ? 'Browser closed'
                  : connected
                    ? state.paused
                      ? 'Agent paused'
                      : 'Connected'
                    : hadConnection
                      ? 'Disconnected'
                      : 'Not open yet'}
        </span>
      </div>
      {opening && (
        <Button
          size="sm"
          variant="outline"
          onClick={(event) => {
            rememberFocus(event.currentTarget);
            void cancelOpening();
          }}
        >
          Cancel
        </Button>
      )}
      {preparation && <BrowserPreparation preparation={preparation} />}
      {(error || query.isError || capabilityQuery.isError) && (
        <p role="alert" className="text-sm">
          {error ?? readError}
        </p>
      )}
      {(query.isError || capabilityQuery.isError) &&
        readCode !== 'local_only' &&
        readCode !== 'owner_only' && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void query.refetch();
              void capabilityQuery.refetch();
            }}
          >
            Reconnect
          </Button>
        )}
      {waitingElsewhere && <WaitingElsewhere sessionId={waitingElsewhere.sessionId} />}
      {!connected && !waitingElsewhere && (
        <div className="min-h-0 space-y-3 overflow-y-auto">
          {sessionId && !state?.mode && (
            <p className="text-sm">Open a browser {agentName || 'this chat’s agent'} can use.</p>
          )}
          {choiceIssue && (
            <p className="text-muted-foreground text-xs">
              {needsChoice
                ? 'Choose a browser. The saved choice couldn’t be read.'
                : 'Browser choice couldn’t be saved. It lasts until this window closes.'}
            </p>
          )}
          <BrowserModeChoice
            value={needsChoice ? null : mode}
            onChange={(next) => {
              saveChoice({ mode: next });
            }}
            capabilities={capabilities}
            disabled={busy || cancelling}
          />
          {state?.status === 'closed' && (
            <p className="text-muted-foreground text-xs">
              Open it again to reconnect. Saved sign-ins are kept.
            </p>
          )}
          <Button
            ref={openButton}
            disabled={busy || cancelling || needsChoice || !supported}
            onClick={open}
          >
            {state?.mode ? 'Reconnect' : 'Open browser'}
          </Button>
        </div>
      )}
      {connected && !waitingElsewhere && sharedElsewhere && (
        <SharedElsewhere
          holderSessionId={state.sessionId!}
          canMoveHere={!!sessionId}
          disabled={busy || cancelling || !supported}
          onMoveHere={open}
        />
      )}
      {connected && !waitingElsewhere && !sharedElsewhere && (
        <>
          {!state.sessionId && (
            <p className="text-muted-foreground text-xs">
              Only you can use this page. Open from an agent chat to share it.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  state.paused ? transport.resumeLocalBrowser() : transport.pauseLocalBrowser()
                )
              }
            >
              {state.paused ? 'Resume agent' : 'Pause agent'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={(event) => {
                rememberFocus(event.currentTarget);
                const asked = state.handoff?.outcome === null ? state.handoff.id : null;
                let answer: LocalBrowserPersonState | undefined;
                void action(async () => (answer = await transport.disconnectLocalBrowser())).then(
                  (closed) => {
                    // Disconnect ends a handoff as Stop task does (outcome `window-closed`), and
                    // that ends the agent's turn. Only this one: a handoff that ended first must
                    // not cost that chat its next turn.
                    const ended = answer?.handoff;
                    if (closed && ended?.id === asked && ended?.outcome === 'window-closed')
                      void transport.interruptSession(ended.sessionId).catch(() => {});
                  }
                );
              }}
            >
              Disconnect
            </Button>
          </div>
          <label className="text-sm">
            {state.sessionId ? `Shared with ${agentName || 'this chat’s agent'}` : 'Browser tab'}
            <select
              className="bg-muted/40 mt-1 block w-full rounded-md p-2"
              value={state.selectedTabId ?? ''}
              disabled={busy}
              onChange={(event) => {
                setAddress(null);
                void action(() => transport.selectLocalBrowserTab(event.target.value));
              }}
            >
              {!state.selectedTabId && <option value="">Choose a tab</option>}
              {state.tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.title || (tab.url === 'about:blank' ? 'New tab' : tab.url)}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const url = address ?? selected.url;
                try {
                  const parsed = new URL(url);
                  if (!['http:', 'https:'].includes(parsed.protocol))
                    throw new Error('unsupported');
                  void action(() => transport.navigateLocalBrowser(parsed.href)).then((ok) => {
                    if (ok) setAddress(null);
                  });
                } catch {
                  setError('Enter a full web address, starting with https:// or http://.');
                }
              }}
            >
              <Input
                aria-label="Web address"
                value={address ?? selected.url}
                onChange={(event) => setAddress(event.target.value)}
                className="min-w-0"
              />
              <Button size="sm" variant="outline" type="submit" disabled={busy}>
                Go
              </Button>
            </form>
          )}
          {state.paused && (
            <div className="text-muted-foreground space-y-1 text-xs">
              <p>Pause stops new actions. An action already started may finish.</p>
              <p>Your mouse and keyboard still work.</p>
            </div>
          )}
          {mode !== 'embedded' && (
            <p className="text-muted-foreground text-sm">
              This page is in the separate browser window.
            </p>
          )}
          {mode === 'embedded' && (
            <p className="text-muted-foreground text-xs">This page stays in the right panel.</p>
          )}
          {mode === 'embedded' && (
            <p className="text-muted-foreground text-xs">
              {state.sessionId
                ? 'Extra windows are for you. Your agent stays on this page.'
                : 'Extra windows are for you.'}
            </p>
          )}
          {mode === 'embedded' && (
            <div
              ref={surface}
              data-slot="native-browser-surface"
              className="bg-muted/20 relative min-h-48 flex-1 rounded-lg"
            >
              {surfaceUnavailable && (
                <div className="space-y-2 p-3">
                  <p role="alert" className="text-sm">
                    Couldn’t show the page. Reconnect to try again.
                  </p>
                  <Button size="sm" variant="outline" onClick={open} disabled={busy}>
                    Reconnect
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {!waitingElsewhere && (
        <SavedSignIns
          enabled={!!state && !!capabilities && !query.isError && !capabilityQuery.isError}
          disabled={busy || cancelling}
        />
      )}
    </section>
  );
}
