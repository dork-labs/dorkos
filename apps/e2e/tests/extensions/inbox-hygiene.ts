import type { APIRequestContext } from '@playwright/test';
import { expect } from '../../fixtures';

/**
 * Leave the leg's inbox as a spec found it (DOR-2524): mark read every unread
 * row the spec produced, then prove none is left.
 *
 * An inbox spec that settles its decisions still leaves their history behind,
 * unread, and an unread row turns the header's bell into a number. That number
 * is wider than a bare bell, so whatever spec ran next on the same leg measured
 * a different header than the one it was written against: the responsive sweep
 * failed on Home, Tasks and Team for exactly this reason, and only when the
 * shard split happened to put it after an inbox spec. Marking only the spec's
 * own rows keeps a real unread row from another spec untouched.
 *
 * @param request - The API leg's request context.
 * @param mine - Which rows this spec produced.
 */
export async function leaveNoUnreadRows(
  request: APIRequestContext,
  mine: (row: InboxRow) => boolean
): Promise<void> {
  for (const row of (await unreadRows(request)).filter(mine)) {
    const read = await request.patch(`/api/notifications/${encodeURIComponent(row.id)}/read`);
    expect(read.ok(), `mark ${row.title} read: ${await read.text()}`).toBe(true);
  }
  expect(
    (await unreadRows(request)).filter(mine).map((row) => row.title),
    'the spec left unread inbox rows behind'
  ).toEqual([]);
}

/** The slice of a notification row these helpers read. */
export interface InboxRow {
  id: string;
  kind: string;
  title: string;
  subject: { type: string; id: string };
  readAt?: string;
}

async function unreadRows(request: APIRequestContext): Promise<InboxRow[]> {
  const response = await request.get('/api/notifications?unread=true&limit=100');
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { notifications: InboxRow[] }).notifications.filter(
    (row) => !row.readAt
  );
}

/**
 * Prove an extension has no decision still waiting on a person.
 *
 * @param request - The API leg's request context.
 * @param extensionId - The extension.
 */
export async function expectNoOpenDecisions(
  request: APIRequestContext,
  extensionId: string
): Promise<void> {
  const response = await request.get(`/api/extensions/${extensionId}/decisions`);
  expect(response.ok(), await response.text()).toBe(true);
  const { decisions } = (await response.json()) as { decisions: Array<{ title: string }> };
  expect(
    decisions.map((d) => d.title),
    `${extensionId} left decisions open`
  ).toEqual([]);
}
