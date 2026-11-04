import { test, expect } from '../../fixtures';
import type { Task } from '@dorkos/shared/types';

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
    await page.route('**/api/tasks', (route) => route.fulfill({ json: [task] }));
    await page.route('**/api/tasks/sample-review', (route) => {
      writes.push(route.request().postDataJSON());
      if (staleOnApproval) {
        staleOnApproval = false;
        task = {
          ...task,
          prompt: 'Review the sample ledger before recording differences.',
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
    await expect(title).toBeFocused();
    await expect(title).toBeInViewport();
    await page.keyboard.press('ArrowDown');
    await expect(title).toBeFocused();
    await expect(review.locator('select')).toHaveValue('acceptEdits');
    await expect(review.getByText('Runs as: Accept edits', { exact: true })).toBeVisible();
    await expect(review.getByText('No agent', { exact: true })).toBeVisible();
    const body = review.locator('[data-slot="schedule-review-body"]');
    expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
    const approve = review.getByRole('button', { name: 'Approve Sample ledger', exact: true });
    await expect(approve).toBeEnabled();
    await expect(approve).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`${surface}-review.png`) });
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
    await expect(review.getByRole('button', { name: 'Review again' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await review.getByRole('button', { name: 'Review again' }).click();
    await expect(title).toBeFocused();
    await expect(title).toBeInViewport();
    expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(review.locator('[data-slot="schedule-prompt"]')).toHaveText(task.prompt);
    await expect(
      review.getByRole('button', { name: 'Approve Sample ledger', exact: true })
    ).toBeEnabled();
    await page.keyboard.press('Escape');
    if (surface === 'dark') {
      task = { ...sampleTask(false), permissionMode: 'bypassPermissions' };
      await page.reload();
      await basePage.waitForAppReady();
      await reviewButton.click();
      const full = review.getByText('Runs as: Full autonomy', { exact: true });
      await expect(full).toHaveClass(/text-status-warning-fg/);
      await page.screenshot({ path: testInfo.outputPath('dark-full-review.png') });
      await page.keyboard.press('Escape');
    }
  });
}
