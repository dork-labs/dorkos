/**
 * Record that the chat page is showing a chat (spec `your-activity-first` D3).
 *
 * @module entities/session/model/navigation/use-record-chat-opened
 */
import { useEffect } from 'react';
import { useInteractionStore } from '@/layers/entities/interactions';
import { reportClientError } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { useSessionRouteContext } from './session-route-context';

/**
 * Record each chat the chat page shows as opened by you — once on mount, and
 * again every time the shown chat changes.
 *
 * **The page records it, not the click.** Deep links, reloads, notifications,
 * the "Started from" line, room links and every sidebar or ⌘K click all land on
 * the chat page, so recording here counts every one of them, and no click
 * handler has to remember to (ticket rule 1).
 *
 * Two records, for two readers:
 *
 * - **This browser's open record** (`session:<id>`), synchronously, so Today
 *   and the agent click are right the instant the chat shows.
 * - **The server's `lastTouchedByYouAt`** (`POST /api/sessions/:id/opened`),
 *   fire-and-forget, so every other device agrees. A failure costs only that
 *   agreement, so it is reported, never shown as a toast.
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
    useInteractionStore.getState().recordOpened('session', sessionId);
    void transport.markSessionOpened(sessionId).catch((error: unknown) => {
      reportClientError(transport, error);
    });
  }, [sessionId, isDraft, transport]);
}
