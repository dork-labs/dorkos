/**
 * Which face of an agent's Direct chat is on screen (DOR-3074).
 *
 * @module features/direct-message/model/use-direct-message-view
 */
import { useCallback } from 'react';
import type { DirectChat } from '@dorkos/shared/room-schemas';
import { useSafeNavigate } from '@/layers/shared/model';
import { toSession } from '@/layers/shared/lib';
import { useDmViewEnabled } from '@/layers/entities/config';
import { useDirectChat } from '@/layers/entities/room';
import { useSessionSearch } from '@/layers/entities/session';
import { directMessageMode, type DirectMessageMode } from '../lib/direct-message-rules';

/** How the chat on screen is drawn, and the Direct chat it is when it is one. */
export interface DirectMessageView {
  /** See {@link DirectMessageMode}. */
  mode: DirectMessageMode;
  /** The Direct chat this session is, or `null` when it is an ordinary chat. */
  chat: DirectChat | null;
}

/**
 * How the chat on screen is drawn: as a DM, as the session behind one, or as a
 * session like any other.
 *
 * Asks the server whether this is a Direct chat only while the experiment is
 * on, so with it off nothing new is fetched and nothing changes. While it
 * asks, the answer is `pending`, which every surface draws neutral.
 *
 * @param sessionId - The session on screen, or null for none.
 */
export function useDirectMessageView(sessionId: string | null): DirectMessageView {
  const enabled = useDmViewEnabled();
  const { data, isLoading } = useDirectChat(sessionId, { enabled });
  const { view } = useSessionSearch();
  const chat = enabled ? (data ?? null) : null;
  return {
    mode: directMessageMode({ enabled, isDirect: chat !== null, view, pending: isLoading }),
    chat,
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
