/**
 * Which waiting apps ask again only because they now say where they show
 * (DOR-4282), so the Inbox can ask about them in one card.
 *
 * @module widgets/inbox-bell/lib/places-reask
 */
import { contributionWords } from '@dorkos/extension-api';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';

/** The fewest places-only re-asks that share one card; one alone keeps its own card. */
export const MIN_PLACES_GROUP = 2;

/** How many rows the card shows before "Show N more". */
export const PLACES_GROUP_VISIBLE = 5;

/**
 * Whether this re-ask adds nothing but places while the app keeps running:
 * the server says so (`placesOnly`, decided from the stored approval), and
 * the row shows no new host, program, agent access, runtime or app access,
 * and nothing it gives agents to read before the yes. Any of those, or an
 * app paused for any reason, and it keeps its own full card.
 *
 * @param approval - One waiting app.
 */
export function isPlacesOnlyReask(approval: PendingExtensionApproval): boolean {
  if (approval.placesOnly !== true) return false;
  const added = approval.added;
  if (!added || (added.slots ?? []).length === 0) return false;
  const addsPower =
    added.net.length > 0 ||
    added.run.length > 0 ||
    added.agents ||
    added.runtime ||
    (added.apps ?? []).length > 0;
  const givesAgents = approval.agentTools.length > 0 || approval.agentSkills.length > 0;
  // A row with a request code keeps its own card, which shows the code.
  return !addsPower && !givesAgents && approval.requestCode === undefined;
}

/**
 * The places a re-ask newly names, in DorkOS's own words and card order:
 * "a page and a status bar item". Never the app's words.
 *
 * @param approval - A places-only re-ask.
 */
export function newPlacesLine(approval: PendingExtensionApproval): string {
  const words = contributionWords(approval.added?.slots ?? []);
  if (words.length <= 1) return `adds ${words[0] ?? 'a place'}`;
  return `adds ${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The key one waiting copy is known by: an answer is about that copy.
 *
 * @param approval - One waiting app.
 */
export function reaskKeyOf(approval: PendingExtensionApproval): string {
  return `${approval.id}:${approval.path ?? ''}:${approval.version}`;
}
