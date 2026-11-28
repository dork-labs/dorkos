/**
 * The lists `list-paging` never counts (DOR-4982). A list GET belongs here
 * only when paging it is wrong or premature, never because paging is work:
 *
 * - `avoid-list`: the architect asked to leave it alone, because a later
 *   roadmap step removes or rebuilds it (relay views, connection events,
 *   per-chat reads).
 * - `order-not-reproducible`: no stable order to page on (live interactions,
 *   search relevance).
 * - `small-fixed`: a small, fixed or one-resource view, bounded by what the
 *   computer holds rather than by use (a few runtimes, one agent's settings).
 * - `waits-later-item`: a later item reshapes it first (the rooms and mini
 *   app inbox lists); it is judged again when that lands.
 *
 * Adding an entry takes a reason and the API lead's review
 * (`contributing/api-reference.md`, "Lists that never page"). The tests in
 * `scripts/__tests__/check-api-lint-list-paging-exemptions.test.ts` fail when
 * an entry has no reason, or when it no longer matches an unpaged list in the
 * committed document (renamed, removed or paged): drop it in that PR.
 *
 * @module scripts/api-lint/list-paging-exemptions
 */
import type { Items } from './rules.ts';

/** Why a list never pages. */
export type ListPagingExemptionCategory =
  'avoid-list' | 'order-not-reproducible' | 'small-fixed' | 'waits-later-item';

/** Every category, for the tests. */
export const LIST_PAGING_EXEMPTION_CATEGORIES: readonly ListPagingExemptionCategory[] = [
  'avoid-list',
  'order-not-reproducible',
  'small-fixed',
  'waits-later-item',
];

/** One list `list-paging` never counts. */
export interface ListPagingExemption {
  /** Always `GET`: only list GETs are judged. */
  readonly method: 'GET';
  /** The path as the OpenAPI document writes it (`{param}`). */
  readonly path: string;
  /** Which kind of list it is. */
  readonly category: ListPagingExemptionCategory;
  /** One line on why. */
  readonly reason: string;
}

const RELAY = 'Relay message view; the one message system (roadmap item 17) retires it.';
const EVENTS = 'Connection events wait for one wake (roadmap item 9).';
const PER_CHAT = "One chat's own read; the architect keeps per-chat reads out of paging.";
const ROOMS = 'Room lists wait for the rooms and mini app rework; paged then if still a list.';
const RUNTIME = "One runtime's accounts on this computer: a handful at most.";

const e = (
  path: string,
  category: ListPagingExemptionCategory,
  reason: string
): ListPagingExemption => ({ method: 'GET', path, category, reason });

/** Every list `list-paging` never counts, grouped by category. */
export const LIST_PAGING_EXEMPTIONS: readonly ListPagingExemption[] = [
  // The architect's avoid list.
  e('/api/relay/dead-letters', 'avoid-list', RELAY),
  e('/api/relay/endpoints', 'avoid-list', RELAY),
  e('/api/relay/messages', 'avoid-list', RELAY),
  e('/api/relay/unclaimed-chats', 'avoid-list', RELAY),
  e('/api/connectors/connections/{connectionId}/events/definitions', 'avoid-list', EVENTS),
  e('/api/connectors/connections/{connectionId}/events/subscriptions', 'avoid-list', EVENTS),
  e('/api/sessions/{id}/canvas', 'avoid-list', PER_CHAT),
  e('/api/sessions/{id}/chat-messages', 'avoid-list', PER_CHAT),
  e('/api/sessions/{id}/limit-history', 'avoid-list', PER_CHAT),
  e('/api/sessions/{id}/messages', 'avoid-list', PER_CHAT),
  e('/api/sessions/{id}/queue', 'avoid-list', PER_CHAT),
  e('/api/sessions/{id}/tasks', 'avoid-list', PER_CHAT),
  // No order that holds still between two pages.
  e(
    '/api/sessions/pending-interactions',
    'order-not-reproducible',
    'Prompts live chats wait on; they come and go between reads.'
  ),
  e('/api/search', 'order-not-reproducible', 'Ranked by relevance, which shifts between reads.'),
  // Small, fixed or one-resource views.
  e(
    '/api/agents/{agentId}/heartbeat',
    'small-fixed',
    "One agent's Heartbeat page: its last 50 beats."
  ),
  e('/api/agents/{agentId}/permissions', 'small-fixed', "One agent's state per area and action."),
  e(
    '/api/agents/{agentId}/work-queue',
    'small-fixed',
    "One agent's queue page: waiting, running, recently ended."
  ),
  e('/api/canvas/docs/{id}/routes', 'small-fixed', "One document's declared event routes."),
  e('/api/config/backups', 'small-fixed', 'The few database backups kept on this computer.'),
  e(
    '/api/connectors/mini-app-access',
    'small-fixed',
    'What installed mini apps may read: one page, read whole.'
  ),
  e('/api/connectors/providers', 'small-fixed', 'One setup state per provider: a fixed set.'),
  e('/api/connectors/spending', 'small-fixed', "This month's spend limit and spending: one view."),
  e('/api/devices/sign-in-requests', 'small-fixed', 'Open sign-in requests expire in minutes.'),
  e('/api/harness/status', 'small-fixed', "One project's agent files by agent tool: one table."),
  e('/api/health/deep', 'small-fixed', 'One row per setup check.'),
  e('/api/local-browser/handoff/state', 'small-fixed', "This computer's one browser hand-off."),
  e('/api/local-browser/state', 'small-fixed', 'One browser connection.'),
  e('/api/marketplace/updates', 'small-fixed', 'One update check per installed package.'),
  e('/api/mesh/topology', 'small-fixed', 'The agent network, read whole to draw it.'),
  e('/api/models', 'small-fixed', 'The models a runtime offers: a short fixed list.'),
  e('/api/owner-factors', 'small-fixed', "The owner's few sign-in factors."),
  e('/api/permissions', 'small-fixed', 'The default permissions: one view per area.'),
  e('/api/runtimes/{type}/accounts/usage', 'small-fixed', RUNTIME),
  e('/api/runtimes/claude-code/account-eligibility', 'small-fixed', RUNTIME),
  e('/api/runtimes/claude-code/accounts/found', 'small-fixed', RUNTIME),
  e('/api/runtimes/claude-code/signins', 'small-fixed', RUNTIME),
  e('/api/session-relay/devices', 'small-fixed', 'Browsers seen at this computer: a few.'),
  e('/api/session-relay/passkeys', 'small-fixed', "The owner's few passkeys."),
  e('/api/session-relay/presence', 'small-fixed', 'Who uses this computer from the web now.'),
  e('/api/sessions/daily-counts', 'small-fixed', 'One count per day, 31 days at most.'),
  e('/api/sessions/running', 'small-fixed', 'Turns running now, capped by the run limit.'),
  // Wait for a later item that reshapes them.
  e('/api/rooms', 'waits-later-item', ROOMS),
  e('/api/rooms/threads', 'waits-later-item', ROOMS),
  e('/api/rooms/{id}/canvas', 'waits-later-item', ROOMS),
  e('/api/rooms/{id}/entries', 'waits-later-item', ROOMS),
  e('/api/rooms/{id}/files', 'waits-later-item', ROOMS),
  e('/api/rooms/{id}/repo/status', 'waits-later-item', ROOMS),
  e('/api/rooms/{id}/sessions', 'waits-later-item', ROOMS),
  e('/api/team/{memberId}/rooms', 'waits-later-item', ROOMS),
  e('/api/extension-decisions', 'waits-later-item', 'The mini app inbox, reshaped with rooms.'),
  e(
    '/api/extensions/{id}/decisions',
    'waits-later-item',
    'The mini app inbox, reshaped with rooms.'
  ),
];

const labelOf = (x: ListPagingExemption) => `${x.method} ${x.path}`;

/**
 * The findings less every exempt list; a group left empty is dropped.
 *
 * @param items - What `listPagingItems` found.
 * @param exemptions - The lists never counted.
 */
export function withoutExemptLists(
  items: Items,
  exemptions: readonly ListPagingExemption[] = LIST_PAGING_EXEMPTIONS
): Items {
  const exempt = new Set(exemptions.map(labelOf));
  const kept: Items = {};
  for (const [unit, labels] of Object.entries(items)) {
    const left = labels.filter((l) => !exempt.has(l));
    if (left.length > 0) kept[unit] = left;
  }
  return kept;
}

/**
 * Exemptions that match no unpaged list: renamed, removed or paged since.
 *
 * @param items - What `listPagingItems` found, before exemptions.
 * @param exemptions - The lists never counted.
 */
export function staleExemptions(
  items: Items,
  exemptions: readonly ListPagingExemption[] = LIST_PAGING_EXEMPTIONS
): string[] {
  const found = new Set(Object.values(items).flat());
  return exemptions.map(labelOf).filter((l) => !found.has(l));
}
