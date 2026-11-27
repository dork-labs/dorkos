/**
 * The words a chat tree says for a chat that has not run: one still starting,
 * and one that never started and why.
 *
 * @module features/chat-list/model/chat-tree-words
 */

/**
 * Why a chat never started, by the reason its run recorded: the run's
 * `cancelledBecause`, else how it ended, else its status.
 */
const NEVER_STARTED_REASONS: Record<string, string> = {
  cancelled: 'cancelled',
  expired: 'waited too long',
  invalid_agent_path: 'its agent’s folder is gone',
  refused_busy: 'the chat was busy',
  removed: 'taken out of line',
  room_session_moved: 'its room moved to another chat',
  runtime_mismatch: 'wrong runtime for this chat',
  session_gone: 'the chat was deleted',
  start_failed: 'it failed to start',
  start_lost: 'lost in a restart',
  superseded: 'replaced by a newer start',
  failed: 'it failed to start',
  refused: 'the runtime refused it',
  shutdown: 'DorkOS shut down',
  process_died: 'its process stopped',
  stopped: 'stopped',
  limited: 'out of usage',
};

/** What a chat that is still starting says, by where its run is. */
const LAUNCHING_WORDS: Record<'queued' | 'starting', string> = {
  queued: 'Waiting to start',
  starting: 'Starting',
};

/**
 * What a chat that never started says: "Didn't start", and why when the
 * reason is one this build has words for.
 *
 * @param reason - The reason its run recorded.
 */
export function neverStartedWords(reason: string): string {
  const why = NEVER_STARTED_REASONS[reason];
  return why === undefined ? 'Didn’t start' : `Didn’t start: ${why}`;
}

/**
 * What a chat that is still starting says.
 *
 * @param status - Where its run is: waiting its turn, or being started.
 */
export function launchingWords(status: 'queued' | 'starting'): string {
  return LAUNCHING_WORDS[status];
}
