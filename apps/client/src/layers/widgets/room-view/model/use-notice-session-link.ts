/**
 * The link a room notice gives to the session it tells you to open (DOR-2077).
 *
 * "Ana ran into a problem and could not answer here. Open Ana's session to see
 * what went wrong." used to be a sentence with no way to do what it said. A
 * notice whose code is in `SESSION_POINTER_NOTICE_CODES` now carries a link to
 * that agent's session in this room.
 *
 * @module widgets/room-view/model/use-notice-session-link
 */
import { useCallback, useMemo, type MouseEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { SESSION_POINTER_NOTICE_CODES } from '@dorkos/shared/room-schemas';
import { sessionHref, toSession } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import {
  resolveRoomSessionForAuthor,
  useRoomSessions,
  type RoomEntry,
} from '@/layers/entities/room';
import type { NoticeSessionLink } from '@/layers/features/conversation';

/**
 * The session link for one room entry, or `null` when it should have none.
 *
 * `null` for every entry that is not a notice pointing at a session, and — the
 * honest case — for one that is but whose agent this room has no session for
 * yet, or while that answer is still loading. A link is only drawn when it goes
 * somewhere.
 *
 * **Where the session id comes from.** Not the entry: a notice is written with
 * no session id, on purpose, because a room rebinds an agent's session after
 * every turn and an id in the log would go stale (DOR-1974). The room's own
 * bindings answer instead, keyed by the notice's `subjectAuthorId`. The read is
 * the one the live lane's "Open its session" already makes, enabled only when a
 * notice like this is on screen, so an ordinary room open still asks for
 * nothing. A plain click then re-reads the bindings before it navigates, so the
 * link follows a rebind that happened after the row was drawn, and goes nowhere
 * when the room has let the session go since (the row then redraws without it);
 * only a read that FAILED falls back to the id on screen. A middle click or a
 * copied link uses the address the row shows.
 *
 * @param roomId - The room the entry is in.
 * @param entry - The entry being drawn.
 */
export function useNoticeSessionLink(roomId: string, entry: RoomEntry): NoticeSessionLink | null {
  const authorId = entry.body.subjectAuthorId;
  const code = entry.body.notice;
  const points =
    entry.kind === 'notice' &&
    code !== undefined &&
    authorId !== undefined &&
    SESSION_POINTER_NOTICE_CODES.includes(code);

  const sessions = useRoomSessions(roomId, { enabled: points });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const transport = useTransport();

  const sessionId = points
    ? (sessions.data?.bindings.find((binding) => binding.authorId === authorId)?.sessionId ?? null)
    : null;

  const onOpen = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // A new tab, a new window, a download: the browser's, with the href.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      if (sessionId === null || authorId === undefined) return;
      void resolveRoomSessionForAuthor({ queryClient, transport }, roomId, authorId).then(
        (fresh) => {
          // The room let the session go since the row drew. Opening the old id
          // lands on "Session not found"; the fresh read has already refilled
          // the cache, so the row redraws as a plain sentence instead.
          if (fresh.kind === 'none') return;
          // A failed read learned nothing new, so the id on screen is still the
          // best answer there is.
          void navigate(
            toSession({ session: fresh.kind === 'bound' ? fresh.sessionId : sessionId })
          );
        }
      );
    },
    [authorId, navigate, queryClient, roomId, sessionId, transport]
  );

  return useMemo(
    () => (sessionId === null ? null : { href: sessionHref({ session: sessionId }), onOpen }),
    [onOpen, sessionId]
  );
}
