import { createContext, use, type ReactNode } from 'react';
import type { SessionOrigin } from '@dorkos/shared/types';
import type { AgentVisual, TeamViewMode } from '@/layers/shared/lib';

/**
 * What the shell already knows that a route's bar needs.
 *
 * Route headers are declared in `router.tsx` as zero-prop components (see
 * `resolveRouteHeader`), which is what lets a route own its header without the
 * shell keeping a switch. They still need a few values the shell resolves once
 * and would otherwise resolve twice — the open room's title, the active
 * session's agent — so those ride a context rather than a prop drill through
 * `staticData`.
 *
 * Everything here is read-only and derived. Nothing writes back through it.
 */
export interface OneBarRouteState {
  /** Active session's agent name, absent when the session has no agent yet. */
  agentName: string | undefined;
  /**
   * The agent's emoji and colour, resolved through `resolveAgentVisual`.
   *
   * Absent exactly when {@link agentName} is — a bare directory has no agent to
   * draw, and the hash-from-cwd face the favicon falls back to would be an
   * avatar for something that isn't an agent (spec §5.3). The session bar draws
   * a generic mark there instead.
   */
  agentVisual: AgentVisual | undefined;
  /** Active session's resolved origin. Absent or `'user'` shows no chip. */
  origin: SessionOrigin | undefined;
  /** The session's own origin label, preferred over the descriptor's fallback. */
  originLabel: string | undefined;
  /**
   * What this conversation is called — the same runtime-owned title the sidebar
   * session rows render, read from the one session cache every surface shares,
   * so the bar and the sidebar can never disagree about a session's name.
   *
   * Empty or absent until the runtime titles the session after the first turn;
   * the bar says "New session" meanwhile and swaps in place when the title
   * arrives (the global session stream patches this cache — no new API).
   */
  sessionTitle: string | undefined;
  /**
   * The working directory's basename — the identity for a session with no
   * agent, where there is no name to show and inventing one would be a lie.
   */
  sessionDirectoryName: string | undefined;
  /**
   * The open room's spoken name on `/channels`, resolved once by the shell
   * (`useRoomDocumentTitle`) — the same room, resolved the same way the browser
   * tab already uses it, so the two can never disagree about what is open.
   */
  roomTitle: string | null;
  /**
   * Which `/team` view is showing. Read off the URL rather than through
   * `useSearch`, so the header keeps rendering during a route exit animation.
   */
  teamViewMode: TeamViewMode;
}

const OneBarContext = createContext<OneBarRouteState | null>(null);

/**
 * Supplies the shell-resolved values every route bar reads.
 *
 * Mounted by `AppShell` around the header slot. Tests and playground showcases
 * that render a route bar directly mount it too.
 *
 * @param props - The resolved state, plus the bar it wraps.
 */
export function OneBarProvider({
  value,
  children,
}: {
  value: OneBarRouteState;
  children: ReactNode;
}) {
  return <OneBarContext value={value}>{children}</OneBarContext>;
}

/**
 * Read the shell-resolved bar state.
 *
 * Throws outside a provider rather than defaulting: a bar rendering an empty
 * room title because nobody mounted the provider is the exact class of bug
 * DOR-587 was, and it is invisible until somebody notices the wrong word in the
 * header.
 */
export function useOneBarState(): OneBarRouteState {
  const value = use(OneBarContext);
  if (!value) {
    throw new Error('useOneBarState must be used inside a OneBarProvider');
  }
  return value;
}
