/**
 * The tool-read mark (DOR-3291, `specs/turn-marks/design-note.md`): a turn that got a third
 * party's text through a tool's result is marked from that moment to its end.
 *
 * ## Where it is minted
 *
 * - **DorkOS's own actions**, at the one seam every capability passes (`registry.ts` `invoke`):
 *   an action that declares `readsOutside` marks the calling turn after its handler returns and
 *   before its result reaches the turn. An extension's actions always mark.
 * - **A runtime's own tools** (Claude Code's `WebFetch`, `WebSearch`, a file read outside the
 *   agent's folders), from the runtime's after-the-tool hook, which runs before the result goes
 *   back to the model.
 *
 * Both read only what the tool is, never what the model said, and no agent-callable tool can set
 * or clear the mark: it is set here and lasts until the next turn on the conversation records.
 *
 * ## What it does
 *
 * Nothing of its own: it sets the outsider mark beside itself, and the outsider mark's readers do
 * the rest (the permission gate, the marked-turn holds, the destructive hold, memory stamps, and
 * every hand-off: room posts, `chat_send`, `session_start`). The `toolRead` field only names the
 * source, for the owner's approval card (`managed-turn-marks.ts`).
 *
 * @module services/core/turn-power/tool-read-marks
 */
import { marksOf, noteTurnReadOutside } from './turn-levels.js';
import { chatHeardOutsider } from '../../session/origin/outsider-turns.js';
import { noteAgentReadOutside } from './live-outsider-turns.js';

/** Who made the call that read: the facts the surface verified, never anything in the input. */
export interface ToolReadCaller {
  /** The calling session, when the surface verified one. */
  sessionId?: string;
  /** The calling agent's home, from its verified identity. */
  agentPath?: string;
}

/**
 * Mark the caller's turn as one that read a third party's text. The session's recorded turn when
 * there is one; otherwise every turn its agent runs for a while, which a caller that cannot name
 * its session is read through (`marksOf`). A caller with neither marks nothing here: its later
 * calls cannot be placed in any turn, and an unplaced caller is read as an outsider already.
 *
 * @param caller - The verified session and agent.
 */
export function markToolRead(caller: ToolReadCaller): void {
  if (caller.sessionId && noteTurnReadOutside(caller.sessionId)) return;
  if (caller.agentPath) noteAgentReadOutside(caller.agentPath);
}

/**
 * Whether reading another chat hands the reader outside words: a stranger reached that chat
 * (`chatHeardOutsider`), or its latest turn carries the outsider mark (it read a stranger's line or
 * a tool's outside text). Our own agents' chats are team members' words and mark nothing (DOR-3291
 * brief, rule 4); only what reached them from outside rides on.
 *
 * @param chatId - The chat that was read.
 */
export function chatReadsOutside(chatId: string): boolean {
  return chatHeardOutsider(chatId) || marksOf(chatId, undefined).outsider === true;
}

/**
 * Whether a declared provenance marks this result: `true` always, a function on the input and the
 * result. A function that throws marks: unknown counts as marked.
 *
 * @param readsOutside - The action's declaration, or `undefined` for own state only.
 * @param input - The parsed input the action ran on.
 * @param output - What it returned.
 * @param deps - The registry's service bag, for a declaration that looks a row up.
 */
export function resultReadsOutside<I, O, D>(
  readsOutside: true | ((input: I, output: O, deps: D) => boolean) | undefined,
  input: I,
  output: O,
  deps: D
): boolean {
  if (readsOutside === undefined) return false;
  if (readsOutside === true) return true;
  try {
    return readsOutside(input, output, deps);
  } catch {
    return true;
  }
}
