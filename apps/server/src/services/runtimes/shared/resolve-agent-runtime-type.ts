/**
 * Which runtime an agent's unattended turn should run on.
 *
 * One rule, one copy. Rooms asked it first (`room-turn-runner.ts`), the relay
 * now asks the same question when a chat platform's first message needs a
 * session created for an agent (DOR-1614) and again when one agent messages
 * another directly (DOR-1627, through the adapter's `resolveTurnRuntimeType`
 * seam — which asks {@link resolveTurnRuntimeType} because that path binds its
 * own sessions too, DOR-1774), and the shared room-binding transcript probe asks
 * it a fourth time (`rooms/session-bindings/room-binding-transcripts.ts`,
 * DOR-805). A second copy of the manifest-then-default ladder is a second copy
 * that can disagree about which program answers for an agent.
 *
 * Two functions, and which one to call is decided by whether there is a SESSION:
 * {@link resolveAgentRuntimeType} answers for an agent that is about to get one,
 * {@link resolveTurnRuntimeType} for a turn on a session that may already have an
 * owner. A turn on an existing conversation must ask the second one — see
 * ADR-0255.
 *
 * @module services/runtimes/shared/resolve-agent-runtime-type
 */
import { readManifest } from '@dorkos/shared/manifest';
import { logger } from '../../../lib/logger.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';

/**
 * Which runtime an agent's turn should run on: its manifest's preference when
 * that runtime is registered in this process, otherwise the default.
 *
 * Mirrors `POST /api/sessions/:id/messages`, deliberately including the soft
 * fallback — a test-mode server registers only `test-mode` while every manifest
 * on disk says `claude-code`, and without the fallback no room and no chat
 * binding could ever trigger anything there.
 *
 * **The fallback SAYS so.** It is still a different program answering under
 * that agent's name, and the one thing that must never be true of it is that it
 * happened quietly: an operator whose codex agent is replying in Claude Code
 * has no other way to learn that this build never started codex. Logged at
 * `warn` on the substitution alone — an agent whose manifest names a runtime
 * this process holds takes the rung above and says nothing.
 *
 * Swallows its own manifest read: an agent with no manifest, or an unreadable
 * one, is not a reason to refuse a turn — the default is the right answer, and
 * it is silent, because nothing asked for anything else.
 *
 * @param agentPath - The agent's project directory, the one holding `.dork/agent.json`.
 */
export async function resolveAgentRuntimeType(agentPath: string): Promise<string> {
  try {
    const manifest = await readManifest(agentPath);
    if (manifest?.runtime) {
      if (runtimeRegistry.has(manifest.runtime)) return manifest.runtime;
      logger.warn(
        `[runtimes] '${agentPath}' runs on '${manifest.runtime}', which this server did not ` +
          `start; its turns will be answered by '${runtimeRegistry.getDefaultType()}' instead.`
      );
    }
  } catch {
    // No manifest, or an unreadable one. The default is the right answer.
  }
  return runtimeRegistry.getDefaultType();
}

/**
 * Which runtime one TURN runs on: the session's recorded owner once it has one,
 * and only for a session nobody owns yet, {@link resolveAgentRuntimeType}.
 *
 * **A session's runtime is decided once and never recomputed (ADR-0255).** The
 * manifest is a preference about the NEXT session an agent starts, not a fact
 * about the ones it is already in the middle of: editing it while a conversation
 * is running used to reroute that conversation's remaining turns to a different
 * program, which has no transcript for the session id it is handed and answers
 * from an empty context — while `session_metadata` still named the old owner,
 * because `persistSessionRuntime` refuses to re-bind (DOR-764). So a manifest
 * change takes effect on the next session — the same OUTCOME every other
 * unattended surface already gives, by its own mechanism rather than this one:
 * the cockpit routes on the binding (`resolveForSession`), a scheduled run pins
 * the runtime it resolved onto `pulse_runs.resolved_runtime` for that run, and
 * the relay keeps a chat subject on the session its first message created.
 * Rooms were the surface with no such memory at all, and an agent-to-agent DM
 * was the second: a mesh subject creates no session, so nothing recorded an
 * owner for it until the relay adapter started writing one at the first turn
 * that actually ran (DOR-1774).
 *
 * The manifest rung is not a fallback from the binding — it is the answer for a
 * session that HAS no owner, which is every session's first turn. Asking the
 * registry alone would be worse than asking the manifest alone: an unbound id
 * resolves through the registry's legacy inference, so a codex agent's opening
 * room turn would run on claude-code.
 *
 * **A bound runtime this server does not have is a refusal, not a redirect.** It
 * travels back as the type it is, and the caller's `runtimeRegistry.get` throws
 * — the same answer `resolveForSession` gives the session routes. Falling back
 * to the manifest there would be the very re-decision this exists to prevent,
 * and it would hand the conversation to a program with none of its history.
 *
 * @param turn.sessionId - The session the turn will run on, or `null` when the
 *   caller is about to mint one. A non-null id that nothing has bound yet — a
 *   placeholder from a turn that never started, a row that was never written —
 *   is the same case as `null` and takes the manifest rung too.
 * @param turn.agentPath - The agent's project directory, the one holding
 *   `.dork/agent.json`.
 */
export async function resolveTurnRuntimeType(turn: {
  sessionId: string | null;
  agentPath: string;
}): Promise<string> {
  if (turn.sessionId !== null) {
    const { type, bound } = await runtimeRegistry.resolveSessionRuntime(turn.sessionId);
    if (bound) return type;
  }
  return resolveAgentRuntimeType(turn.agentPath);
}
