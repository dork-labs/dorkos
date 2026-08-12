/**
 * The playground's session fixtures, shared by every roster showcase.
 *
 * A module of their own for the same reason `agent-sidebar-fixtures.ts` is one:
 * two showcase files now draw the same list — `SidebarShowcases` for the Agent
 * Hub's `SessionsView` and `EmbedSessionListShowcase` for the Obsidian embed's
 * roster — and a second copy of the data is a second answer to "what does a
 * busy week look like".
 *
 * @module dev/showcases/session-list-fixtures
 */
import type { Session } from '@dorkos/shared/types';

const now = new Date();

/** An ISO timestamp `hours` hours before this module loaded. */
function hoursAgo(hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

/** An ISO timestamp `days` days before this module loaded. */
function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Six sessions across a week, in the permission modes a real week has. */
export const MOCK_SESSIONS: Session[] = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    title: 'Refactor auth middleware to use JWT validation',
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
    permissionMode: 'default',
    runtime: 'claude-code',
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    title: 'Debug failing E2E tests in CI pipeline',
    createdAt: hoursAgo(3),
    updatedAt: hoursAgo(2),
    permissionMode: 'default',
    runtime: 'claude-code',
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    title: 'Add dark mode support to settings panel',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    permissionMode: 'acceptEdits',
    runtime: 'claude-code',
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    title: 'Migrate database schema to Drizzle ORM',
    createdAt: daysAgo(2),
    updatedAt: daysAgo(1),
    permissionMode: 'bypassPermissions',
    runtime: 'claude-code',
  },
  {
    id: '00000000-0000-0000-0000-000000000005',
    title: 'Implement WebSocket relay for agent messaging',
    createdAt: daysAgo(5),
    updatedAt: daysAgo(4),
    permissionMode: 'default',
    runtime: 'claude-code',
  },
  {
    id: '00000000-0000-0000-0000-000000000006',
    title: 'Optimize bundle size with tree-shaking analysis',
    createdAt: daysAgo(8),
    updatedAt: daysAgo(7),
    permissionMode: 'plan',
    runtime: 'claude-code',
  },
];

// Origin-varied sessions (session-origin-legibility) — makes SessionOriginMark
// visually discoverable in the playground alongside the plain-user rows above.
/** A session a channel message started. */
export const CHANNEL_ORIGIN_SESSION: Session = {
  ...MOCK_SESSIONS[0],
  id: '00000000-0000-0000-0000-000000000007',
  origin: 'channel',
  originLabel: 'Telegram',
};

/** A session a scheduled task started. */
export const TASK_ORIGIN_SESSION: Session = {
  ...MOCK_SESSIONS[1],
  id: '00000000-0000-0000-0000-000000000008',
  origin: 'task',
  originLabel: 'Scheduled task · daily-digest',
};

/** {@link MOCK_SESSIONS}, bucketed the way `groupSessionsByTime` buckets them. */
export const GROUPED_SESSIONS = [
  { label: 'Today', sessions: MOCK_SESSIONS.slice(0, 2) },
  { label: 'Yesterday', sessions: MOCK_SESSIONS.slice(2, 4) },
  { label: 'Previous 7 Days', sessions: MOCK_SESSIONS.slice(4) },
];
