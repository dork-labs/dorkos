/**
 * A person's route controls in the canvas header, against the real server
 * (spec `doc-channel` task 5.2).
 *
 * A credential-free test-mode turn opens a document; the test-only declaration
 * route then declares two routes on it exactly as an agent's
 * `configure_doc_channel` would, which grants nothing. Everything after that is
 * the person's own path: the routes show Off, a review shows the server's exact
 * details, Allow grants exactly what was shown, Turn off stops it, and a route
 * whose agent is unavailable says so instead of allowing anything.
 *
 * Runs in `chromium-browser-driving`: it needs the test-mode server for the
 * scenario and the declaration route, and it drives a turn.
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { ChatPage } from '../../pages/ChatPage';
import { RightPanelPage } from '../../pages/RightPanelPage';
import { CanvasDocRoutesSchema } from '@dorkos/shared/canvas-doc-routes';

const SHOTS = '/tmp/dor2665-route-controls-shots';
const DECLARATION = {
  routes: [
    { id: 'notes', on: 'checklist.*', to: 'log', turn: { mode: 'none' } },
    {
      id: 'owner',
      on: 'checklist.done',
      to: 'agent:owner',
      turn: { mode: 'immediate', maxBatch: 10 },
    },
  ],
};

async function openChecklist(page: Page, request: APIRequestContext) {
  const draftId = randomUUID();
  const seeded = await request.post('/api/test/seed-agent', { data: { instance: randomUUID() } });
  expect(seeded.ok()).toBe(true);
  const { agentDir } = (await seeded.json()) as { agentDir: string };
  const selected = await request.post('/api/test/scenario', {
    data: { name: 'doc-routes-checklist', sessionId: draftId },
  });
  expect(selected.ok(), 'Run only in the test-mode chromium-browser-driving project.').toBe(true);
  const chat = new ChatPage(page);
  await chat.goto(draftId, { dir: agentDir, runtime: 'test-mode', draft: true });
  await chat.sendAndLand('Open the launch checklist');
  const sessionId = new URL(page.url()).searchParams.get('session');
  if (!sessionId) throw new Error('The real session was not retained in the address.');
  const listing = await request.get(`/api/sessions/${encodeURIComponent(sessionId)}/canvas`);
  expect(listing.ok()).toBe(true);
  const { documents } = (await listing.json()) as { documents: { id: string; title: string }[] };
  const document = documents.find((row) => row.title === 'Launch checklist');
  if (!document) throw new Error('The checklist document is absent.');
  const declared = await request.post('/api/test/doc-routes/configure', {
    data: { documentId: document.id, declaration: DECLARATION },
  });
  expect(declared.ok(), await declared.text()).toBe(true);
  // The header reads routes when the document becomes active; a reload reads the declaration.
  await page.reload();
  const panel = new RightPanelPage(page);
  await panel.ensureTabStripOpen();
  await panel.selectView('Canvas');
  await page.getByRole('tab', { name: 'Launch checklist', exact: true }).click();
  return { sessionId, documentId: document.id };
}

async function shot(page: Page, name: string) {
  await fs.mkdir(SHOTS, { recursive: true });
  // Finished transitions only: a theme switch fades colours, and a mid-fade frame
  // shows neither theme.
  await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' });
}

test.afterEach(async ({ page, request }) => {
  const sessionId = new URL(page.url()).searchParams.get('session');
  await page.goto('about:blank');
  if (sessionId)
    await request.post('/api/test/scenario', { data: { name: 'simple-text', sessionId } });
});

test('a person reviews, allows and turns off a document route from the canvas header', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const { documentId } = await openChecklist(page, request);
  const routes = async () =>
    CanvasDocRoutesSchema.parse(
      await (await request.get(`/api/canvas/docs/${encodeURIComponent(documentId)}/routes`)).json()
    ).routes;

  // No route from silence: declared, both off, before anyone says anything.
  const trigger = page.getByTestId('doc-routes-trigger');
  await expect(trigger).toHaveAccessibleName('Event routes: Off');
  await trigger.click();
  const panel = page.getByTestId('doc-routes-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('doc-route-notes')).toHaveAttribute('data-state', 'no_grant');
  await expect(panel.getByTestId('doc-route-owner')).toContainText('To the agent that opened this');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await shot(page, `1280-${scheme}-off`);
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // Review shows the server's exact details before anything is allowed.
  await panel.getByTestId('doc-route-review-button-notes').click();
  const review = panel.getByTestId('doc-route-review-notes');
  await expect(review).toContainText('Kept on this document');
  await expect(review).toContainText('checklist.*');
  await expect(review).toContainText('10 turns an hour · 60 events a minute');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await shot(page, `1280-${scheme}-review`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await review.getByRole('radio', { name: '1 hour' }).click();
  await expect(review).toContainText('checklist.*');
  const approved = page.waitForResponse((r) => r.url().endsWith('/routes/notes/approve'));
  await panel.getByTestId('doc-route-allow-notes').click();
  expect((await approved).ok()).toBe(true);
  await expect(panel.getByTestId('doc-route-state-notes')).toHaveText('On');
  await expect(panel.getByRole('status')).toHaveText('notes is on.');
  // The modal panel hides the page behind it from assistive tech, so read the label itself.
  await expect(trigger).toHaveAttribute('aria-label', 'Event routes: 1 on');
  const granted = (await routes()).find((route) => route.id === 'notes')!;
  expect(granted).toMatchObject({ state: 'granted', grant: { approvedBy: 'person' } });
  const hours = (Date.parse(granted.grant!.expiresAt!) - Date.now()) / 3_600_000;
  expect(hours).toBeGreaterThan(0.9);
  expect(hours).toBeLessThan(1.1);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await shot(page, `1280-${scheme}-granted`);
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // A route whose agent is not there refuses with a reason and allows nothing.
  await panel.getByTestId('doc-route-review-button-owner').click();
  await expect(panel.getByTestId('doc-route-review-owner').getByRole('alert')).toHaveText(
    'The agent that opened this isn’t available.'
  );
  await expect(panel.getByTestId('doc-route-allow-owner')).toBeDisabled();
  await panel.getByTestId('doc-route-review-owner').getByRole('button', { name: 'Cancel' }).click();

  // Turning it off stops it, and the server agrees.
  await panel.getByTestId('doc-route-turn-off-notes').click();
  await expect(panel.getByTestId('doc-route-state-notes')).toHaveText('Turned off');
  await expect(panel.getByRole('status')).toHaveText('notes is off.');
  expect((await routes()).find((route) => route.id === 'notes')?.state).toBe('revoked');

  // Keyboard: the panel closes on Escape and focus returns to the trigger.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('the route controls fit a phone, in both themes', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await openChecklist(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByTestId('doc-routes-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  const panel = page.getByTestId('doc-routes-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('doc-route-review-button-notes').click();
  await expect(panel.getByTestId('doc-route-review-notes')).toContainText('checklist.*');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await shot(page, `390-${scheme}-review`);
  }
});
