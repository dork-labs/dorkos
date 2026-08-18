/**
 * Which prompts read as one decision, and which stay their own.
 *
 * @module features/ask/lib/group-asks
 */
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';

/** One entry in a rendered list of Asks: a lone prompt, or a burst. */
export type AskGroup =
  | { kind: 'single'; key: string; ask: InteractionPendingEvent }
  | { kind: 'stack'; key: string; asks: InteractionPendingEvent[] };

/**
 * Group a list of prompts into what the tray actually draws.
 *
 * Two or more prompts collapse into one stack only when all three of these hold:
 * the same session raised them, they are all permission prompts, and they name
 * the same tool. **Different agents never stack** — they are different decisions
 * by different people's work — and neither do different tools, because "Allow
 * all" over a read and a delete is a person answering something they were not
 * shown.
 *
 * Order is preserved: the first prompt of a group decides where the group sits,
 * so a list sorted by time left stays sorted.
 *
 * @param asks - The prompts to group, in the order they should appear.
 */
export function groupAsks(asks: readonly InteractionPendingEvent[]): AskGroup[] {
  const groups: AskGroup[] = [];
  const stackIndex = new Map<string, number>();

  for (const ask of asks) {
    if (ask.interaction.type !== 'approval') {
      groups.push({ kind: 'single', key: ask.interaction.id, ask });
      continue;
    }
    const signature = `${ask.sessionId}::${ask.interaction.toolName}`;
    const at = stackIndex.get(signature);
    if (at === undefined) {
      stackIndex.set(signature, groups.length);
      groups.push({ kind: 'single', key: ask.interaction.id, ask });
      continue;
    }
    const held = groups[at];
    if (held.kind === 'single') {
      groups[at] = { kind: 'stack', key: held.key, asks: [held.ask, ask] };
    } else {
      held.asks.push(ask);
    }
  }

  return groups;
}
