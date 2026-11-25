/**
 * Where a relay turn stands, who it runs as, and where its agent's manifest is
 * read from.
 *
 * @module relay/adapters/claude-code/turn-place
 */
import { describeError } from '../../lib/describe-error.js';
import { carriesUnsealedNewChat, sealedNewChatPlace } from '../../lib/carried-turn-limits.js';
import type { ChatPlaceRecall, RecalledChatPlace } from './types.js';

/** Why a new chat whose place the server did not seal for this sender does not start. */
export const NEW_CHAT_PLACE_UNCHECKED =
  "This new chat's folder couldn't be checked, so it didn't start. Send the message again.";

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
  /** Set when the turn opens a new chat where the server sealed it, so its agent is recorded. */
  newChat?: true;
  /** Why the turn may not run, in plain words. */
  refusal?: string;
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
  /** Where the host records the chat as standing, when it has run before. */
  recalled?: RecalledChatPlace | null;
}

/**
 * Where this turn stands, in order: the folder a sender that may shape the
 * turn named, the home of the Mesh agent the subject names, the place the
 * server sealed onto the message for a new chat (DOR-5209), then, for a chat
 * that has run before, its own folder as the host records it (DOR-5245). A
 * sealed place counts only for a sender that may not shape the turn, only when
 * the subject names no Mesh agent, only for a chat that has not run yet, and
 * only for the chat and sender it was sealed for. Such a new chat that carries
 * a place nobody sealed for its sender is refused rather than run in the
 * default folder. The agent the turn runs as comes from the sender's
 * `forAgent`, else that sealed place, else the chat's recorded agent.
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
  const mayPlace = !input.started && shaping === null && contextDirectory === undefined;
  const placed = mayPlace
    ? sealedNewChatPlace(input.payload, input.from, input.sessionKey)
    : undefined;
  const unsealed = mayPlace && carriesUnsealedNewChat(input.payload, input.from);
  const recalled =
    input.started && senderCwd === undefined && contextDirectory === undefined
      ? input.recalled
      : undefined;
  const cwd = senderCwd ?? contextDirectory ?? placed?.cwd ?? recalled?.cwd;
  const forAgent = senderForAgent ?? placed?.forAgent ?? recalled?.forAgent;
  const agentDirectory = contextDirectory ?? placed?.forAgent;
  const refusal = unsealed ? NEW_CHAT_PLACE_UNCHECKED : undefined;
  return {
    ...(senderCwd !== undefined ? { senderCwd } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(forAgent !== undefined ? { forAgent } : {}),
    ...(agentDirectory !== undefined ? { agentDirectory } : {}),
    ...(placed?.forAgent !== undefined ? { newChat: true as const } : {}),
    ...(refusal !== undefined ? { refusal } : {}),
  };
}

/** What {@link resolveTurnPlace} reads beyond {@link TurnPlaceInput}. */
export interface TurnPlaceSources {
  /** The host's record of where a chat stands. */
  recallChatPlace?: ChatPlaceRecall;
}

/**
 * {@link turnPlaceOf}, after asking the host where the chat stands when the
 * sender and the subject name no folder. The chat has run before when a
 * previous turn persisted its SDK session id, or when the host holds it: a
 * runtime that keeps the key it was given persists no id of its own, and its
 * first turn records the chat with the host. A runtime holding a key in memory
 * is not enough, since a settings change creates a session that never ran. A
 * host lookup that fails is logged and read as "nothing recorded".
 *
 * @param input - As {@link turnPlaceOf}, with `persisted` in place of `started`.
 * @param sources - The host's record.
 * @param log - Where a failed lookup is reported.
 */
export async function resolveTurnPlace(
  input: Omit<TurnPlaceInput, 'started' | 'recalled'> & { persisted: boolean },
  sources: TurnPlaceSources,
  log: Pick<Console, 'warn'>
): Promise<TurnPlace> {
  const { persisted, ...rest } = input;
  const recall = sources.recallChatPlace;
  const asks = input.contextDirectory === undefined && input.shaping?.cwd === undefined;
  const recalled =
    recall && asks
      ? await recall({ sessionKey: input.sessionKey }).catch((err: unknown) => {
          log.warn('[CCA] could not read where %s stands:', input.sessionKey, describeError(err));
          return null;
        })
      : null;
  const started = persisted || recalled !== null;
  return turnPlaceOf({ ...rest, started, recalled });
}
