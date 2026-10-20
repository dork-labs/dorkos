/**
 * The way back past a long conversation's opening window (DOR-2889).
 *
 * A session opens on its newest messages only (`SessionSnapshot.earlierMessages`
 * counts the rest), so a 100 MB conversation draws as fast as a short one. This
 * hook puts the older pages a reader asked for in front of the transcript and
 * reads the next one on request.
 *
 * @module features/chat/model/stream/use-earlier-messages
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTransport } from '@/layers/shared/model';
import {
  useHistoryWindow,
  useHistoryWindowStore,
  useSessionStreamStore,
} from '@/layers/entities/session';
import { transcriptIdForChatMessage } from '../../lib/chat-messaging';
import { mapHistoryMessage } from './stream-history-helpers';
import type { ChatMessage } from '../chat-types';

/** How many pages a link to an old message may read to find it. */
const MAX_SEEK_PAGES = 20;

/** What {@link useEarlierMessages} gives the transcript. */
export interface EarlierMessages {
  /** The transcript with any older pages in front of it. */
  messages: ChatMessage[];
  /** How many of `messages` came from older pages. */
  earlierCount: number;
  /**
   * How many messages of the conversation sit before `messages[0]`: what is
   * still unread from the server, or 0 when the transcript is whole. Adding it
   * to a position in `messages` gives the position in the whole conversation.
   */
  messagesBefore: number;
  /** Whether older messages remain to be read. */
  canLoadEarlier: boolean;
  /** True while a page is on its way. */
  isLoadingEarlier: boolean;
  /** True while a link to an old message is still reading pages to reach it. */
  isSeeking: boolean;
  /** Read the page directly older than what is loaded. */
  loadEarlier: () => void;
}

/**
 * Older pages for the session's transcript, and the control to read more.
 *
 * Pages join the transcript only while it still starts where the snapshot's
 * window did. Anything that replaced the window with a whole history (the
 * turn-end reload) already holds the older messages, so the pages step aside
 * and the control goes with them.
 *
 * @param sessionId - The session on screen.
 * @param transcript - The rendered transcript, oldest first.
 */
export function useEarlierMessages(sessionId: string, transcript: ChatMessage[]): EarlierMessages {
  const transport = useTransport();
  const historyWindow = useHistoryWindow(sessionId);
  const seekId = useHistoryWindowStore((state) => state.seeks[sessionId]);
  // Which session a page is being read for. Per session, because the
  // transcript is not remounted when the chat changes: one chat's read must not
  // show (or block) the control in the next.
  const [loadingFor, setLoadingFor] = useState<string | null>(null);
  const loadingRef = useRef<string | null>(null);
  const isLoadingEarlier = loadingFor === sessionId;
  /** Pages read for the current seek, keyed by the seek they belong to. */
  const seekPages = useRef({ key: '', count: 0 });

  const attached =
    historyWindow.windowStartId !== null && transcript[0]?.id === historyWindow.windowStartId;
  const earlier = useMemo(
    () => (attached ? historyWindow.earlier.map(mapHistoryMessage) : []),
    [attached, historyWindow.earlier]
  );
  const messages = useMemo(
    () => (earlier.length > 0 ? [...earlier, ...transcript] : transcript),
    [earlier, transcript]
  );
  const canLoadEarlier = attached && historyWindow.remaining > 0;
  const messagesBefore = attached ? historyWindow.remaining : 0;

  const loadEarlier = useCallback(() => {
    if (loadingRef.current === sessionId || !canLoadEarlier) return;
    const { generation } = historyWindow;
    const oldest = historyWindow.earlier[0]?.id ?? historyWindow.windowStartId;
    if (!oldest) return;
    loadingRef.current = sessionId;
    setLoadingFor(sessionId);
    transport
      .getMessages(sessionId, undefined, { before: oldest })
      .then((page) => {
        // The store refuses a page asked for before the window started over.
        useHistoryWindowStore
          .getState()
          .prependPage(sessionId, generation, page.messages, page.earlierMessages ?? 0);
      })
      .catch((error: unknown) => {
        // The control stays, so pressing it again is the retry.
        console.warn('[chat] could not read earlier messages', error);
        useHistoryWindowStore.getState().endSeek(sessionId);
      })
      .finally(() => {
        if (loadingRef.current !== sessionId) return;
        loadingRef.current = null;
        setLoadingFor(null);
      });
  }, [canLoadEarlier, sessionId, transport, historyWindow]);

  // A link to a message older than the window reads pages until it is loaded.
  // A link from another chat names a CHAT message (spec `spin-off-chats` §6),
  // which is found inside the transcript message that carries it.
  const found =
    seekId !== undefined &&
    (messages.some((message) => message.id === seekId) ||
      transcriptIdForChatMessage(
        [
          ...historyWindow.earlier,
          ...useSessionStreamStore.getState().getSession(sessionId).messages,
        ],
        seekId
      ) !== undefined);
  useEffect(() => {
    if (seekId === undefined) {
      // Ended: a later seek for the same message starts counting again.
      seekPages.current = { key: '', count: 0 };
      return;
    }
    const key = `${sessionId}:${seekId}`;
    if (seekPages.current.key !== key) seekPages.current = { key, count: 0 };
    // Wait for the snapshot; one that carried no messages ends the seek below.
    if (historyWindow.generation === 0 || isLoadingEarlier) return;
    if (found || !canLoadEarlier || seekPages.current.count >= MAX_SEEK_PAGES) {
      useHistoryWindowStore.getState().endSeek(sessionId);
      return;
    }
    seekPages.current.count += 1;
    loadEarlier();
  }, [
    seekId,
    found,
    canLoadEarlier,
    isLoadingEarlier,
    loadEarlier,
    sessionId,
    historyWindow.generation,
  ]);

  return {
    messages,
    earlierCount: earlier.length,
    messagesBefore,
    canLoadEarlier,
    isLoadingEarlier,
    isSeeking: seekId !== undefined,
    loadEarlier,
  };
}
