import { test, expect } from '../../fixtures';
import type { Page } from '@playwright/test';
import type { Task } from '@dorkos/shared/types';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// Browser proof of the review shell, using made-up data and intercepted task
// responses. Server refusal and unattended tool behavior have separate tests.
const instructions = Array.from(
  { length: 80 },
  (_, index) => `Step ${index + 1}: check the sample ledger and record any differences.`
).join('\n');

function sampleTask(off: boolean): Task {
  return {
    id: 'sample-review',
    name: 'sample-ledger',
    displayName: 'Sample ledger',
    prompt: instructions,
    cron: '0 0 31 2 *',
    timezone: 'UTC',
    defaultCron: '0 0 31 2 *',
    defaultTimezone: 'UTC',
    timingOverridden: false,
    enabled: !off,
    sticky: false,
    status: 'pending_approval',
    agentId: null,
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    runtime: 'claude-code',
    model: null,
    effort: null,
    account: null,
    packageOwned: off ? 'record' : null,
    approvalChanges: [],
    filePath: '/tmp/sample-pack/skills/sample-ledger/SKILL.md',
    createdAt: '2026-11-03T12:00:00Z',
    updatedAt: '2026-11-03T12:00:00Z',
    reason: 'Check the sample ledger each morning.',
    reasonSource: 'dorkos',
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    origin: off ? 'file' : null,
    nextRuns: [],
    approvalRevision: 'a'.repeat(64),
    folderRules: { status: 'none', applied: [], pending: [] },
  };
}

test('Inbox schedule carries the real server revision at 390 @smoke', async ({
  page,
  request,
  basePage,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  // TestModeRuntime declares synthetic mode ids; this task uses the real task enum.
  // Only its displayed capability is supplied here: task reads and writes stay real.
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    const map = await response.json();
    for (const capability of Object.values(map.capabilities) as Array<{
      permissionModes: { values: unknown[] };
    }>) {
      capability.permissionModes.values.push({
        id: 'default',
        label: 'Default',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks before making changes.',
      });
    }
    await route.fulfill({ json: map });
  });
  const created = await request.post('/api/tasks', {
    data: {
      name: `sample-inbox-${randomUUID().slice(0, 8)}`,
      description: 'Review a sample ledger.',
      prompt: instructions,
      target: 'global',
      cron: '0 0 31 2 *',
      enabled: true,
      permissionMode: 'default',
    },
  });
  expect(created.ok()).toBe(true);
  const task = (await created.json()) as Task;
  try {
    const parked = await request.patch(`/api/tasks/${task.id}`, {
      data: { status: 'pending_approval' },
    });
    expect(parked.ok()).toBe(true);
    const listedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/tasks' && response.request().method() === 'GET'
    );
    await basePage.goto();
    await basePage.waitForAppReady();
    const listed = (await (await listedResponse).json()) as Task[];
    const revision = listed.find((item) => item.id === task.id)?.approvalRevision;
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    await page.getByTestId('inbox-bell').click();
    const card = page
      .getByRole('dialog', { name: 'Inbox', exact: true })
      .locator(`[data-testid="schedule-approval-card"][data-task-id="${task.id}"]`);
    const approve = card.getByRole('button', {
      name: `Approve ${task.displayName ?? task.name}`,
      exact: true,
    });
    await expect(approve).toBeEnabled();
    // The server is shared with earlier specs, and schedules sit below any
    // tool approval they left waiting. Scroll the Inbox to the card the way a
    // person would; the card itself must then fit, answer row included.
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeInViewport({ ratio: 1 });
    await expect(approve).toBeInViewport();
    const body = card.locator('[data-slot="schedule-review-body"]');
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(approve).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('phone-inbox-review.png') });
    const approvalRequest = page.waitForRequest(
      (req) => new URL(req.url()).pathname === `/api/tasks/${task.id}` && req.method() === 'PATCH'
    );
    const approved = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === `/api/tasks/${task.id}` &&
        res.request().method() === 'PATCH'
    );
    await approve.click();
    expect((await approvalRequest).postDataJSON()).toMatchObject({
      status: 'active',
      expectedApprovalRevision: revision,
    });
    // The real test runtime declares only synthetic modes, so it refuses this task enum
    // even though the browser displays it. This case proves revision delivery and the
    // outgoing request; successful approval and its receipt have card/route tests.
    const answer = await approved;
    expect(answer.status()).toBe(400);
    expect(await answer.json()).toMatchObject({ code: 'unsupported_task_mode' });
  } finally {
    await request.delete(`/api/tasks/${task.id}`);
  }
});
async function withReviewModes(page: Page) {
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    const map = await response.json();
    const base = Object.values(map.capabilities)[0] as Record<string, unknown>;
    map.capabilities['claude-code'] = {
      ...base,
      type: 'claude-code',
      permissionModes: {
        supported: true,
        default: 'acceptEdits',
        values: [
          {
            id: 'acceptEdits',
            label: 'Accept edits',
            stop: 'act',
            asks: 'when-risky',
            reach: 'edit',
            promise: 'Edits files without asking.',
          },
          {
            id: 'bypassPermissions',
            label: 'Full autonomy',
            stop: 'autonomy',
            asks: 'never',
            reach: 'everything',
            promise: 'Runs everything without asking.',
          },
        ],
      },
    };
    await route.fulfill({ json: map });
  });
}

for (const surface of ['light', 'dark', 'phone'] as const) {
  test(`schedule row review keeps actions visible: ${surface} @smoke`, async ({
    page,
    basePage,
    tasksPage,
  }, testInfo) => {
    let task = sampleTask(false);
    const writes: unknown[] = [];
    let staleOnApproval = false;
    await page.setViewportSize(
      surface === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 900 }
    );
    await page.emulateMedia({
      colorScheme: surface === 'dark' ? 'dark' : 'light',
      reducedMotion: 'reduce',
    });
    await page.addInitScript(
      (theme) => localStorage.setItem('dorkos-theme', theme),
      surface === 'dark' ? 'dark' : 'light'
    );
    await withReviewModes(page);
    await page.route('**/api/tasks', (route) => route.fulfill({ json: [task] }));
    await page.route('**/api/tasks/sample-review', (route) => {
      writes.push(route.request().postDataJSON());
      if (staleOnApproval) {
        staleOnApproval = false;
        task = {
          ...task,
          prompt: instructions.replace('Step 1:', 'Updated step 1:'),
          approvalRevision: 'b'.repeat(64),
        };
        return route.fulfill({
          status: 409,
          json: {
            error: 'This schedule changed. Review it again.',
            code: 'schedule_review_changed',
          },
        });
      }
      return route.fulfill({ json: { ...task, status: 'active' } });
    });
    await basePage.goto();
    await basePage.waitForAppReady();
    await tasksPage.open();
    const reviewButton = page.getByRole('button', { name: 'Review Sample ledger', exact: true });
    await expect(reviewButton).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${surface}-row.png`) });
    await reviewButton.click();
    const review = page.getByRole('dialog', { name: 'Review schedule', exact: true });
    const title = review.getByRole('heading', { name: 'Review schedule', exact: true });
    const body = review.locator('[data-slot="schedule-review-body"]');
    await expect(title).toBeFocused();
    await expect(title).toBeInViewport();
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
    const openedScrollTop = await body.evaluate((element) => element.scrollTop);
    await page.screenshot({ path: testInfo.outputPath(`${surface}-review.png`) });
    await page.keyboard.press('ArrowDown');
    await expect(title).toBeFocused();
    await expect(review.locator('select')).toHaveValue('acceptEdits');
    await expect(review.getByText('Runs as: Accept edits', { exact: true })).toBeVisible();
    await expect(review.getByText('No agent', { exact: true })).toBeVisible();
    const approve = review.getByRole('button', { name: 'Approve Sample ledger', exact: true });
    await expect(approve).toBeEnabled();
    await expect(approve).toBeInViewport();
    const prompt = review.locator('[data-slot="schedule-prompt"]');
    expect(
      await prompt.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)
    ).toBe(true);
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(review.locator('select')).toBeInViewport();
    await expect(review.getByText('Runs as: Accept edits', { exact: true })).toBeInViewport();
    await expect(approve).toBeInViewport();
    await expect(review.getByRole('button', { name: 'Reject Sample ledger' })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`${surface}-review-scrolled.png`) });
    await page.keyboard.press('Escape');
    await expect(review).toBeHidden();
    await expect(reviewButton).toBeFocused();
    expect(writes).toEqual([]);

    task = sampleTask(true);
    await page.reload();
    await basePage.waitForAppReady();
    // The open Tasks dialog is restored on reload; opening it again puts the palette behind it.
    await expect(tasksPage.dialog).toBeVisible();
    const toggle = page.getByRole('switch', { name: 'Toggle sample-ledger' });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(review).toBeVisible();
    await expect(title).toBeFocused();
    await expect(
      review.getByRole('button', { name: 'Approve Sample ledger', exact: true })
    ).toHaveCount(0);
    await expect(
      review.getByRole('button', { name: 'Approve Sample ledger and turn it on' })
    ).toBeInViewport();
    if (surface === 'phone') {
      expect(
        await review.locator('[data-slot="schedule-file-origin"]').evaluate((element) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          while ((node = walker.nextNode())) {
            if (node.textContent === 'SKILL.md') {
              const range = document.createRange();
              range.selectNodeContents(node);
              return range.getClientRects().length;
            }
          }
          return 0;
        })
      ).toBe(1);
    }
    await page.screenshot({ path: testInfo.outputPath(`${surface}-package-review.png`) });
    expect(writes).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await review.getByRole('button', { name: 'Approve Sample ledger and turn it on' }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      status: 'active',
      enabled: true,
      expectedApprovalRevision: task.approvalRevision,
    });
    await expect(review).toBeHidden();
    task = sampleTask(false);
    await page.reload();
    await basePage.waitForAppReady();
    await reviewButton.click();
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    staleOnApproval = true;
    await review.getByRole('button', { name: 'Approve Sample ledger', exact: true }).click();
    await expect(review.getByRole('status')).toHaveText('This schedule changed. Review it again.');
    await expect(review.getByRole('button', { name: 'Review again' })).toBeFocused();
    await expect(review.getByRole('button', { name: 'Run Sample ledger once' })).toBeDisabled();
    await expect(
      review.getByRole('button', { name: 'Approve Sample ledger', exact: true })
    ).toBeDisabled();
    await expect(review.locator('[data-slot="schedule-prompt"]')).toHaveText(instructions);
    await page.keyboard.press('a');
    await page.screenshot({ path: testInfo.outputPath(`${surface}-changed-review.png`) });
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const beforeResetScrollTop = await body.evaluate((element) => element.scrollTop);
    expect(beforeResetScrollTop).toBeGreaterThan(1);
    await expect(review.getByRole('button', { name: 'Review again' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await review.getByRole('button', { name: 'Review again' }).click();
    await expect(title).toBeFocused();
    await expect(title).toBeInViewport();
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
    const resetScrollTop = await body.evaluate((element) => element.scrollTop);
    const resetEvidence = testInfo.outputPath(`${surface}-scroll-reset.json`);
    await writeFile(
      resetEvidence,
      JSON.stringify({
        openedScrollTop,
        beforeResetScrollTop,
        resetScrollTop,
        titleFocused: await title.evaluate((element) => element === document.activeElement),
      })
    );
    await testInfo.attach(`${surface}-scroll-reset`, {
      path: resetEvidence,
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath(`${surface}-changed-review-reset.png`) });
    await expect(review.locator('[data-slot="schedule-prompt"]')).toHaveText(task.prompt);
    await expect(
      review.getByRole('button', { name: 'Approve Sample ledger', exact: true })
    ).toBeEnabled();
    await page.keyboard.press('Escape');
  });
}

// Keep this independent of the multi-state review flow: CI's 30-second budget
// belongs to one behavior, rather than a fifth reload at the end of that flow.
test('dark schedule review shows the Full autonomy warning @smoke', async ({
  page,
  basePage,
  tasksPage,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('dorkos-theme', 'dark'));
  const task = { ...sampleTask(false), permissionMode: 'bypassPermissions' };
  await page.route('**/api/tasks', (route) => route.fulfill({ json: [task] }));
  await page.route('**/api/capabilities', async (route) => {
    const response = await route.fetch();
    const map = await response.json();
    const base = Object.values(map.capabilities)[0] as Record<string, unknown>;
    map.capabilities['claude-code'] = {
      ...base,
      type: 'claude-code',
      permissionModes: {
        supported: true,
        default: 'acceptEdits',
        values: [
          {
            id: 'bypassPermissions',
            label: 'Full autonomy',
            stop: 'autonomy',
            asks: 'never',
            reach: 'everything',
            promise: 'Runs everything without asking.',
          },
        ],
      },
    };
    await route.fulfill({ json: map });
  });
  await basePage.goto();
  await basePage.waitForAppReady();
  await tasksPage.open();
  await tasksPage.dialog.getByRole('button', { name: 'Review Sample ledger', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review schedule', exact: true });
  const full = review.getByText('Runs as: Full autonomy', { exact: true });
  await expect(full).toHaveClass(/text-status-warning-fg/);
  await page.screenshot({ path: testInfo.outputPath('dark-full-review.png') });
});
// M2: the misplaced-mode row must lead to a real, readable review sheet.
for (const surface of ['light', 'phone'] as const) {
  test(`misplaced schedule permissions open for review: ${surface} @smoke`, async ({
    page,
    basePage,
    tasksPage,
  }, testInfo) => {
    const task = {
      ...sampleTask(false),
      name: 'sample-ledger',
      displayName: 'Sample ledger',
      origin: 'file' as const,
      reasonSource: 'dorkos' as const,
      reason:
        "`permissions` is in the wrong place, so this schedule won't run. Move it under `schedule`.",
      prompt:
        surface === 'phone'
          ? Array.from(
              { length: 32 },
              (_, index) => `Sample ${index + 1}: ${'counterrevolutionary'.repeat(8)}`
            ).join('\n')
          : 'Read the sample ledger.\nRecord any differences in a short report.',
      enabled: false,
    };
    await page.setViewportSize(
      surface === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 900 }
    );
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.addInitScript(() => localStorage.setItem('dorkos-theme', 'light'));
    await withReviewModes(page);
    await page.route('**/api/tasks', (route) => route.fulfill({ json: [task] }));
    await basePage.goto(
      process.env.DORKOS_REVIEW_TEST_CWD
        ? `/?dir=${encodeURIComponent(process.env.DORKOS_REVIEW_TEST_CWD)}`
        : '/'
    );
    await basePage.waitForAppReady();
    await tasksPage.open();
    const open = page.getByRole('button', { name: 'Review Sample ledger', exact: true });
    await expect(open).toBeVisible();
    await expect(tasksPage.dialog.getByRole('button', { name: /Run.*once/ })).toHaveCount(0);
    await expect(tasksPage.dialog.getByRole('alert')).toHaveText(
      'permissions is in the wrong place, so this schedule won’t run. Move it under schedule.'
    );
    await page.screenshot({
      path: testInfo.outputPath(surface === 'phone' ? 'phone-row.png' : 'row-light.png'),
    });
    await open.click();
    const review = page.getByRole('dialog', { name: 'Review schedule', exact: true });
    await expect(review).toBeVisible();
    await expect(review.getByRole('alert')).toBeInViewport();
    await expect(review.getByRole('alert')).toHaveText(
      'permissions is in the wrong place, so this schedule won’t run. Move it under schedule.'
    );
    await expect(
      review.getByRole('button', { name: 'Approve Sample ledger', exact: true })
    ).toBeDisabled();
    await expect(review.locator('[data-slot="schedule-prompt"]')).toHaveText(task.prompt);
    await expect(
      review.getByRole('button', { name: 'Approve Sample ledger and turn it on' })
    ).toHaveCount(0);
    const body = review.locator('[data-slot="schedule-review-body"]');
    if (surface === 'phone') {
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight / 2;
      });
      await expect(review.getByRole('alert')).toBeInViewport();
      const warningY = (await review.getByRole('alert').boundingBox())!.y;
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(review.getByRole('alert')).toBeInViewport();
      expect(
        Math.abs((await review.getByRole('alert').boundingBox())!.y - warningY)
      ).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath('phone-review-scrolled-long-words.png') });
    }
    const trial = review.getByRole('button', { name: 'Run Sample ledger once', exact: true });
    await expect(trial).toBeInViewport();
    await expect(
      review.getByText('Runs as Accept edits, not the value in the file.', { exact: true })
    ).toBeInViewport();
    expect((await trial.boundingBox())!.y).toBeGreaterThan(
      (await review.locator('[data-slot="schedule-prompt"]').boundingBox())!.y
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      surface === 'phone' ? 390 : 1280
    );
    await page.screenshot({
      path: testInfo.outputPath(surface === 'phone' ? 'phone-review.png' : 'review-light.png'),
    });
  });
}
