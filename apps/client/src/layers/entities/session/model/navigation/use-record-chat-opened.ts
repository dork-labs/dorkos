/**
 * Record that the chat page is showing a chat (spec `your-activity-first` D3).
 *
 * @module entities/session/model/navigation/use-record-chat-opened
 */
import { useEffect } from 'react';
import { useInteractionStore } from '@/layers/entities/interactions';
import { SESSION_ROUTE, reportClientError } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { useSessionRouteContext } from './session-route-context';

/**
 * Whether this page load began on the chat page — a reload, a deep link, or a
 * notification that opened the app. Read once, when the module loads, because
 * the question is about how the app was ENTERED, not where it is now.
 */
const loadedOnChatPage =
  typeof window !== 'undefined' && window.location.pathname === SESSION_ROUTE;

/**
 * The chat the app landed on, once the chat page first shows one; `null`
 * before that, and for good once any other chat is shown.
 */
let landingChatId: string | null = null;
/** Whether the landing has been spent: the first shown chat is known. */
let landingDecided = !loadedOnChatPage;

/**
 * Whether showing `sessionId` is the app LANDING on it rather than you going
 * to it. Only the first chat a page load shows can be the landing, and only
 * while no other chat has been shown since; the same id shown again under
 * StrictMode's second effect run is still the landing.
 */
function isLanding(sessionId: string): boolean {
  if (!landingDecided) {
    landingDecided = true;
    landingChatId = sessionId;
    return true;
  }
  if (landingChatId === sessionId) return true;
  landingChatId = null;
  return false;
}

/**
 * Record each chat the chat page shows as opened by you — once it is on
 * screen, and again every time the shown chat changes.
 *
 * **The page records it, not the click.** Deep links, reloads, notifications,
 * the "Started from" line, room links and every sidebar or ⌘K click all land on
 * the chat page, so recording here counts every one of them, and no click
 * handler has to remember to (ticket rule 1).
 *
 * **Only a chat you can see is opened.** A chat page in a background tab or a
 * hidden window records nothing until it becomes visible, and then records
 * once for the chat it shows.
 *
 * Two records, for two readers:
 *
 * - **The server's `lastTouchedByYouAt`** (`POST /api/sessions/:id/opened`),
 *   fire-and-forget, so every device agrees. A failure costs only that
 *   agreement, so it is reported, never shown as a toast.
 * - **This browser's open record** (`session:<id>`), synchronously, so Today
 *   and the agent click are right the instant the chat shows. **Except for the
 *   chat the app landed on** (a reload, a deep link, a notification that opened
 *   the app): that record is also what "While you were away…" measures your
 *   absence from (BC-22), so writing it on arrival would end the absence before
 *   the digest could report it. The landed chat is Today's anchor while it is
 *   open, and the server's record places it once you leave.
 *
 * **A fresh chat that does not exist yet is skipped.** The `/session` loader
 * marks an id it minted for a new chat as a draft; nothing has happened in it,
 * and the first message records the write on the server anyway.
 *
 * @param sessionId - The chat on screen, or `null` when there is none.
 */
export function useRecordChatOpened(sessionId: string | null): void {
  const transport = useTransport();
  const isDraft = useSessionRouteContext(sessionId)?.draft === true;

  useEffect(() => {
    if (!sessionId || isDraft) return;
    let recorded = false;
    const record = () => {
      if (recorded || document.visibilityState !== 'visible') return;
      recorded = true;
      document.removeEventListener('visibilitychange', record);
      if (!isLanding(sessionId)) {
        useInteractionStore.getState().recordOpened('session', sessionId);
      }
      void transport.markSessionOpened(sessionId).catch((error: unknown) => {
        reportClientError(transport, error);
      });
    };
    record();
    if (recorded) return;
    document.addEventListener('visibilitychange', record);
    return () => document.removeEventListener('visibilitychange', record);
  }, [sessionId, isDraft, transport]);
}
