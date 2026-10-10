/**
 * Continue with DorkOS, start to finish (spec `one-minute-onboarding` §2.2):
 * record the path, get a link code, send the browser window that was opened in
 * the click to the approval page, and move on by itself once credits are ready.
 *
 * @module features/onboarding/model/use-dorkos-connect
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { openExternalWindowLater, type PendingExternalWindow } from '@/layers/shared/lib';
import { approvalUrl } from '../lib/approval-url';
import type { FirstRunAccountLink, FirstRunPendingCode } from './first-run-slots';
import { firstRunErrorMessage, useChooseFirstRunPath, useCreditsReadiness } from './use-first-run';

/** What the Connecting screen shows. */
export type DorkosConnectPhase =
  /** Recording the path and asking for a code. */
  | { kind: 'starting' }
  /** The code is out; the person is approving it in the browser. */
  | { kind: 'waiting'; pending: FirstRunPendingCode }
  /** Approved; the account is being made ready to run agents. */
  | { kind: 'finishing' }
  /** Approved, and the account has no card saved yet. */
  | { kind: 'needs-card' }
  /** The service said this account cannot buy a plan. */
  | { kind: 'refused' }
  /** The code expired or was turned down. */
  | { kind: 'expired' }
  /** Something failed before a code came. */
  | { kind: 'failed'; message: string };

/** Inputs to {@link useDorkosConnect}. */
export interface DorkosConnectOptions {
  /** The account link the app shell lent the first run. */
  link: FirstRunAccountLink;
  /**
   * The browser window opened in the Continue click, waiting for its address.
   * Taken and cleared once the code arrives; closed if none ever does.
   */
  waitingWindowRef: RefObject<PendingExternalWindow | null>;
  /** Called once, when credits are ready. */
  onReady: () => void;
}

/** What the Connecting screen drives. */
export interface DorkosConnect {
  phase: DorkosConnectPhase;
  /**
   * Start over after a failure, an expired code or a turned-down one. Call it
   * from the click: it opens the browser window the new code goes to.
   */
  retry: () => void;
}

/**
 * Drive the DorkOS path. The path is recorded BEFORE a code is asked for, so
 * the link that lands is recorded as the person's own choice of credits (the
 * server's new-link hook reads it). A computer that is linked already skips the
 * code and only waits for ready.
 */
export function useDorkosConnect({
  link,
  waitingWindowRef,
  onReady,
}: DorkosConnectOptions): DorkosConnect {
  const choose = useChooseFirstRunPath();
  const [failure, setFailure] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);
  const readiness = useCreditsReadiness(recorded);

  // The async run reads the link as it is when each await returns, not as it
  // was when the run began.
  const linkRef = useRef(link);
  const chooseRef = useRef(choose.mutateAsync);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    linkRef.current = link;
    chooseRef.current = choose.mutateAsync;
    onReadyRef.current = onReady;
  });

  const closeWindow = useCallback(() => {
    waitingWindowRef.current?.close();
    waitingWindowRef.current = null;
  }, [waitingWindowRef]);

  const run = useCallback(async () => {
    setFailure(null);
    try {
      await chooseRef.current({ path: 'dorkos' });
    } catch (error) {
      closeWindow();
      setFailure(firstRunErrorMessage(error));
      return;
    }
    setRecorded(true);
    const current = linkRef.current;
    if (current.state === 'linked' || current.state === 'pending') return;
    const code = await current.start();
    if (code === null) {
      closeWindow();
      setFailure(linkRef.current.startError ?? 'Couldn’t reach DorkOS. Try again.');
    }
  }, [closeWindow]);

  // Once, when the link's first read has answered: a run started while it is
  // still loading could ask for a second code beside one already waiting.
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current || link.state === 'loading') return;
    ran.current = true;
    void run();
  }, [link.state, run]);

  // The window opened in the click goes to the approval page the moment the
  // code is here, so nobody types it.
  const pending = link.state === 'pending' ? link.pending : null;
  useEffect(() => {
    if (!pending || !waitingWindowRef.current) return;
    const url = approvalUrl(pending);
    if (url) waitingWindowRef.current.go(url);
    else waitingWindowRef.current.close();
    waitingWindowRef.current = null;
  }, [pending, waitingWindowRef]);

  // A window still waiting when the screen goes never gets an address.
  useEffect(() => closeWindow, [closeWindow]);

  const advanced = useRef(false);
  useEffect(() => {
    if (readiness !== 'ready' || advanced.current) return;
    advanced.current = true;
    onReadyRef.current();
  }, [readiness]);

  const retry = useCallback(() => {
    waitingWindowRef.current?.close();
    waitingWindowRef.current = openExternalWindowLater();
    if (linkRef.current.state === 'expired' || linkRef.current.state === 'denied') {
      setFailure(null);
      void linkRef.current.start();
      return;
    }
    void run();
  }, [run, waitingWindowRef]);

  return { phase: phaseOf(failure, recorded, link, pending, readiness), retry };
}

/** The screen's one phase, from everything the run and the link know. */
function phaseOf(
  failure: string | null,
  recorded: boolean,
  link: FirstRunAccountLink,
  pending: FirstRunPendingCode | null,
  readiness: ReturnType<typeof useCreditsReadiness>
): DorkosConnectPhase {
  if (failure !== null) return { kind: 'failed', message: failure };
  if (readiness === 'refused') return { kind: 'refused' };
  if (readiness === 'needs-card') return { kind: 'needs-card' };
  if (link.state === 'expired' || link.state === 'denied') return { kind: 'expired' };
  if (link.state === 'linked' && recorded) return { kind: 'finishing' };
  if (pending) return { kind: 'waiting', pending };
  return { kind: 'starting' };
}
