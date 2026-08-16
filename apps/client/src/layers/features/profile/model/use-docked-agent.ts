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
import { useAppStore, useSafePathname } from '@/layers/shared/model';
import { useMeshMemberId } from '@/layers/entities/mesh';

/** The route the docked profile lives on. */
const SESSION_ROUTE = '/session';

/**
 * The directory of the agent the docked profile should show, or `null` when
 * there is none.
 *
 * An explicit open always wins — the operator picked that agent, from the
 * sidebar, the roster, the palette or a deep link. The ambient working directory
 * is only honest ON `/session`, where it IS the session's own agent; anywhere
 * else it is the server's startup directory, which nobody chose, so the panel
 * would otherwise profile a stranger. That is the same rule the tab's
 * `visibleWhen` gate applies, and the two must agree or the tab appears with
 * nothing behind it.
 *
 * In the Obsidian embed the pathname is the constant `/session`, so the panel
 * profiles the session's own agent there exactly as it does on the web.
 */
export function useDockedAgentPath(): string | null {
  const explicitAgentPath = useAppStore((s) => s.explicitAgentPath);
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const isSessionRoute = useSafePathname() === SESSION_ROUTE;
  return explicitAgentPath ?? (isSessionRoute ? selectedCwd : null);
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
