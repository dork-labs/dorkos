// Scratch: DOR-3583 shots (a plugin's extensions as one row, Allow all), on made-up names. Not committed.
import type { Page, Route } from '@playwright/test';
import { test } from '../fixtures';

const OUT = '/Volumes/ext-ssd-1/dork-os/artifacts/2026-11-08-extension-groups';

function ext(id: string, name: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    manifest: { id, name, version: '1.0.0', author: 'Northwind Labs', summary },
    status: 'active',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: true,
    shadowedBy: null,
    isolation: null,
    ...extra,
  };
}

const PLUGIN = 'northwind-studio';
const waiting = { approvedToRun: false, status: 'compiled', sourcePlugin: PLUGIN };

const LIST = [
  ext('field-notes', 'Field Notes', 'Capture notes from any chat into a daily page.'),
  ext('quiet-hours', 'Quiet Hours', 'Holds notifications overnight.'),
  ext('brief-desk', 'Brief Desk', 'Turns a call into a one-page brief.', { sourcePlugin: PLUGIN }),
  ext('post-planner', 'Post Planner', 'Plans a week of posts from one idea.', waiting),
  ext('story-board', 'Story Board', 'Lays out a short video, shot by shot.', waiting),
  ext('clip-cutter', 'Clip Cutter', 'Cuts long recordings into short clips.', waiting),
  // Allowed before; its files changed, so it asks on its own card.
  ext('reply-radar', 'Reply Radar', 'Finds replies worth answering.', {
    sourcePlugin: PLUGIN,
    screensPaused: true,
  }),
];

const PROGRAMS = ['exiftool', 'ffmpeg', 'git', 'imagemagick', 'pandoc', 'whisper-cli', 'yt-dlp'];

function member(
  id: string,
  name: string,
  purpose: string,
  state: 'waiting' | 'allowed',
  options: { net?: string[]; run?: string[]; inProcess?: boolean } = {}
) {
  const net = options.net ?? [];
  const run = options.run ?? [];
  const permissions = options.inProcess
    ? { runtime: 'in-process', net: [], run: [], agents: false }
    : { runtime: 'subprocess', net, run, agents: false };
  return {
    id,
    name,
    purpose,
    version: '1.0.0',
    state,
    runsInServer: true,
    reachesInternet: Boolean(options.inProcess) || net.length > 0,
    permissions: {
      ...permissions,
      run: permissions.run.map((program) => ({ name: program, found: true })),
      hasPage: true,
    },
    ...(state === 'waiting'
      ? { echo: { id, version: '1.0.0', expectedDigest: `sha-${id}`, permissions } }
      : {}),
  };
}

const SET = {
  plugin: PLUGIN,
  setHash: 'made-up-hash',
  tooMany: false,
  members: [
    member('brief-desk', 'Brief Desk', 'Turns a call into a one-page brief.', 'allowed'),
    member('clip-cutter', 'Clip Cutter', 'Cuts long recordings into short clips.', 'waiting', {
      inProcess: true,
    }),
    member('post-planner', 'Post Planner', 'Plans a week of posts from one idea.', 'waiting', {
      net: ['api.socialhub.example'],
      run: ['git', 'pandoc'],
    }),
    member('story-board', 'Story Board', 'Lays out a short video, shot by shot.', 'waiting', {
      run: ['exiftool', 'ffmpeg', 'imagemagick', 'whisper-cli', 'yt-dlp'],
    }),
  ],
  grant: {
    fullAccess: ['Clip Cutter'],
    programs: PROGRAMS,
    agentTools: ['Draft a post', 'Schedule a post', 'Cut a clip'],
    agents: [],
    network: { anything: true, hosts: ['api.socialhub.example'] },
  },
};

async function serve(page: Page) {
  // After Allow all, the list reads back the members the server allowed.
  const allowed = new Set<string>();
  const list = () =>
    LIST.map((e) => (allowed.has(e.id) ? { ...e, approvedToRun: true, status: 'active' } : e));
  await page.route(
    (url) => url.pathname === '/api/extensions',
    (route: Route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: list() }) : route.continue()
  );
  await page.route(
    (url) => url.pathname === '/api/extensions/pending-approvals',
    (route: Route) => route.fulfill({ json: { approvals: [] } })
  );
  await page.route(
    (url) => url.pathname === '/api/extensions/stale-approvals',
    (route: Route) => route.fulfill({ json: { approvals: [] } })
  );
  await page.route(
    (url) => url.pathname === '/api/extensions/approval-sets',
    (route: Route) => route.fulfill({ json: { sets: allowed.size > 0 ? [] : [SET] } })
  );
  await page.route(
    (url) => url.pathname === '/api/extensions/approve-set',
    (route: Route) => {
      allowed.add('clip-cutter');
      allowed.add('post-planner');
      return route.fulfill({
        json: {
          allAllowed: false,
          results: [
            { id: 'clip-cutter', name: 'Clip Cutter', ok: true },
            { id: 'post-planner', name: 'Post Planner', ok: true },
            {
              id: 'story-board',
              name: 'Story Board',
              ok: false,
              reason: 'Its files changed since you saw it.',
            },
          ],
        },
      });
    }
  );
}

for (const theme of ['light', 'dark'] as const) {
  test(`desktop ${theme}`, async ({ page, settingsPage }) => {
    await page.setViewportSize({ width: 1280, height: 1200 });
    await page.addInitScript((value) => localStorage.setItem('dorkos-theme', value), theme);
    await serve(page);
    await page.goto('/');
    await settingsPage.open();
    await settingsPage.switchTab('Extensions');
    const dialog = settingsPage.dialog;
    await dialog.getByTestId(`extension-group-${PLUGIN}`).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/desk-closed-${theme}.png` });
    await dialog.getByRole('button', { name: 'Review Northwind studio' }).click();
    const card = dialog.getByTestId(`approval-set-${PLUGIN}`);
    await card.getByTestId('approval-set-member-post-planner').getByRole('button').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/desk-card-${theme}.png` });
    await card.getByRole('button', { name: 'Allow all 3' }).click();
    await card.getByText('Not allowed: its files changed since you saw it.').waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/desk-partial-${theme}.png` });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`phone ${theme}`, async ({ page, settingsPage }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((value) => localStorage.setItem('dorkos-theme', value), theme);
    await serve(page);
    await page.goto('/');
    await settingsPage.open();
    await settingsPage.dialog.getByRole('button', { name: 'Extensions' }).click();
    await page.getByTestId(`extension-group-${PLUGIN}`).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/phone-closed-${theme}.png` });
    await page.getByRole('button', { name: 'Review Northwind studio' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/phone-card-${theme}.png` });
    await page
      .getByTestId(`approval-set-${PLUGIN}`)
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/phone-card-top-${theme}.png` });
  });
}
