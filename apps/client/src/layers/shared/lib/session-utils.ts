import type { Session } from '@dorkos/shared/types';

export type TimeGroup = 'Today' | 'Yesterday' | 'Previous 7 Days' | 'Previous 30 Days' | 'Older';

export interface GroupedSessions {
  label: TimeGroup;
  sessions: Session[];
}

const GROUP_ORDER: TimeGroup[] = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];

/**
 * Group sessions into temporal buckets based on updatedAt.
 * Sessions are already sorted newest-first from the API.
 * Returns only non-empty groups.
 */
export function groupSessionsByTime(sessions: Session[]): GroupedSessions[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const sevenDaysAgo = new Date(todayStart);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const thirtyDaysAgo = new Date(todayStart);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const groups: Record<TimeGroup, Session[]> = {
    'Today': [],
    'Yesterday': [],
    'Previous 7 Days': [],
    'Previous 30 Days': [],
    'Older': [],
  };

  for (const session of sessions) {
    const date = new Date(session.updatedAt);
    if (date >= todayStart) groups['Today'].push(session);
    else if (date >= yesterdayStart) groups['Yesterday'].push(session);
    else if (date >= sevenDaysAgo) groups['Previous 7 Days'].push(session);
    else if (date >= thirtyDaysAgo) groups['Previous 30 Days'].push(session);
    else groups['Older'].push(session);
  }

  return GROUP_ORDER
    .map(label => ({ label, sessions: groups[label] }))
    .filter(group => group.sessions.length > 0);
}

/**
 * Shorten an absolute path by replacing the home directory prefix with ~.
 * Handles macOS (/Users/) and Linux (/home/).
 */
export function shortenHomePath(absolutePath: string): string {
  return absolutePath.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}

/**
 * Format ISO timestamp as concise relative time.
 * Today: "Just now", "5m ago", "3h ago"
 * Yesterday: "Yesterday"
 * This week: "Mon", "Tue"
 * Older: "Jan 5", "Dec 31"
 */
export function formatRelativeTime(isoString: string): string {
  const now = new Date();
  const date = new Date(isoString);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const sevenDaysAgo = new Date(todayStart);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  if (date >= todayStart) {
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    return `${diffHours}h ago`;
  }

  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).toLowerCase();

  if (date >= yesterdayStart) return `Yesterday, ${timeStr}`;

  if (date >= sevenDaysAgo) {
    const day = date.toLocaleDateString('en-US', { weekday: 'short' });
    return `${day}, ${timeStr}`;
  }

  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${dateStr}, ${timeStr}`;
}
