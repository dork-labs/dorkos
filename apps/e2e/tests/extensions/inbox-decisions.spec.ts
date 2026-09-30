import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../fixtures';
import { expectNoOpenDecisions, leaveNoUnreadRows } from './inbox-hygiene';

/**
 * An extension asks a person something in the Activity inbox, and answering
 * there works (DOR-2523, spec `flow-multiproject` §12 "Browser", inbox half).
 *
 * The fixture is a global extension, `inbox-fixture`, whose server half has
 * one person-only route that raises a yes-or-no decision in a project the
 * test names. It is copied into the leg's own throwaway data directory,
 * turned on and allowed to run through the same routes a person uses, and
 * removed again afterwards.
 *
 * Two projects are two fresh git repositories under the checkout's gitignored
 * `.temp`, inside the leg's directory boundary (`DORKOS_BOUNDARY` is the repo
 * root on this leg). With a decision waiting in each, "Needs You" draws a
 * heading per project; 👍 answers one, and it leaves.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../fixtures/extensions/inbox-fixture');
const EXT_ID = 'inbox-fixture';
const RUN = `${process.pid}-${Date.now()}`;
const PROJECTS_ROOT = path.resolve(HERE, '../../.temp', `inbox-projects-${RUN}`);
const ALPHA = path.join(PROJECTS_ROOT, `alpha-${RUN}`);
const BETA = path.join(PROJECTS_ROOT, `beta-${RUN}`);

let extensionDir: string | undefined;

/** The ids of the decisions this run raised: its history rows carry them. */
const raisedIds: string[] = [];

test.describe('An extension asks in the inbox', () => {
  test.beforeAll(async ({ request }) => {
    for (const repo of [ALPHA, BETA]) {
      mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: repo });
    }

    const config = (await (await request.get('/api/config')).json()) as { dorkHome?: string };
    expect(config.dorkHome, 'the API leg reports its data directory').toBeTruthy();
    extensionDir = path.join(config.dorkHome as string, 'extensions', EXT_ID);
    cpSync(FIXTURE, extensionDir, { recursive: true });
    await request.post('/api/extensions/reload', { data: {} });

    const enabled = await request.post(`/api/extensions/${EXT_ID}/enable`, { data: {} });
    expect(enabled.ok(), await enabled.text()).toBe(true);
    const approved = await request.post(`/api/extensions/${EXT_ID}/approve`, { data: {} });
    expect(approved.ok(), await approved.text()).toBe(true);
    const started = await request.post(`/api/extensions/${EXT_ID}/init-server`, { data: {} });
    expect(started.ok(), await started.text()).toBe(true);

    for (const [key, title, project, projectLabel] of [
      ['ship-alpha', 'Ship the alpha banner?', ALPHA, 'Linear ALP'],
      ['ship-beta', 'Ship the beta banner?', BETA, 'Linear BET'],
    ]) {
      const raised = await request.post(`/api/ext/${EXT_ID}/raise`, {
        data: { key, title, project, projectLabel },
      });
      expect(raised.ok(), await raised.text()).toBe(true);
      raisedIds.push(((await raised.json()) as { id: string }).id);
    }
  });

  test.afterAll(async ({ request }) => {
    // Leave the leg as it was found: nothing waiting, nothing approved, off.
    for (const key of ['ship-alpha', 'ship-beta']) {
      const resolved = await request.post(`/api/ext/${EXT_ID}/resolve`, { data: { key } });
      expect(resolved.ok(), `withdraw ${key}: ${await resolved.text()}`).toBe(true);
    }
    // Withdrawn is not gone: each decision leaves a history row, unread, and
    // an unread row widens the bell for every spec after this one.
    await expectNoOpenDecisions(request, EXT_ID);
    await leaveNoUnreadRows(request, (row) => raisedIds.includes(row.subject.id));
    await request.post(`/api/extensions/${EXT_ID}/revoke`, { data: {} });
    await request.post(`/api/extensions/${EXT_ID}/disable`, { data: {} });
    if (extensionDir) rmSync(extensionDir, { recursive: true, force: true });
    rmSync(PROJECTS_ROOT, { recursive: true, force: true });
    await request.post('/api/extensions/reload', { data: {} });
  });

  test('groups decisions under their projects, and 👍 answers one', async ({ page }) => {
    await page.goto('/tasks');
    await page.getByTestId('inbox-bell').click();

    const alphaTitle = page.getByText('Ship the alpha banner?');
    await expect(alphaTitle).toBeVisible();
    await expect(page.getByText('Ship the beta banner?')).toBeVisible();

    const headings = page.locator('[data-slot="inbox-project-heading"]');
    await expect(headings).toHaveCount(2);
    await expect(headings.filter({ hasText: `alpha-${RUN}` })).toContainText('Linear ALP');
    await expect(headings.filter({ hasText: `beta-${RUN}` })).toContainText('Linear BET');

    const waiting = page.locator('[data-slot="inbox-waiting"]');
    const alphaRow = waiting.locator(
      `[data-slot="inbox-waiting-decision"][data-project="alpha-${RUN}"]`
    );
    await expect(alphaRow.getByText('Ship the alpha banner?')).toBeVisible();
    await expect(alphaRow.getByText(/reviewer agent found nothing/)).toBeVisible();

    await alphaRow.getByRole('button', { name: 'Ship it' }).click();
    // Answered: it leaves "Needs You", the headings go with the second project,
    // and Activity reads it back as the person's answer.
    await expect(waiting.getByText('Ship the alpha banner?')).toHaveCount(0);
    await expect(page.locator('[data-slot="inbox-project-heading"]')).toHaveCount(0);
    await expect(
      page.locator('[data-history="true"]').filter({ hasText: 'Ship the alpha banner?' })
    ).toContainText(/Ship it · you at /);
  });
});
