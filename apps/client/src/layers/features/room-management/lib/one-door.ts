/**
 * One door to an agent: picking one opens its session, picking two or more
 * starts a group message (`sidebar-simplification` spec D2).
 *
 * The rule lives here rather than inside the picker because two surfaces read
 * it and they must never disagree — the button's own words, and the callback
 * that decides where pressing it lands. A label saying "Open session with Ana"
 * over a handler that made a room would be the worst of both.
 *
 * @module features/room-management/lib/one-door
 */
import type { AgentPickerCandidate } from '@/layers/entities/agent';

/**
 * The rule, said out loud under the picker.
 *
 * Stated rather than discovered: the button changes its words as the second
 * agent goes in, and a control that changes what it does needs to have said so
 * before it does it.
 */
export const ONE_DOOR_HINT = 'One agent opens a session. Two or more start a group message.';

/**
 * Whether this selection opens an agent's session rather than making a room.
 *
 * Exactly one agent is a session — the same conversation its sidebar row opens,
 * which is what makes it one door and not two. A 1:1 direct message was a
 * session in disguise: the same agent, the same working directory, and a log
 * that showed its final words and none of its work.
 *
 * **"The same conversation", to the letter:** the same resolve-or-mint lookup
 * (`resolveSessionForCwd`) and the same address. The one difference is what gets
 * remembered — the sidebar row records the session it landed on as well as the
 * agent, while this records the agent only, because the picker's callback is not
 * handed the id it resolved. That is the command palette's behaviour too, and it
 * costs Today's ordering nothing that opening the conversation does not
 * immediately fix.
 *
 * @param chosen - The agents picked, in the order they were picked.
 */
export function opensAgentSession(chosen: readonly AgentPickerCandidate[]): boolean {
  return chosen.length === 1;
}

/**
 * What the picker's commit button says for this selection.
 *
 * @param chosen - The agents picked, in the order they were picked.
 */
export function oneDoorSubmitLabel(chosen: readonly AgentPickerCandidate[]): string {
  const only = chosen[0];
  if (only !== undefined && opensAgentSession(chosen))
    return `Open session with ${only.displayName}`;
  return 'Start group message';
}
