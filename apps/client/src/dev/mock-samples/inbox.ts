/**
 * Inbox row fixtures for the playground: one row of each tier, read and unread,
 * and the clock every Inbox showcase dates its rows against.
 *
 * @module dev/mock-samples/inbox
 */
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';

/**
 * Frozen at module load, not read per render: `Date.now()` during render is
 * impure (`react-hooks/purity`), and times that shift on every re-render are
 * harder to read anyway.
 */
const LOADED_AT = Date.now();

/** An ISO timestamp `minutes` before page load. */
export function minutesAgo(minutes: number): string {
  return new Date(LOADED_AT - minutes * 60_000).toISOString();
}

/** One row of each tier, read and unread, across the kinds that ship wired. */
export const SAMPLE_INBOX_ROWS: NotificationDTO[] = [
  {
    id: '01JZB0000000000000000001',
    kind: 'turn.completed',
    tier: 'notable',
    subject: { type: 'session', id: 'ses-9' },
    sessionId: 'ses-9',
    agentId: 'tangerines',
    title: 'meeting-notes finished',
    createdAt: minutesAgo(2),
  },
  {
    id: '01JZB0000000000000000002',
    kind: 'run.completed',
    tier: 'notable',
    subject: { type: 'run', id: 'run-4412' },
    agentId: 'dorkbot',
    title: 'Nightly sweep failed',
    body: 'Failed after 2m 14s. Exit code 1.',
    createdAt: minutesAgo(46),
  },
  {
    id: '01JZB0000000000000000003',
    kind: 'agent.note',
    tier: 'notable',
    subject: { type: 'agent', id: 'dorkbot' },
    agentId: 'dorkbot',
    sessionId: 'ses-3',
    title: 'DorkBot has a note for you',
    body: 'The migration is staged and waiting for your review.',
    createdAt: minutesAgo(95),
    readAt: minutesAgo(90),
  },
  {
    id: '01JZB0000000000000000004',
    kind: 'agent.unreachable',
    tier: 'quiet',
    subject: { type: 'agent', id: 'tangerines' },
    agentId: 'tangerines',
    title: 'tangerines stopped answering',
    createdAt: minutesAgo(180),
    readAt: minutesAgo(170),
  },
  {
    id: '01JZB0000000000000000005',
    kind: 'update.installed',
    tier: 'quiet',
    subject: { type: 'system', id: '0.61.0' },
    title: 'DorkOS updated to 0.61.0',
    body: 'You were on 0.60.2.',
    createdAt: minutesAgo(1_400),
    readAt: minutesAgo(1_390),
  },
  {
    id: '01JZB0000000000000000006',
    kind: 'dm.received',
    tier: 'notable',
    subject: { type: 'room', id: 'room-1' },
    agentId: 'shadow-fox',
    title: 'shadow-fox messaged you',
    body: 'Can you take a look at the deploy?',
    createdAt: minutesAgo(6),
  },
  {
    id: '01JZB0000000000000000007',
    kind: 'report.undelivered',
    tier: 'notable',
    subject: { type: 'session', id: 'demo-spin-off' },
    sessionId: 'demo-spin-off',
    title: "A report from Weekly invoice cleanup for the north region didn't arrive",
    body: 'It never reached the chat that started it. Open the chat to read it.',
    actions: [{ id: 'open-chat', label: 'Open chat', style: 'primary' }],
    createdAt: minutesAgo(11),
  },
];
