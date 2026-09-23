import { test, expect, type Page } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import {
  ALPHA,
  BETA,
  ROOM,
  mockCommunities,
  releaseHeld,
  secret,
  type CommunityMock,
} from './community-mocks.js';

/**
 * Browser proof that rapid switching between Communities never paints one
 * Community's messages under another's name (DOR-2186; spec
 * `specs/community-switcher-navigation`, task 4.1). Reads and event streams are
 * held open across each hop and released in the worst order.
 */

/** One Community request as the page itself saw it, on the page's own clock. */
interface PageRequest {
  ref: string;
  path: string;
  start: number;
  response?: number;
  aborted?: number;
}

/**
 * Log every Community request from inside the page: when it started, when its
 * answer arrived and when the app cancelled it. Node-side network events are a
 * few milliseconds late and out of order with each other; this is the page's
 * own timeline, which is what "closed before" means.
 */
async function logCommunityRequests(page: Page) {
  await page.addInitScript(() => {
    const log: PageRequest[] = [];
    (window as unknown as { __communityRequests: PageRequest[] }).__communityRequests = log;
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const match = /\/api\/communities\/([^/?]+)([^?]*)/.exec(url);
      if (!match) return original(input, init);
      const record: PageRequest = {
        ref: decodeURIComponent(match[1]!),
        path: match[2] ?? '',
        start: performance.now(),
      };
      log.push(record);
      init?.signal?.addEventListener('abort', () => (record.aborted ??= performance.now()), {
        once: true,
      });
      const pending = original(input, init);
      pending.then(
        () => (record.response ??= performance.now()),
        () => undefined
      );
      return pending;
    };
  });
}

async function pageRequests(page: Page): Promise<PageRequest[]> {
  return page.evaluate(
    () => (window as unknown as { __communityRequests: PageRequest[] }).__communityRequests
  );
}

/**
 * Record, once per animation frame, which context the page says it is in and
 * which Community's messages are painted. A frame is what a person could have
 * seen, so this is the frame-by-frame evidence the spec asks for.
 */
async function recordFrames(page: Page, labels: string[]) {
  await page.evaluate((watched) => {
    const frames: { at: number; trigger: string | null; search: string; painted: string[] }[] = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    let last = '';
    const tick = () => {
      const trigger =
        document
          .querySelector('[data-testid="sidebar-header-block"]')
          ?.getAttribute('aria-label') ?? null;
      const text = document.querySelector('main')?.textContent ?? '';
      const painted = watched.filter((label) => text.includes(`${label} private note`));
      const frame = { at: performance.now(), trigger, search: location.search, painted };
      const key = JSON.stringify([trigger, location.search, painted]);
      if (key !== last) frames.push(frame);
      last = key;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, labels);
}

async function recordedFrames(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __frames: { at: number; trigger: string | null; search: string; painted: string[] }[];
        }
      ).__frames
  );
}

/** Wait until the page has made one more request for this ref's room history. */
async function nextEntriesRequest(mock: CommunityMock, ref: string, seen: number) {
  await expect
    .poll(() => mock.requests.filter((r) => r.ref === ref && r.path.endsWith('/entries')).length)
    .toBeGreaterThan(seen);
}

const entriesCount = (mock: CommunityMock, ref: string) =>
  mock.requests.filter((r) => r.ref === ref && r.path.endsWith('/entries')).length;

/** Navigate the way a link or Back does: through the router's own history. */
async function pushRoute(page: Page, href: string) {
  await page.evaluate((to) => window.history.pushState(window.history.state, '', to), href);
}

test.describe('rapid switching (task 4.1)', () => {
  test('A→B→A→this DorkOS→B with reads and streams in flight never paints A under another context', async ({
    page,
  }, testInfo) => {
    const mock = await mockCommunities(page, [ALPHA, BETA]);
    await logCommunityRequests(page);
    await page.goto(`/channels?community=alpha&id=${ROOM}`);
    await new BasePage(page).waitForAppReady();
    await expect(page.getByText(secret('Alpha'), { exact: true })).toBeVisible();
    await expect(page.getByTestId('sidebar-header-block')).toHaveAccessibleName('Alpha menu');

    // From here on every history read is held open, so each hop leaves its
    // read (and its event stream) in flight when the next hop happens.
    mock.holdEntries.add('alpha');
    mock.holdEntries.add('beta');
    await recordFrames(page, ['Alpha', 'Beta']);

    await pushRoute(page, `/channels?community=beta&id=${ROOM}`);
    await nextEntriesRequest(mock, 'beta', 0);
    // Alpha's event stream was closed before any of Beta's data arrived.
    const log = await pageRequests(page);
    const alphaStream = log.find((r) => r.ref === 'alpha' && r.path.endsWith('/events'))!;
    const betaAnswers = log.filter((r) => r.ref === 'beta' && r.response !== undefined);
    expect(alphaStream.aborted, 'Alpha stream closed').toBeDefined();
    for (const answer of betaAnswers)
      expect(alphaStream.aborted!, answer.path).toBeLessThanOrEqual(answer.response!);
    const firstBetaStart = Math.min(...log.filter((r) => r.ref === 'beta').map((r) => r.start));
    testInfo.annotations.push({
      type: 'alpha-stream-closed-vs-first-beta-request-ms',
      description: (alphaStream.aborted! - firstBetaStart).toFixed(1),
    });

    const alphaReads = entriesCount(mock, 'alpha');
    await pushRoute(page, `/channels?community=alpha&id=${ROOM}`);
    await nextEntriesRequest(mock, 'alpha', alphaReads);
    await pushRoute(page, '/tasks');
    await expect(page.getByTestId('sidebar-header-block')).not.toHaveAccessibleName(/Alpha|Beta/);
    const betaReads = entriesCount(mock, 'beta');
    await pushRoute(page, `/channels?community=beta&id=${ROOM}`);
    await nextEntriesRequest(mock, 'beta', betaReads);
    await expect(page.getByTestId('sidebar-header-block')).toHaveAccessibleName('Beta menu');

    // Let every stale answer land first (the returned A, the first B), and
    // the final B's own answer last.
    const final = mock.held.pop()!;
    expect(final.ref).toBe('beta');
    await releaseHeld(mock, 'newest-first');
    await page.waitForTimeout(300);
    await expect(page.getByText(secret('Alpha'), { exact: true })).toHaveCount(0);
    final.release();
    await expect(page.getByText(secret('Beta'), { exact: true })).toBeVisible();
    await expect(page.getByText(secret('Alpha'), { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/community=beta/);

    // Back and Forward walk the same history without reviving a stale frame.
    mock.holdEntries.clear();
    await page.goBack();
    await expect(page).toHaveURL(/\/tasks/);
    await page.goBack();
    await expect(page.getByText(secret('Alpha'), { exact: true })).toBeVisible();
    await page.goForward();
    await page.goForward();
    await expect(page.getByText(secret('Beta'), { exact: true })).toBeVisible();

    const frames = await recordedFrames(page);
    await testInfo.attach('frames.json', {
      body: Buffer.from(JSON.stringify(frames, null, 2)),
      contentType: 'application/json',
    });
    expect(frames.length).toBeGreaterThan(4);
    for (const frame of frames) {
      for (const label of frame.painted) {
        // A Community's messages are only ever painted under its own name and address.
        expect(frame.trigger, JSON.stringify(frame)).toBe(`${label} menu`);
        expect(frame.search, JSON.stringify(frame)).toContain(`community=${label.toLowerCase()}`);
      }
      expect(frame.painted.length, JSON.stringify(frame)).toBeLessThanOrEqual(1);
    }
    const shot = testInfo.outputPath('rapid-switch-final.png');
    await page.screenshot({ path: shot, animations: 'disabled' });
    await testInfo.attach('rapid-switch-final.png', { path: shot, contentType: 'image/png' });
  });

  test('hops inside one frame land on the last choice only', async ({ page }) => {
    const mock = await mockCommunities(page, [ALPHA, BETA]);
    await page.goto(`/channels?community=alpha&id=${ROOM}`);
    await new BasePage(page).waitForAppReady();
    await expect(page.getByText(secret('Alpha'), { exact: true })).toBeVisible();
    mock.holdEntries.add('alpha');
    await recordFrames(page, ['Alpha', 'Beta']);

    await page.evaluate((room) => {
      const go = (to: string) => window.history.pushState(window.history.state, '', to);
      go(`/channels?community=beta&id=${room}`);
      go(`/channels?community=alpha&id=${room}`);
      go('/tasks');
      go(`/channels?community=beta&id=${room}`);
    }, ROOM);
    await expect(page.getByText(secret('Beta'), { exact: true })).toBeVisible();
    await releaseHeld(mock);
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/community=beta/);
    await expect(page.getByTestId('sidebar-header-block')).toHaveAccessibleName('Beta menu');
    await expect(page.getByText(secret('Alpha'), { exact: true })).toHaveCount(0);
    for (const frame of await recordedFrames(page))
      for (const label of frame.painted)
        expect(frame.trigger, JSON.stringify(frame)).toBe(`${label} menu`);
  });
});
