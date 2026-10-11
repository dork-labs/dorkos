/**
 * The PR 4 manners a raise to a person meets before the outbox holds it (spec
 * `heartbeats` §9.2, canon P4 and P6), in order:
 *
 * 1. **Raise once, then track.** An open raise (delivered, not resolved) with
 *    the same key from the same agent is not sent again: it moves to the
 *    agent's next report, marked still open. An urgent raise of something
 *    first raised as routine goes now: urgency is new news (P6).
 * 2. **Away.** A raise to an away person would go one step up when someone is
 *    above them, but that is not wired yet: the running server's `personAbove`
 *    answers null (one person per server). At the top, an urgent raise goes now
 *    and a routine one waits for their return. A report line never steps up.
 * 3. **De-duplication across agents.** A raise whose `about` keys overlap one
 *    another agent already delivered or has waiting for the same reader within
 *    {@link DEDUP_WINDOW_MS} is dropped. An urgent raise is dropped only for
 *    another urgent one. A line queued for someone's report cancels only other
 *    report lines, never a message of its own. Settled raises are left out.
 *    The agent's own earlier raises are raise-once's business, not this.
 *
 * Pure decisions over the store and a few seams; the outbox carries them out
 * and writes the record lines.
 *
 * @module services/heartbeats/raises/raise-manners
 */
import type { EndBeatRaise } from '@dorkos/shared/heartbeat-schemas';
import type { PersonPresence } from './delivery-time.js';
import type { PriorRaise, RaiseStore } from './raise-store.js';
import { recordHeartbeatEvent } from '../record.js';

/** How far back de-duplication looks: seven days. */
export const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Which way a raise went when its reader was away. */
export type AwayRoute = 'stepped-up' | 'urgent-now' | 'waits';

/** Where a raise to a person goes. */
export type RaiseRoute =
  | { kind: 'deliver'; to: string; away?: AwayRoute; awayFrom?: string }
  | { kind: 'still-open' }
  | { kind: 'duplicate'; by: string };

/** What the manners read. */
export interface MannersDeps {
  /** The report queue and open raises. */
  raises: RaiseStore;
  /** A person's hours and away state. */
  presenceOf(personAccountId: string): PersonPresence;
  /** Who a raise with no `to` goes to: the agent's manager. */
  managerOf(agentId: string): string;
  /**
   * The person one step above a person, or null at the top. One person per
   * server today, so the running server answers null; people get managers of
   * their own with DOR-2743.
   */
  personAbove?(personAccountId: string): string | null;
}

/**
 * Whether a person is away at a moment.
 *
 * @param presence - Their hours and away state.
 * @param now - Epoch ms.
 */
export function isAway(presence: PersonPresence, now: number): boolean {
  const { away } = presence;
  if (!away) return false;
  if (away.until === null) return true;
  const until = Date.parse(away.until);
  return Number.isNaN(until) || until > now;
}

/**
 * Where one raise to a person goes.
 *
 * @param deps - What the manners read.
 * @param input - The raise and who it is for.
 * @param input.agentId - The agent raising it.
 * @param input.raise - The raise.
 * @param input.key - Its key.
 * @param input.to - The person it is addressed to.
 * @param input.forReport - A `report` raise: it never steps up past an away reader.
 * @param input.now - Epoch ms.
 */
export function routeRaise(
  deps: MannersDeps,
  input: {
    agentId: string;
    raise: EndBeatRaise;
    key: string;
    to: string;
    forReport: boolean;
    now: number;
  }
): RaiseRoute {
  const { agentId, raise, key, now } = input;
  const urgent = raise.urgent === true;
  const open = deps.raises.openRaise(agentId, key);
  if (open && !(urgent && open.urgent !== 1)) return { kind: 'still-open' };

  let route: RaiseRoute = { kind: 'deliver', to: input.to };
  if (!input.forReport && isAway(deps.presenceOf(input.to), now)) {
    const above = deps.personAbove?.(input.to) ?? null;
    route = above
      ? { kind: 'deliver', to: above, away: 'stepped-up', awayFrom: input.to }
      : { kind: 'deliver', to: input.to, away: urgent ? 'urgent-now' : 'waits' };
  }
  const by = duplicateOf(deps, { agentId, raise, to: route.to, forReport: input.forReport, now });
  return by ? { kind: 'duplicate', by } : route;
}

/**
 * The agent that already raised what this raise is about, or null.
 *
 * @param deps - What the manners read.
 * @param input - The raise and its reader.
 * @param input.agentId - The agent raising it.
 * @param input.raise - The raise.
 * @param input.to - Its reader.
 * @param input.forReport - A `report` raise, which queued report lines may cancel.
 * @param input.now - Epoch ms.
 */
function duplicateOf(
  deps: MannersDeps,
  input: { agentId: string; raise: EndBeatRaise; to: string; forReport: boolean; now: number }
): string | null {
  const about = input.raise.about ?? [];
  if (about.length === 0) return null;
  const wanted = new Set(about);
  const urgent = input.raise.urgent === true;
  const since = new Date(input.now - DEDUP_WINDOW_MS).toISOString();
  const hit = deps.raises.recentTo(input.to, since).find((prior) => {
    if (prior.agentId === input.agentId) return false;
    if (prior.fromReport && prior.waiting && !input.forReport) return false;
    if (!readsIt(deps, prior, input.to)) return false;
    if (!prior.about.some((k) => wanted.has(k))) return false;
    return !urgent || prior.urgent;
  });
  return hit?.agentId ?? null;
}

/**
 * Whether a prior raise reaches this reader: its own reader, or for a report
 * line with none, whoever that agent's report goes to.
 *
 * @param deps - What the manners read.
 * @param prior - The prior raise.
 * @param to - The reader.
 */
function readsIt(deps: MannersDeps, prior: PriorRaise, to: string): boolean {
  return (prior.toAccount ?? deps.managerOf(prior.agentId)) === to;
}

/**
 * The record line for a raise the manners turned aside or re-routed, or
 * nothing for one that goes on as raised.
 *
 * @param agent - The agent raising it.
 * @param agent.id - Its mesh id.
 * @param agent.name - Its display name.
 * @param route - Where it went.
 * @param nameOf - An agent's display name by id.
 */
export function recordRoute(
  agent: { id: string; name: string },
  route: RaiseRoute,
  nameOf: (agentId: string) => string
): void {
  const line = routeLine(route, nameOf);
  if (!line) return;
  recordHeartbeatEvent({
    action: line.action,
    agent,
    actAsAgent: true,
    summary: line.summary,
    ...(line.reason ? { reason: line.reason } : {}),
  });
}

/** The words for {@link recordRoute}. */
function routeLine(
  route: RaiseRoute,
  nameOf: (agentId: string) => string
): { action: string; summary: string; reason?: string } | null {
  switch (route.kind) {
    case 'still-open':
      return {
        action: 'heartbeat.deduplicated',
        summary: 'Already raised and still open, so it goes in the next report.',
      };
    case 'duplicate':
      return {
        action: 'heartbeat.deduplicated',
        summary: `Already raised by ${nameOf(route.by)}.`,
      };
    case 'deliver':
      if (route.away === 'stepped-up') {
        return {
          action: 'heartbeat.raised',
          summary: 'Its reader is away, so it went one step up.',
          reason: `away: ${route.awayFrom ?? ''}`,
        };
      }
      if (route.away === 'urgent-now') {
        return {
          action: 'heartbeat.raised',
          summary: 'Its reader is away; urgent, so it was not held for their return.',
        };
      }
      if (route.away === 'waits') {
        return {
          action: 'heartbeat.held',
          summary: 'Its reader is away; it waits for their return.',
        };
      }
      return null;
  }
}
