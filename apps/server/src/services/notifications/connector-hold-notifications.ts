/**
 * What DorkOS says around an agent's held irreversible action in a connected
 * app (spec `trusted-by-default-flip` §5.6, DOR-2739): the row everyone sees
 * while it waits, with Cancel, and the row that replaces it once it ends.
 *
 * Declared here and spread into the registry, which reads exactly like any
 * other entry. The emitter is `services/connectors/execution/destructive-hold.ts`.
 *
 * ## Why both kinds are events, not standing conditions
 *
 * A standing kind writes no row while it stands; the app draws it from a store
 * it already holds. The hold lives in memory for sixty seconds and the app holds
 * no store for it, so a standing kind would put nothing on any screen. An event
 * row reaches every open window the moment it is written, and its Cancel button
 * is what makes "anyone may cancel" true in practice.
 *
 * ## One subject per hold, and a window of zero
 *
 * Every row about one hold files under the hold's id as its subject, so the
 * row that says how it ended sits with the row that said it was waiting, and
 * the app stops offering Cancel once a later row for the same hold arrives.
 * The two kinds keep distinct dedupe keys, because dedupe and the delivery
 * ledger are keyed across kinds (`notification-registry.test.ts` pins that).
 * The waiting row's window is zero for the same reason `signin.required`'s
 * is: its ending row shares its key and comes within a minute, and any
 * positive window would swallow it.
 *
 * Nothing here carries the action's arguments or the account: these rows are
 * what a phone's lock screen shows.
 *
 * @module services/notifications/connector-hold-notifications
 */
import type { NotificationActionDTO } from '@dorkos/shared/notification-schemas';
import type { NotificationRegistryEntry } from './notification-registry.js';

/** What every row about one held action names. */
interface HeldActionSubject {
  /** The hold. The rows' subject, and what Cancel cancels. */
  holdId: string;
  /** The agent that asked, when it has a Mesh id. The lens key. */
  agentId?: string;
  /** What to call that agent. */
  agentName: string;
  /** The chat it asked from. Open goes there. */
  sessionId: string;
  /** The action, in the app's own words, e.g. `Delete message`. */
  actionName: string;
  /** The app, e.g. `Gmail`. */
  serviceName: string;
}

/**
 * How a held action ended without running, or without DorkOS knowing.
 *
 * - `cancelled` — a person or another agent cancelled it; `by` names them.
 * - `stopped` — the chat that asked was stopped, which cancels it.
 * - `changed` — when its 60 seconds were up it no longer qualified to run
 *   without asking (the install moved to Careful, the agent was switched
 *   off, the turn changed, or DorkOS could not record that it was let run).
 * - `restarted` — DorkOS restarted while it waited, and dropped it.
 * - `interrupted` — DorkOS restarted after it was let run, so it may have run.
 */
export type HeldActionEnding = 'cancelled' | 'stopped' | 'changed' | 'restarted' | 'interrupted';

/** How a held action that did run came out, as the service reported it. */
export type HeldActionOutcome =
  'success' | 'error' | 'cancelled' | 'outcome_unknown' | 'unsupported' | 'not_sent';

/** The payloads of the two kinds, joined into `NotificationPayloads`. */
export interface ConnectorHoldPayloads {
  /** An agent's irreversible action waits out its cancel window, or ended without running. */
  'connector.destructive_pending': HeldActionSubject & {
    /** Set only on the row that says the action did not run, and why. */
    ended?: { reason: HeldActionEnding; by?: string };
  };
  /** A held action's window ended with nobody cancelling, and it ran. */
  'connector.destructive_executed': HeldActionSubject & { outcome: HeldActionOutcome };
}

/** The two kinds this module declares. */
type ConnectorHoldKind = keyof ConnectorHoldPayloads;

/** Cancel the action, or go to the chat that asked. Cancel is drawn first. */
const WAITING_ACTIONS: NotificationActionDTO[] = [
  { id: 'cancel', label: 'Cancel', style: 'danger' },
  { id: 'open', label: 'Open', style: 'primary' },
];

/** The single action a row about a finished hold offers. */
const OPEN_ACTION: NotificationActionDTO[] = [{ id: 'open', label: 'Open', style: 'primary' }];

/** The action in a sentence: `“Delete message” in Gmail`. */
function actionPhrase(p: HeldActionSubject): string {
  return `“${p.actionName}” in ${p.serviceName}`;
}

/** Why a held action did not run, as the second line of its row. */
const ENDING_BODY: Record<HeldActionEnding, (p: HeldActionSubject, by?: string) => string> = {
  cancelled: (_p, by) => `${by ?? 'Someone'} cancelled it.`,
  stopped: () => 'The chat stopped before it ran.',
  changed: () => 'It no longer qualified to run without asking you.',
  restarted: () => 'DorkOS restarted before it ran.',
  interrupted: (p) => `DorkOS restarted while it ran. Check ${p.serviceName}.`,
};

/** The title of a row about a held action that ended without a known outcome. */
function endedTitle(p: HeldActionSubject, reason: HeldActionEnding): string {
  return reason === 'interrupted'
    ? `${p.agentName} may have run ${actionPhrase(p)}`
    : `${p.agentName} didn’t run ${actionPhrase(p)}`;
}

/** The second line of a row about a held action that ran. */
function outcomeBody(p: HeldActionSubject, outcome: HeldActionOutcome): string | undefined {
  if (outcome === 'success') return undefined;
  if (outcome === 'outcome_unknown') return `DorkOS couldn’t confirm it. Check ${p.serviceName}.`;
  return 'It didn’t finish. Ask your agent what happened.';
}

/** The two connector-hold entries, spread into the registry's `ENTRIES`. */
export const CONNECTOR_HOLD_ENTRIES: { [K in ConnectorHoldKind]: NotificationRegistryEntry<K> } = {
  'connector.destructive_pending': {
    kind: 'connector.destructive_pending',
    // `notable` while it waits: nothing is blocked on a person, but everyone
    // should see it before it runs. The row saying it did not run is news only.
    // `interrupted` stays notable: the person should check the app.
    tier: (p) => (p.ended && p.ended.reason !== 'interrupted' ? 'quiet' : 'notable'),
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.holdId, agentId: p.agentId, sessionId: p.sessionId }),
    title: (p) =>
      p.ended ? endedTitle(p, p.ended.reason) : `${p.agentName} will run ${actionPhrase(p)}`,
    body: (p) =>
      p.ended
        ? ENDING_BODY[p.ended.reason](p, p.ended.by)
        : 'Runs in 60 seconds unless someone cancels.',
    actions: (p) => (p.ended ? OPEN_ACTION : WAITING_ACTIONS),
    dedupeKey: (p) => `connector-hold:${p.holdId}`,
    dedupeWindowMs: 0,
    relay: 'never',
  },

  'connector.destructive_executed': {
    kind: 'connector.destructive_executed',
    tier: 'quiet',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.holdId, agentId: p.agentId, sessionId: p.sessionId }),
    title: (p) =>
      p.outcome === 'success'
        ? `${p.agentName} ran ${actionPhrase(p)}`
        : p.outcome === 'outcome_unknown'
          ? `${p.agentName} may have run ${actionPhrase(p)}`
          : `${p.agentName} couldn’t run ${actionPhrase(p)}`,
    body: (p) => outcomeBody(p, p.outcome),
    actions: () => OPEN_ACTION,
    // Its own key: dedupe is keyed across kinds. It replaces the waiting row
    // by sharing that row's subject, the hold.
    dedupeKey: (p) => `connector-hold-ran:${p.holdId}`,
    relay: 'never',
  },
};
