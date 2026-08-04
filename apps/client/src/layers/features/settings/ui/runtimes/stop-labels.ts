/**
 * How the Runtimes tab words the three trust stops (design §3).
 *
 * One vocabulary for the whole tab: the global row and every card's own dial say
 * the same three things, so a person who reads the row and then opens a card is
 * answering one question twice, not two questions once each.
 *
 * Deliberately not the Trust Dial's own `stopLabel()`, which names the position a
 * person picks against one runtime's promise ("Ask first", "Act"). Settings is
 * read cold, months later, by somebody who did not set it — so the words here are
 * a sentence about behaviour rather than a command, which is the same re-cut the
 * card summary makes in its own, shorter voice (`RuntimeCardSummary`).
 *
 * @module features/settings/ui/runtimes/stop-labels
 */
import type { PermissionStop } from '@dorkos/shared/agent-runtime';

/** The three stops, as every control on the Runtimes tab names them. */
export const SETTINGS_STOP_LABELS: Record<PermissionStop, string> = {
  ask: 'Asks before acting',
  act: 'Pauses at big steps',
  autonomy: 'Full autonomy',
};
