/**
 * The one sentence an Ask leads with: who wants what.
 *
 * @module features/ask/lib/ask-headline
 */
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import { describeInteraction } from '@/layers/entities/attention';

/**
 * What to call the agent behind a prompt when nothing has resolved its name.
 *
 * The last segment of the working directory, which is what the operator calls
 * it anyway. The wire carries no name on purpose — a copied name goes stale the
 * moment an agent is renamed — so this is the honest floor, and a surface that
 * holds the roster passes the real name instead.
 *
 * @param cwd - The session's working directory.
 */
export function agentNameFromCwd(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd;
}

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
