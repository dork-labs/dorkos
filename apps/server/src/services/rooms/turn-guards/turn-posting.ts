/**
 * The warning a room turn logs when its session cannot post (spec
 * `tool-only-room-replies` §A2). It decides nothing; it only says so.
 *
 * @module services/rooms/turn-guards/turn-posting
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';

/**
 * Say so, once, when the session about to take a room turn has no posting verb
 * (spec `tool-only-room-replies` §A2).
 *
 * ## It decides nothing — that is the point of it
 *
 * A room turn speaks by calling `post_to_room`, by reacting, or not at all.
 * There is no second delivery to fall back to, so a session that cannot reach
 * the tool is not refused, not muted and not treated specially: it runs its
 * turn, and if it ends having put nothing in front of anybody the room writes
 * the ordinary `agent_declined` line for a person who asked. That is the
 * behaviour a graduated feature owes — one path, whatever the wiring is doing.
 *
 * What it costs is a DIAGNOSTIC, and this is it. An agent that has gone quiet
 * because its MCP entry never got built looks, from the room, exactly like an
 * agent exercising judgment. The earlier revision of this file resolved a reply
 * mode here and fell back to posting the turn's text, which hid the same wiring
 * gap behind an answer nobody chose to send; the honest trade is to keep the one
 * behaviour and put the gap on the log where an operator can find it.
 *
 * ## Why an unimplemented question says nothing
 *
 * `carriesRoomTools` is a positive claim. A runtime that does not implement it
 * is not asserting that the tools are missing — it has not thought about the
 * question — and warning on every such turn would bury the one line that means
 * something under a runtime's silence. So only an explicit `false`, or a
 * question that threw, is worth a line.
 *
 * @param opts.runtime - The runtime about to take the turn.
 * @param opts.cwd - **Where the turn will actually RUN** — the agent's home for
 *   every room turn (spec `agent-home-desk` §5.1). It is the run cwd that is
 *   asked about, because that is what the two runtimes that can be given these
 *   tools key their MCP configuration on. The runtime resolves it to its agent
 *   itself (DOR-2091).
 * @param opts.sessionId - The session the turn will run on.
 * @param opts.agentPath - The agent the turn is FOR, which the runtime checks
 *   the directory's owner against exactly as its turn will (DOR-2091).
 */
export async function warnIfTurnCannotPost(opts: {
  runtime: Pick<AgentRuntime, 'carriesRoomTools'>;
  cwd: string;
  sessionId: string;
  agentPath: string;
}): Promise<void> {
  const { runtime, ...session } = opts;
  if (runtime.carriesRoomTools === undefined) return;
  try {
    if (await runtime.carriesRoomTools(session)) return;
    logger.warn('[rooms] this turn has no way to post, so it can only stay silent', {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      // Named rather than implied: the reachable causes are a directory that
      // anchors to no registered agent — or to a different one than the turn is
      // for — and a runtime boundary that is not up, and both are wiring an
      // operator can act on.
      reason: 'the runtime reports that this session does not carry the DorkOS room tools',
    });
  } catch (err) {
    logger.warn('[rooms] could not tell whether this turn can post', {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
