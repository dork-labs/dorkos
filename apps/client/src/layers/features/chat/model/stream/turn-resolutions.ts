/**
 * Which events in an in-progress turn answer a prompt the turn raised.
 *
 * @module features/chat/model/stream/turn-resolutions
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';

/**
 * Whether an event answers a prompt raised earlier in the turn. Each fold is a
 * no-op when its prompt is not in the parts it is given, so replaying these onto
 * a closed segment touches only the prompts that segment raised.
 *
 * @param event - Any event from the in-progress turn.
 */
export function isPromptResolution(event: SessionEvent): boolean {
  return (
    event.type === 'interaction_resolved' ||
    event.type === 'capability_approval_resolved' ||
    event.type === 'mcp_signin_resolved'
  );
}

/**
 * The interaction ids an `interaction_resolved` in this turn already answered.
 *
 * @param events - The in-progress turn's events.
 */
export function settledInteractionIds(events: SessionEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === 'interaction_resolved') ids.add(event.id);
  }
  return ids;
}
