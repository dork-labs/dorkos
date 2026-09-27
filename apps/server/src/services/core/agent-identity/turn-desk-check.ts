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
import { readManifest } from '@dorkos/shared/manifest';
import type { TurnDeskCheck } from '@dorkos/relay';
import {
  assertOwnDesk,
  assertNobodysDesk,
  DeskNotOwnError,
  type DeskBinding,
} from './agent-home.js';

/** What {@link createTurnDeskCheck} reads, injected so a test needs no server. */
export interface TurnDeskCheckDeps {
  /** The agent a session was recorded for (`session_metadata.agent_path`), or `null`. */
  sessionAgentPath(sessionId: string): Promise<string | null>;
  /** How an agent's manifest says it works — `home` when it cannot be read. */
  deskBinding?(agentPath: string): Promise<DeskBinding>;
}

/** The binding an agent's manifest declares, read the way the cwd chain reads it. */
async function manifestDeskBinding(agentPath: string): Promise<DeskBinding> {
  try {
    const mode = (await readManifest(agentPath))?.workspace?.mode;
    return mode === 'none' ? 'none' : mode === 'managed' ? 'managed' : 'home';
  } catch {
    return 'home';
  }
}

/**
 * Build the adapter's {@link TurnDeskCheck}.
 *
 * @param deps - The reads above.
 */
export function createTurnDeskCheck(deps: TurnDeskCheckDeps): TurnDeskCheck {
  const bindingOf = deps.deskBinding ?? manifestDeskBinding;
  return async ({ cwd, agentDirectory, forAgent, sessionKey }) => {
    const known = agentDirectory ?? (await deps.sessionAgentPath(sessionKey).catch(() => null));
    if (known && forAgent && path.resolve(known) !== path.resolve(forAgent)) {
      return 'This message named a different agent than the one it was sent to, so it was not run.';
    }
    const agent = known ?? forAgent;
    try {
      if (agent) assertOwnDesk(agent, cwd, await bindingOf(agent));
      else assertNobodysDesk(cwd);
      return null;
    } catch (err) {
      if (err instanceof DeskNotOwnError) return err.message;
      throw err;
    }
  };
}
