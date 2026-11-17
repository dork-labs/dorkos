/**
 * What DorkOS tells a person about the monthly spend limit on paid app
 * actions (DOR-4204 PR 2, spec 1.0 §5 and §7.9), beside its emitter,
 * `spending-notices.ts`.
 *
 * Each is deduped per month and limit, so raising the limit is a new decision
 * and arms both again. Only reaching the limit goes to the person's chat app:
 * agents stopped, and a person away from the desk should know (Q3). No row
 * names an app, an action or its arguments.
 *
 * @module services/connectors/spending/spending-notifications
 */
import type { NotificationActionDTO } from '@dorkos/shared/notification-schemas';
import { limitMoney, money, resetDay } from './spend-copy.js';
import type { NotificationRegistryEntry } from '../../notifications/notification-registry.js';

/** What every spending row reads; amounts are micro-unit strings. */
export interface SpendingNoticePayload {
  /** The UTC month, `YYYY-MM`. */
  month: string;
  limitMicro: string;
  leftMicro: string;
  /** When the month resets, ISO. */
  resetsAt: string;
}

/** The payloads of the spending kinds, joined into `NotificationPayloads`. */
export interface SpendingPayloads {
  /** Agents used 80% of this month's limit. */
  'spending.near-limit': SpendingNoticePayload;
  /** Agents reached this month's limit; paid actions stop. */
  'spending.limit-reached': SpendingNoticePayload;
  /** The meter could not be read; every paid action asks until it reads again. */
  'spending.meter-reset': { month: string };
}

/** The spending kinds. */
export const SPENDING_NOTIFICATION_KINDS = [
  'spending.near-limit',
  'spending.limit-reached',
  'spending.meter-reset',
] as const;

type SpendingKind = keyof SpendingPayloads;

/** Longer than a month, so a month's notice is never told twice. */
const MONTH_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;

const OPEN: NotificationActionDTO = { id: 'open', label: 'Open', style: 'primary' };
const RAISE: NotificationActionDTO = { id: 'raise-limit', label: 'Raise limit', style: 'primary' };

/** The reset day, like `Dec 1`. */
const until = (p: SpendingNoticePayload) => resetDay(new Date(p.resetsAt));

/** The spending entries, spread into the registry's `ENTRIES`. */
export const SPENDING_ENTRIES: { [K in SpendingKind]: NotificationRegistryEntry<K> } = {
  'spending.near-limit': {
    kind: 'spending.near-limit',
    tier: 'notable',
    storage: 'event',
    subjectType: 'system',
    locate: () => ({ subjectId: 'spending' }),
    title: () => "Agents have used 80% of this month's spending",
    body: (p) => `${money(Number(p.leftMicro))} left until ${until(p)}.`,
    actions: () => [OPEN],
    dedupeKey: (p) => `spending-near:${p.month}:${p.limitMicro}`,
    dedupeWindowMs: MONTH_WINDOW_MS,
    relay: 'never',
  },
  'spending.limit-reached': {
    kind: 'spending.limit-reached',
    tier: 'notable',
    storage: 'event',
    subjectType: 'system',
    locate: () => ({ subjectId: 'spending' }),
    title: (p) => `Agents reached your ${limitMoney(Number(p.limitMicro))} monthly limit`,
    body: (p) => `Paid actions stop until ${until(p)}, or a higher limit.`,
    actions: () => [RAISE, { ...OPEN, style: 'neutral' }],
    dedupeKey: (p) => `spending-reached:${p.month}:${p.limitMicro}`,
    dedupeWindowMs: MONTH_WINDOW_MS,
    relay: 'always',
  },
  'spending.meter-reset': {
    kind: 'spending.meter-reset',
    tier: 'notable',
    storage: 'event',
    subjectType: 'system',
    locate: () => ({ subjectId: 'spending' }),
    title: () => "Couldn't read this month's spending",
    body: () => 'Paid actions ask every time until it reads again.',
    actions: () => [OPEN],
    dedupeKey: (p) => `spending-meter:${p.month}`,
    dedupeWindowMs: MONTH_WINDOW_MS,
    relay: 'never',
  },
};
