/**
 * One window's claim on re-sending a failed turn, announced to the others
 * (DOR-1650).
 *
 * ## The problem this exists for, stated exactly
 *
 * The once-only latch behind the auto-resume is keyed by mutation id inside a
 * per-QueryClient map, and a QueryClient is per tab. That is enough for the
 * common two-tab shape — a window that merely HAS the sign-in card open never
 * runs the mutation, never reaches `isSuccess`, and cannot re-send.
 *
 * It is NOT enough when a person presses Sign in in two windows, which a 180s
 * spinner makes an ordinary thing to do. The server holds one attempt per
 * runtime and hands the SAME promise to the second request, so both windows'
 * callbacks fire off one completion — before either has POSTed anything, so
 * neither can see the other's turn. Nothing downstream catches it either: the
 * send path takes a `clientMessageId` and never reads it, and the dispatcher
 * serializes a second send into the queue rather than dropping it. The result
 * was a **guaranteed** double-send, not a race.
 *
 * ## What this does about it, and what it does not
 *
 * A window announces the session it is about to resume before it sends, and a
 * window that has heard such an announcement stands down. That converts the
 * guaranteed double into an ordinary race: two windows that decide inside the
 * same delivery window still both send. It is a narrowing, not a lock — and it
 * is worth being plain about that, because the honest description of the result
 * is "rarely double" rather than "never".
 *
 * Making it a real lock needs an arbiter that both windows can see, and both
 * candidates cost more than they buy today. Server-side send idempotency does
 * not exist and would be a new contract on the message route. Resuming only the
 * request that ORIGINATED the login (rather than the one that joined it) would
 * be exact, but it breaks the commoner case of two auth-failed sessions on one
 * account, where the server joins the second sign-in and BOTH sessions should
 * resume.
 *
 * `BroadcastChannel` is absent in some browsers and in jsdom; `createChannel`
 * degrades to no-ops there, which lands this back on the pre-existing
 * behaviour — every window decides for itself — rather than breaking.
 *
 * @module features/chat/model/signin-resume/use-signin-resume-claim
 */
import { useEffect, useMemo, useRef } from 'react';
import { type Channel, createChannel } from '@/layers/shared/lib';

/** Channel every window's chat panel speaks resume claims on. */
const RESUME_CLAIM_CHANNEL = 'dorkos:signin-resume';

/**
 * How long another window's claim keeps this one from resuming.
 *
 * Only has to outlive the moment two joined sign-ins settle, which is
 * milliseconds; the margin is for a busy main thread. It expires rather than
 * persisting so a LATER sign-in on the same session is judged on its own —
 * though by then the first window's turn has usually reached this one over the
 * session stream, and the resume rule declines on that alone.
 */
const CLAIM_TTL_MS = 10_000;

/** What one window tells the others it is doing. */
interface ResumeClaim {
  /** Session whose failed turn is being re-sent. */
  sessionId: string;
}

/** Announce this window's resume, and see whether another window got there first. */
export interface SigninResumeClaim {
  /**
   * Whether another window announced a resume for this session just now. A
   * window never hears its own claim — `BroadcastChannel` does not deliver to
   * the context that posted — so two cards in ONE window are unaffected.
   */
  claimedElsewhere: (sessionId: string) => boolean;
  /** Announce that this window is resuming `sessionId`. Call BEFORE sending. */
  claim: (sessionId: string) => void;
}

/**
 * Subscribe to other windows' resume claims for the lifetime of this component.
 *
 * The returned object is referentially stable, so it can sit in a `useCallback`
 * dependency list without re-creating the callback on every render.
 */
export function useSigninResumeClaim(): SigninResumeClaim {
  const heardAt = useRef(new Map<string, number>());
  const channelRef = useRef<Channel<ResumeClaim> | null>(null);

  useEffect(() => {
    const channel = createChannel<ResumeClaim>(RESUME_CLAIM_CHANNEL);
    channelRef.current = channel;
    const heard = heardAt.current;
    const off = channel.onMessage((message) => {
      heard.set(message.sessionId, Date.now());
    });
    return () => {
      off();
      channel.close();
      channelRef.current = null;
    };
  }, []);

  return useMemo(
    () => ({
      claimedElsewhere: (sessionId: string) => {
        const at = heardAt.current.get(sessionId);
        return at !== undefined && Date.now() - at < CLAIM_TTL_MS;
      },
      claim: (sessionId: string) => channelRef.current?.postMessage({ sessionId }),
    }),
    []
  );
}
