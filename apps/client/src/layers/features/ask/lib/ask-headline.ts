/**
 * The one sentence an Ask leads with: who wants what.
 *
 * @module features/ask/lib/ask-headline
 */
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import { agentNameFromCwd, describeInteraction } from '@/layers/entities/attention';

/**
 * The headline for one Ask.
 *
 * Three shapes, one per kind, and each says only what the prompt said:
 *
 * | Kind        | Line                                   |
 * | ----------- | -------------------------------------- |
 * | approval    | `Meeting Notes wants to edit standup.md` |
 * | question    | `Meeting Notes has a question`         |
 * | elicitation | `Meeting Notes needs something from linear` |
 *
 * A permission prompt that named neither an action nor a path falls back to
 * `Meeting Notes needs your OK to run Bash` — the tool is the only true thing
 * left to say, and the card says that rather than inventing a verb.
 *
 * @param ask - The pending prompt.
 * @param agentName - What to call the agent; defaults to its directory's name.
 */
export function askHeadline(ask: InteractionPendingEvent, agentName?: string): string {
  const who = agentName ?? agentNameFromCwd(ask.cwd);
  return `${who} ${describeInteraction(ask.interaction)}`;
}
