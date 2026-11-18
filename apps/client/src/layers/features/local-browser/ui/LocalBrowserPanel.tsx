import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  LocalBrowserMode,
  LocalBrowserPersonState,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';
import { useLocalBrowser, LOCAL_BROWSER_STATE_KEY } from '@/layers/entities/local-browser';
import { cn } from '@/layers/shared/lib';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { BrowserModeChoice } from './BrowserModeChoice';
import { browserErrorMessage } from '../lib/browser-error-message';
import { useActionFocusReturn } from '../model/use-action-focus-return';
import { useFirstFocus } from '../model/use-first-focus';
import { useBrowserPill } from '../model/use-browser-pill';
import { chromeTakesOver } from '../model/browser-pill-state';
import { BrowserPreparation } from './BrowserPreparation';
import { BrowserStatusPill } from './BrowserStatusPill';
import { WaitingElsewhere } from './WaitingElsewhere';
import { SavedSignIns } from './SavedSignIns';
import { LocalBrowserMenu } from './LocalBrowserMenu';
import { PageAreaBlock } from './PageAreaBlock';
import { SharedElsewhere } from './SharedElsewhere';
import { EMPTY_PAGE, LocalBrowserView } from './LocalBrowserView';

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
  const [surfaceUnavailable, setSurfaceUnavailable] = useState(false);
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
  // This chat's agent is waiting on a person. In its own window the handoff closed the
  // agent's window for the sign-in window, so this is not a browser to open.
  const handoffHere =
    !!sessionId && state?.handoff?.outcome === null && state.handoff.sessionId === sessionId
      ? state.handoff
      : null;
  // The person closed the sign-in window and it saved, so all that's left is Continue.
  const signInClosed = !!handoffHere && state?.signIn?.status === 'saved';
  const mode =
    connected && state.mode
      ? state.mode
      : (choice?.mode ??
        (capabilities?.embedded && window.electronAPI?.localBrowser ? 'embedded' : 'new-window'));
  const selected = state?.tabs.find((tab) => tab.id === state.selectedTabId);
  // The page and its chrome run flush to the panel's edges, under the controls.
  const showsPage = connected && !waitingElsewhere && !sharedElsewhere;
  const unavailable = useCallback(() => setSurfaceUnavailable(true), []);
  useEffect(
    () => () => {
      operation.current += 1;
    },
    []
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
        takenOver: known?.takenOver ?? false,
        ...next,
      }));
      return true;
    } catch (cause) {
      if (ticket !== operation.current) return false;
      setError(browserErrorMessage(cause));
      // A sign-in started since the last read: show its handoff now, not on the next poll.
      if ((cause as { code?: string } | null)?.code === 'signing_in')
        void queryClient.invalidateQueries({ queryKey: LOCAL_BROWSER_STATE_KEY }).then(() => {
          // Waiting for you already says to finish, so the refusal isn't said twice.
          const read = queryClient.getQueryData<LocalBrowserPersonState>(LOCAL_BROWSER_STATE_KEY);
          const waiting = read?.handoff?.outcome === null && read.handoff.sessionId === sessionId;
          if (ticket === operation.current && waiting && read.status !== 'connected')
            setError(null);
        });
      return false;
    } finally {
      if (ticket === operation.current) {
        setBusy(false);
        setOpening(false);
      }
    }
  };
  // The pill says who has the page, and holds Take over, Pause, Resume and Hand back.
  const { pill, actions: pillActions } = useBrowserPill({ state, sessionId, action });
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
  const signInsReadable = !!state && !!capabilities && !query.isError && !capabilityQuery.isError;
  const supported =
    capabilities &&
    (mode === 'embedded'
      ? capabilities.embedded && !!window.electronAPI?.localBrowser
      : capabilities.newWindow);
  const { openButton, rememberFocus } = useActionFocusReturn(
    busy || cancelling || connected || needsChoice || !supported
  );
  // Closing ends a handoff as Stop task does (outcome `window-closed`), and that
  // ends the agent's turn. Only this one: a handoff that ended first must not
  // cost that chat its next turn.
  const close = (from: HTMLElement) => {
    rememberFocus(from);
    const asked = state?.handoff?.outcome === null ? state.handoff.id : null;
    let answer: LocalBrowserPersonState | undefined;
    void action(async () => (answer = await transport.disconnectLocalBrowser())).then((closed) => {
      const ended = answer?.handoff;
      if (closed && ended?.id === asked && ended?.outcome === 'window-closed')
        void transport.interruptSession(ended.sessionId).catch(() => {});
    });
  };
  // Open browser is the one main action while nothing is open, so focus starts there.
  useFirstFocus(
    openButton,
    visible && !connected && !waitingElsewhere && !handoffHere && !needsChoice && !!supported
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

  const statusWords = cancelling
    ? 'Cancelling…'
    : opening
      ? 'Preparing browser'
      : busy
        ? 'Updating…'
        : !connected && handoffHere
          ? 'Waiting for you'
          : state?.status === 'closed'
            ? 'Browser closed'
            : connected && (sharedElsewhere || selected)
              ? // The page area says where the browser is, or the pill's own status
                // region says who has the page (DOR-4428). With no tab there is no
                // pill, so the header still says it.
                ''
              : connected
                ? state.paused
                  ? 'Agent paused'
                  : 'Connected'
                : hadConnection
                  ? 'Disconnected'
                  : 'Not open yet';
  const readFailed = query.isError || capabilityQuery.isError;
  // The blocks for another chat and for a read that failed say it in their own words.
  const statusShown = !waitingElsewhere && !sharedElsewhere && !readFailed;
  // Why the last action or read failed, and a way back when trying again can help.
  const problem = (
    <>
      {(error || readFailed) && (
        <p role="alert" className="text-sm">
          {error ?? readError}
        </p>
      )}
      {readFailed && readCode !== 'local_only' && readCode !== 'owner_only' && (
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
    </>
  );

  return (
    <section
      aria-label="Agent browser"
      data-slot="local-browser-panel"
      className="@container/browser-panel flex h-full min-h-0 flex-col"
    >
      {showsPage ? (
        <>
          <div className="flex max-h-[50%] min-h-0 shrink-0 flex-col gap-3 overflow-y-auto p-3">
            {/* Below 480px of panel the state sits under the title, so neither wraps (DOR-4265). */}
            <div className="flex flex-col items-start gap-0.5 @min-[480px]/browser-panel:flex-row @min-[480px]/browser-panel:items-center @min-[480px]/browser-panel:justify-between @min-[480px]/browser-panel:gap-2">
              <h3 className="text-sm font-medium">Agent browser</h3>
              <span role="status" className="text-muted-foreground text-xs">
                {statusWords}
              </span>
            </div>
            {problem}
            {/* With a page open, who has it (Your turn, Only you, Paused) and Pause, Resume,
              Take over and Hand back live in the chrome's status pill (DOR-3111, DOR-4428); the
              tab list, Copy address, Forget saved sign-ins and Close browser live in its ⋯ menu
              (DOR-4429). DorkOS draws both outside the page, so the page can't hide or fake them. */}
          </div>
          <LocalBrowserView
            tab={selected ?? null}
            connectionId={state.connectionId ?? null}
            embedded={mode === 'embedded'}
            pageVisible={
              visible &&
              !query.isError &&
              !surfaceUnavailable &&
              // A new empty page is blank; hidden, the page area says what to do instead.
              selected?.url !== EMPTY_PAGE
            }
            surfaceUnavailable={surfaceUnavailable}
            onUnavailable={unavailable}
            busy={busy}
            action={action}
            onReconnect={open}
            signIn={state.signIn ?? null}
            // The site goes on in its own window, where the saved sign-in is (DOR-4097).
            onOpenOwnWindow={(url) =>
              void action(() =>
                transport.openLocalBrowser({
                  mode: 'new-window',
                  ...(state.sessionId ? { sessionId: state.sessionId } : {}),
                  url,
                })
              )
            }
            agentDriving={pill?.kind === 'driving'}
            onTakeOver={
              pill && chromeTakesOver(pill)
                ? () => void action(() => transport.takeOverLocalBrowser())
                : undefined
            }
            status={
              pill && (
                <BrowserStatusPill
                  state={pill}
                  agentName={handoffHere?.agentName ?? agentName}
                  busy={busy}
                  {...pillActions}
                />
              )
            }
            menu={(forward) => (
              <LocalBrowserMenu
                state={state}
                busy={busy}
                action={action}
                canForgetSignIns={signInsReadable}
                onClose={close}
                canForward={forward.canForward}
                onForward={forward.onForward}
              />
            )}
          />
        </>
      ) : (
        <PageAreaBlock title={statusShown ? <span role="status">{statusWords}</span> : undefined}>
          {!statusShown && (
            <p role="status" className="sr-only">
              {statusWords}
            </p>
          )}
          {opening && preparation && <BrowserPreparation preparation={preparation} />}
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
          {problem}
          {waitingElsewhere && (
            <WaitingElsewhere
              sessionId={waitingElsewhere.sessionId}
              agentName={waitingElsewhere.agentName}
            />
          )}
          {!connected && handoffHere && (
            <div className="space-y-1 text-sm">
              <p>
                {agentName || handoffHere.agentName || 'The agent'} needs you to sign in to{' '}
                {handoffHere.site}.
              </p>
              {signInClosed ? (
                <p>
                  The sign-in window closed. Press{' '}
                  <strong className="font-medium">Continue in the chat</strong> to hand it back.
                </p>
              ) : (
                <p>
                  Finish in the sign-in window, then press{' '}
                  <strong className="font-medium">Continue in the chat</strong>.
                </p>
              )}
            </div>
          )}
          {/* While it opens, the choice stays in place so focus has somewhere to return, but
              frozen: out of reach (inert) and dimmed, so it doesn't read as a second question. */}
          {!connected && !waitingElsewhere && !handoffHere && !readFailed && (
            <div
              data-slot="local-browser-choice"
              inert={opening || cancelling}
              className={cn(
                'space-y-3 transition-opacity',
                (opening || cancelling) && 'opacity-50'
              )}
            >
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
              canTakeHere={!!sessionId}
              disabled={busy || cancelling || !supported}
              visible={visible}
              onTakeHere={open}
            />
          )}
          {/* With a page open, Forget is in the browser's ⋯ menu. */}
          {!waitingElsewhere && !opening && (
            <SavedSignIns enabled={signInsReadable} disabled={busy || cancelling} />
          )}
        </PageAreaBlock>
      )}
    </section>
  );
}
