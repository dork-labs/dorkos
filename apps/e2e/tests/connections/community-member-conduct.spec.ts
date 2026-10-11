import { test, expect, type Page, type Route } from '@playwright/test';
import { BETA, ROOM, mockCommunities } from './community-mocks.js';
import { controllableStream } from './community-stream.js';

/**
 * A member's own side of a space's moderation, end to end in the app (DOR-2770): accepting the
 * rules before a first post, a post held by slow mode coming back to the box with its seconds
 * left, reporting someone else's message, and picking a name for the space. Then the same states
 * at phone width, where the dialogs are drawers.
 *
 * The Community is mocked at the local server's API, as `community-mocks.ts` does it; this file
 * answers the person's standing, the rules, the reports and the name routes, and keeps the
 * channel's stream live so the composer can send.
 */

const REF = BETA.ref;
const SELF = `person-${REF}`;
const AT = Date.parse('2026-10-01T12:00:00.000Z');

function entry(seq: number, text: string, author: { id: string; name: string }) {
  return {
    community: REF,
    roomId: ROOM,
    id: `entry-${seq}`,
    authorId: author.id,
    authorDisplayName: author.name,
    authorKind: 'human',
    text,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: `cursor-${REF}-${seq}`,
    createdAt: new Date(AT + seq * 60_000).toISOString(),
    remoteSeq: seq,
    attachments: [],
  };
}

const SAM = { id: 'sam', name: 'Sam' };
const HISTORY = [entry(1, 'Cheap watches, click here', SAM)];

/** What the test arranged, and what the app asked the space to do. */
interface Space {
  rules: { text: string | null; version: number; acceptedVersion: number };
  mutedUntil: string | null;
  /** Posts to refuse with slow mode before one is accepted. */
  slowRefusals: number;
  accepted: number[];
  reports: unknown[];
  names: string[];
  posts: string[];
}

async function mockSpace(page: Page, arranged: Partial<Space> = {}) {
  const space: Space = {
    rules: { text: 'Be kind.\nNo ads.', version: 1, acceptedVersion: 0 },
    mutedUntil: null,
    slowRefusals: 0,
    accepted: [],
    reports: [],
    names: [],
    posts: [],
    ...arranged,
  };
  await mockCommunities(page, [BETA]);
  const stream = await controllableStream(page, BETA);
  let nextSeq = 100;
  // Registered after `mockCommunities`, so these answer first; the rest falls through.
  await page.route('**/api/communities/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(`/api/communities/${REF}`.length);
    const method = request.method();
    if (path === `/rooms/${ROOM}/standing`)
      return route.fulfill({
        json: {
          community: REF,
          roomId: ROOM,
          mutedUntil: space.mutedUntil,
          slowModeSeconds: 30,
          rules: space.rules,
        },
      });
    if (path === '/rules/accept' && method === 'POST') {
      const { version } = request.postDataJSON() as { version: number };
      space.accepted.push(version);
      space.rules = { ...space.rules, acceptedVersion: version };
      return route.fulfill({ json: { community: REF, rules: space.rules } });
    }
    if (path === '/me/display-name' && method === 'PUT') {
      const { displayName } = request.postDataJSON() as { displayName: string };
      space.names.push(displayName);
      return route.fulfill({ json: { community: REF, displayName } });
    }
    if (/^\/rooms\/[^/]+\/entries\/[^/]+\/reports$/.test(path) && method === 'POST') {
      space.reports.push({ path, body: request.postDataJSON() });
      return route.fulfill({ status: 204, body: '' });
    }
    if (path === `/rooms/${ROOM}/members`)
      return route.fulfill({
        json: {
          community: REF,
          roomId: ROOM,
          members: [
            {
              community: REF,
              memberId: SELF,
              kind: 'human',
              displayName: 'Alex',
              handle: 'alex',
              role: 'member',
              ownerMemberId: null,
              joinedAt: '2026-10-01T12:00:00.000Z',
            },
          ],
          stale: false,
        },
      });
    if (path === `/rooms/${ROOM}/entries` && method === 'POST') {
      const { text } = request.postDataJSON() as { text: string };
      space.posts.push(text);
      if (space.slowRefusals > 0) {
        space.slowRefusals -= 1;
        return route.fulfill({
          status: 429,
          headers: { 'Retry-After': '2' },
          json: {
            code: 'COMMUNITY_SLOW_MODE',
            error: 'This channel is in slow mode. Wait a moment, then post again.',
          },
        });
      }
      return route.fulfill({
        status: 201,
        json: { entry: entry(nextSeq++, text, { id: SELF, name: 'Alex' }) },
      });
    }
    if (path === `/rooms/${ROOM}/entries`)
      return route.fulfill({
        json: {
          community: REF,
          roomId: ROOM,
          entries: HISTORY,
          nextCursor: null,
          lastRemoteSeq: 1,
          stale: false,
        },
      });
    return route.fallback();
  });
  return { space, stream };
}

async function openChannel(page: Page, arranged: Partial<Space> = {}) {
  const mocked = await mockSpace(page, arranged);
  await page.goto(`/channels?community=${REF}&id=${ROOM}`);
  await mocked.stream.snapshot(HISTORY);
  await expect(page.getByText('Cheap watches, click here')).toBeVisible();
  return mocked.space;
}

test.describe('A member’s own side of a space’s moderation', () => {
  test('accept the rules, wait out slow mode, report a message and pick a name', async ({
    page,
  }) => {
    const space = await openChannel(page, { slowRefusals: 1 });
    const composer = page.getByRole('combobox');

    // The rules hold the first post until they are read and accepted.
    await expect(page.getByText('Accept this space’s rules to post.')).toBeVisible();
    await page.getByRole('button', { name: 'Read the rules' }).click();
    const rules = page.getByRole('dialog');
    await expect(rules.getByText('No ads.', { exact: false })).toBeVisible();
    await rules.getByRole('button', { name: 'Accept rules' }).click();
    await expect(rules).toBeHidden();
    expect(space.accepted).toEqual([1]);
    await expect(page.getByText('Accept this space’s rules to post.')).toBeHidden();

    // Slow mode holds a post: it is back in the box, with the seconds left.
    await composer.fill('First hello');
    await composer.press('Enter');
    await expect(page.getByText(/Slow mode\. Post again in [12]s\./)).toBeVisible();
    await expect(composer).toHaveValue('First hello');
    await expect(page.getByText('Delivery not confirmed.')).toHaveCount(0);
    // Once the wait is over, the same words go out.
    await expect(page.getByText(/Slow mode\. Post again in/)).toBeHidden({ timeout: 5_000 });
    await composer.press('Enter');
    await expect(page.getByText('First hello', { exact: true })).toBeVisible();
    expect(space.posts).toEqual(['First hello', 'First hello']);

    // Someone else's message can be reported; your own cannot.
    await expect(page.getByRole('button', { name: 'Report' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Report' }).click();
    const report = page.getByRole('dialog');
    await report.getByLabel('Spam').click();
    await report.getByLabel('Note (optional)').fill('Third ad today');
    await report.getByRole('button', { name: 'Send report' }).click();
    await expect(report).toBeHidden();
    expect(space.reports).toEqual([
      {
        path: `/rooms/${ROOM}/entries/entry-1/reports`,
        body: { reason: 'spam', note: 'Third ad today' },
      },
    ]);

    // A name for this space only, starting from the one it shows now.
    await page.getByRole('button', { name: 'Your name' }).click();
    const name = page.getByRole('dialog');
    await expect(name.getByLabel('Name')).toHaveValue('Alex');
    await name.getByLabel('Name').fill('Alex R');
    await name.getByRole('button', { name: 'Save name' }).click();
    await expect(name).toBeHidden();
    expect(space.names).toEqual(['Alex R']);
  });

  test('at phone width, a mute says when it ends and a report opens as a drawer', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const until = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const space = await openChannel(page, {
      mutedUntil: until,
      rules: { text: null, version: 0, acceptedVersion: 0 },
    });
    const muted = page.getByText(/You’re muted here until/);
    await expect(muted).toBeVisible();
    await expect(muted).toBeInViewport();
    const composer = page.getByRole('combobox');
    await composer.fill('Can anyone hear me?');
    await composer.press('Enter');
    await expect(composer).toHaveValue('Can anyone hear me?');
    expect(space.posts).toEqual([]);

    await page.getByRole('button', { name: 'Report' }).click();
    const report = page.getByRole('dialog');
    const send = report.getByRole('button', { name: 'Send report' });
    await expect(send).toBeInViewport();
    await report.getByLabel('Harassment').click();
    await send.click();
    await expect(report).toBeHidden();
    expect(space.reports).toHaveLength(1);
  });
});
