/**
 * The desk guard for a relay turn whose payload names its own folder (spec
 * `agent-home-desk` §3.4, invariant I3).
 *
 * A relay payload's `cwd` is the SENDER's words: the binding router stamps one,
 * but so can any agent that publishes to another agent's subject. Trusted as-is
 * it let one agent stand another's turn in a room's shared files or in a third
 * agent's folder. So the claude-code adapter asks this before the turn starts,
 * and a refusal stops it through the same door an expired message takes.
 *
 * Which agent the turn is for comes from what the SERVER knows first — the
 * agent the relay resolved from the subject, else the session's own recorded
 * agent — and only then from the payload's `forAgent`. A payload that names a
 * different agent than the server knows is refused outright.
 *
 * @module services/core/agent-identity/turn-desk-check
 */
import path from 'node:path';
import type { TurnDeskCheck } from '@dorkos/relay';
import { assertOwnDesk, assertNobodysDesk, deskBindingFor, DeskNotOwnError } from './agent-home.js';

/** Where the session-cwd chain places an agent, and which rung answered. */
export interface TurnDeskPlacement {
  /** The folder the chain chose. */
  cwd: string;
  /** The rung that answered — see {@link deskBindingFor}. */
  rung: string;
  /** Why the chain fell back, when it did. */
  degraded?: string;
}

/** What {@link createTurnDeskCheck} reads, injected so a test needs no server. */
export interface TurnDeskCheckDeps {
  /** The agent a session was recorded for (`session_metadata.agent_path`), or `null`. */
  sessionAgentPath(sessionId: string): Promise<string | null>;
  /**
   * Where the session-cwd chain places `agentPath` — the same question the
   * binding router asks before it stamps a folder, so the two guards read an
   * agent's desk identically (a `none` or boundary-refused agent's desk is the
   * default folder the chain chose, not a manifest guess).
   */
  placementOf(agentPath: string): Promise<TurnDeskPlacement>;
}

/**
 * Build the adapter's {@link TurnDeskCheck}.
 *
 * @param deps - The reads above.
 */
export function createTurnDeskCheck(deps: TurnDeskCheckDeps): TurnDeskCheck {
  return async ({ cwd, agentDirectory, forAgent, sessionKey }) => {
    const known = agentDirectory ?? (await deps.sessionAgentPath(sessionKey).catch(() => null));
    if (known && forAgent && path.resolve(known) !== path.resolve(forAgent)) {
      return 'This message named a different agent than the one it was sent to, so it was not run.';
    }
    const agent = known ?? forAgent;
    try {
      if (agent) {
        const placement = await deps.placementOf(agent);
        assertOwnDesk(agent, cwd, deskBindingFor(placement), placement.cwd);
      } else {
        assertNobodysDesk(cwd);
      }
      return null;
    } catch (err) {
      if (err instanceof DeskNotOwnError) return err.message;
      throw err;
    }
  };
}
