/**
 * Which agent the docked profile is about, and which agent the session you are
 * in belongs to (spec `profile-unification` §1.6).
 *
 * Two questions that look like one and are not. The dock can be pointed at an
 * agent you opened deliberately from anywhere in the cockpit; the address rule
 * only cares about the agent whose conversation is on screen. Keeping them apart
 * is what lets `?profile=<someone else>` open a sheet over a session instead of
 * quietly replacing the panel you were reading.
 *
 * @module features/profile/model/use-docked-agent
 */
import { useLayoutEffect, useRef } from 'react';
import { useAppStore, useSafePathname, useSafeSearch } from '@/layers/shared/model';
import { useMeshMemberId } from '@/layers/entities/mesh';
import { useSessionId } from '@/layers/entities/session';
import { routeShowsRoom } from '@/layers/entities/room';
import { SESSION_ROUTE } from '@dorkos/shared/session-link';

/**
 * The directory of the agent the docked profile should show, or `null` when
 * there is none.
 *
 * On `/session` it is the session's own agent, always (FB-60): showing anyone
 * else beside a 1:1 chat invites acting on the wrong agent. Elsewhere it is the
 * agent the operator explicitly opened, from the roster, the palette or a deep
 * link, scoped to the room or page it was opened in by
 * {@link useScopeProfilePickToChat}. The ambient working directory is never used
 * off `/session`: there it is the server's startup directory, which nobody
 * chose, so the panel would otherwise profile a stranger. That is the same rule the tab's
 * `visibleWhen` gate applies, and the two must agree or the tab appears with
 * nothing behind it.
 */
export function useDockedAgentPath(): string | null {
  const search = useSafeSearch() as { profileRef?: string; agentPath?: string };
  const explicitAgentPath = useAppStore((s) => s.explicitAgentPath);
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const isSessionRoute = useSafePathname() === SESSION_ROUTE;
  // In a 1:1 chat the panel answers "who am I talking to", so the chat's own
  // agent wins over any remembered pick (FB-60). The exception is the address
  // on screen naming someone else (`?agentPath=`, or `?profileRef=` once the
  // deep link has resolved it): that is a request for this view, not a leftover.
  if (isSessionRoute) {
    // Only while the link's pick stands: a link naming an agent this install
    // does not have is let go, and the chat's own agent comes back.
    if (search.agentPath && explicitAgentPath === search.agentPath) return explicitAgentPath;
    if (search.profileRef && explicitAgentPath) return explicitAgentPath;
    return selectedCwd;
  }
  return explicitAgentPath;
}

/** The agent whose session is open: where it lives, and what the roster calls it. */
export interface SessionAgent {
  /** Its directory, or `null` when the route is not a session. */
  agentPath: string | null;
  /**
   * Its roster id, or `null` when the route is not a session or the fleet cannot
   * name the directory yet — which is not the same as "no such agent", so a
   * caller must read it as "do not dock" rather than as "does not exist".
   */
  memberId: string | null;
}

/**
 * The agent whose session is on screen.
 *
 * Deliberately the ambient working directory rather than the explicitly opened
 * one: this answers "whose conversation am I in", and opening another agent's
 * profile in the panel does not change that.
 */
export function useSessionAgent(): SessionAgent {
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const isSessionRoute = useSafePathname() === SESSION_ROUTE;
  const agentPath = isSessionRoute ? selectedCwd : null;
  const memberId = useMeshMemberId(agentPath ?? undefined);
  return { agentPath, memberId: memberId ?? null };
}

/**
 * Keep an explicit profile pick to the chat or room it was made in (FB-60).
 *
 * Nothing used to clear a pick, so opening DorkOS Cloud's profile once left it
 * docked beside every chat and room opened afterwards. A pick now lasts as long
 * as the chat or room on screen. Entering another one, by sidebar, tab or
 * link, drops it. Opening another agent's profile from a room still works for
 * as long as you stay in that room.
 *
 * A link that names the profile's subject itself (`?agentPath=`,
 * `?profileRef=`) is a pick made for this view, so it is left alone.
 * Layout-timed so the stale agent is never painted beside the new view.
 * Mounted once, at the shell.
 */
export function useScopeProfilePickToChat(): void {
  const search = useSafeSearch() as { agentPath?: string; profileRef?: string; id?: string };
  const pathname = useSafePathname();
  const [routeSessionId] = useSessionId();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const setExplicitAgentPath = useAppStore((s) => s.setExplicitAgentPath);
  // Which chat (a new one has no id yet, so its agent tells two apart) or room.
  const viewKey =
    pathname === SESSION_ROUTE
      ? `chat|${routeSessionId ?? 'new'}|${selectedCwd ?? ''}`
      : routeShowsRoom(pathname)
        ? `room|${pathname}|${search.id ?? ''}`
        : null;
  const previous = useRef<string | null | undefined>(undefined);
  const linkNamesSubject = Boolean(search.agentPath || search.profileRef);

  useLayoutEffect(() => {
    const entered =
      previous.current !== undefined && viewKey !== null && viewKey !== previous.current;
    previous.current = viewKey;
    if (entered && !linkNamesSubject) setExplicitAgentPath(null);
  }, [viewKey, linkNamesSubject, setExplicitAgentPath]);
}
