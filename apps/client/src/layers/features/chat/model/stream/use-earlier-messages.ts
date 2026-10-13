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
import { useHistoryWindow, useHistoryWindowStore } from '@/layers/entities/session';
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
  const [isLoadingEarlier, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const seekPages = useRef(0);

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

  const loadEarlier = useCallback(() => {
    if (loadingRef.current || !canLoadEarlier) return;
    const startedOn = historyWindow.windowStartId;
    const oldest = historyWindow.earlier[0]?.id ?? startedOn;
    if (!oldest) return;
    loadingRef.current = true;
    setLoading(true);
    transport
      .getMessages(sessionId, undefined, oldest)
      .then((page) => {
        const store = useHistoryWindowStore.getState();
        // A new snapshot moved the window while this page was in flight; the
        // page answers a question nobody is asking any more.
        if (store.sessions[sessionId]?.windowStartId !== startedOn) return;
        store.prependPage(sessionId, page.messages, page.earlierMessages ?? 0);
      })
      .catch((error: unknown) => {
        // The control stays, so pressing it again is the retry.
        console.warn('[chat] could not read earlier messages', error);
        useHistoryWindowStore.getState().endSeek(sessionId);
      })
      .finally(() => {
        loadingRef.current = false;
        setLoading(false);
      });
  }, [canLoadEarlier, sessionId, transport, historyWindow.earlier, historyWindow.windowStartId]);

  // A link to a message older than the window reads pages until it is loaded.
  const found = seekId !== undefined && messages.some((message) => message.id === seekId);
  useEffect(() => {
    if (seekId === undefined) {
      seekPages.current = 0;
      return;
    }
    if (historyWindow.windowStartId === null || isLoadingEarlier) return;
    if (found || !canLoadEarlier || seekPages.current >= MAX_SEEK_PAGES) {
      useHistoryWindowStore.getState().endSeek(sessionId);
      return;
    }
    seekPages.current += 1;
    loadEarlier();
  }, [
    seekId,
    found,
    canLoadEarlier,
    isLoadingEarlier,
    loadEarlier,
    sessionId,
    historyWindow.windowStartId,
  ]);

  return {
    messages,
    earlierCount: earlier.length,
    canLoadEarlier,
    isLoadingEarlier,
    isSeeking: seekId !== undefined,
    loadEarlier,
  };
}
