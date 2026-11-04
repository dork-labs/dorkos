/**
 * Which face of an agent's Direct chat is on screen (DOR-3074).
 *
 * @module features/direct-message/model/use-direct-message-view
 */
import { useCallback } from 'react';
import type { DirectChat } from '@dorkos/shared/room-schemas';
import { useSafeNavigate } from '@/layers/shared/model';
import { toSession } from '@/layers/shared/lib';
import { useDmViewState } from '@/layers/entities/config';
import { useDirectChat } from '@/layers/entities/room';
import { useSessionSearch } from '@/layers/entities/session';
import { directMessageMode, type DirectMessageMode } from '../lib/direct-message-rules';

/** How the chat on screen is drawn, and the Direct chat it is when it is one. */
export interface DirectMessageView {
  /** See {@link DirectMessageMode}. */
  mode: DirectMessageMode;
  /** The Direct chat this session is, or `null` without an answer naming one. */
  chat: DirectChat | null;
  /**
   * Whether the server could not say. The chat stays unresolved, because it may
   * still belong to an agent, so nothing should name it after its runtime.
   */
  lookupFailed: boolean;
}

/**
 * How the chat on screen is drawn: as a DM, as the session behind one, or as a
 * session like any other.
 *
 * Asks the server whether this is a Direct chat only while the view is on, so
 * with it off nothing new is fetched and nothing changes. Until the setting is
 * known, and while it asks, the answer is `pending`, which every surface draws
 * neutral. No data means no answer, including a failed request or a query
 * waiting on the boot cache to restore before it fetches.
 *
 * @param sessionId - The session on screen, or null for none.
 */
export function useDirectMessageView(sessionId: string | null): DirectMessageView {
  const { enabled, settled } = useDmViewState();
  const { data, errorUpdateCount } = useDirectChat(sessionId, { enabled });
  const { view } = useSessionSearch();
  const chat = enabled ? (data ?? null) : null;
  // An error is not an answer. Keep the same neutral surface as a hung lookup;
  // lookupFailed only releases its transcript wait, including during retries.
  const lookupFailed = enabled && data === undefined && errorUpdateCount > 0;
  return {
    mode:
      !settled && sessionId !== null
        ? 'pending'
        : directMessageMode({
            enabled,
            isDirect: chat !== null,
            view,
            pending: sessionId !== null && data === undefined,
          }),
    chat,
    lookupFailed,
  };
}

/** The two ways between a DM and the session behind it. */
export interface SessionViewLinks {
  /** Show the working session behind the DM on screen. */
  openSessionView: () => void;
  /** Go back to the DM from its session. */
  openDirectMessage: () => void;
}

/**
 * Move between a DM and the session behind it.
 *
 * Each is a real navigation, a new history entry on the same chat, so Back,
 * Forward and a desktop tab's history all walk between the two.
 */
export function useSessionViewLinks(): SessionViewLinks {
  const navigate = useSafeNavigate();
  const go = useCallback(
    (view: 'session' | undefined) => {
      if (!navigate) return;
      void navigate(toSession((prev) => ({ ...prev, view })));
    },
    [navigate]
  );
  return {
    openSessionView: useCallback(() => go('session'), [go]),
    openDirectMessage: useCallback(() => go(undefined), [go]),
  };
}
