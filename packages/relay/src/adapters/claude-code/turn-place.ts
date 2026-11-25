/**
 * Where a relay turn stands, who it runs as, and where its agent's manifest is
 * read from.
 *
 * @module relay/adapters/claude-code/turn-place
 */
import { sealedNewChatPlace } from '../../lib/carried-turn-limits.js';

/** Where a relay turn stands and as whom. */
export interface TurnPlace {
  /** The folder the sender named, which the host's desk check decides on. */
  senderCwd?: string;
  /** The folder the turn runs in; absent leaves it to the session. */
  cwd?: string;
  /** The home of the agent the turn runs as, when one is named. */
  forAgent?: string;
  /** Where the answering agent lives, so its manifest is read there. */
  agentDirectory?: string;
}

/** What {@link turnPlaceOf} reads. */
export interface TurnPlaceInput {
  /** The payload, when its sender may shape the turn; else `null`. */
  shaping: Record<string, unknown> | null;
  /** The payload as sent, for a place the server sealed onto it. */
  payload: unknown;
  /** The envelope's sender, which that seal names. */
  from: string;
  /** The key the turn runs under. */
  sessionKey: string;
  /** Whether the conversation has run before, so it is not a new chat. */
  started: boolean;
  /** The Mesh agent's home, when the subject named a registered agent. */
  contextDirectory?: string;
}

/**
 * Where this turn stands, in order: the folder a sender that may shape the
 * turn named, the home of the Mesh agent the subject names, then the place the
 * server sealed onto the message (DOR-5209). A sealed place counts only for a
 * sender that may not shape the turn, only when the subject names no Mesh
 * agent, only for a chat that has not run yet, and only for the chat and
 * sender it was sealed for. The agent the turn runs as comes from the sender's
 * `forAgent`, else that sealed place.
 *
 * The agent's manifest is read where the agent lives, never at the turn's
 * folder: a sender-named folder is a fact about this message, and a checkout
 * can carry a `.dork/agent.json` of its own. When the subject named no agent,
 * the host reads the chat's own agent instead (DOR-5057).
 *
 * @param input - The payload, its sender, and the turn's key and context.
 */
export function turnPlaceOf(input: TurnPlaceInput): TurnPlace {
  const { shaping, contextDirectory } = input;
  const senderCwd = shaping?.cwd as string | undefined;
  const senderForAgent =
    typeof shaping?.forAgent === 'string' && shaping.forAgent !== '' ? shaping.forAgent : undefined;
  const placed =
    input.started || shaping !== null || contextDirectory !== undefined
      ? undefined
      : sealedNewChatPlace(input.payload, input.from, input.sessionKey);
  const cwd = senderCwd ?? contextDirectory ?? placed?.cwd;
  const forAgent = senderForAgent ?? placed?.forAgent;
  const agentDirectory = contextDirectory ?? placed?.forAgent;
  return {
    ...(senderCwd !== undefined ? { senderCwd } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(forAgent !== undefined ? { forAgent } : {}),
    ...(agentDirectory !== undefined ? { agentDirectory } : {}),
  };
}
