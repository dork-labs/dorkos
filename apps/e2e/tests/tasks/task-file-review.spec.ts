import { test, expect } from '../../fixtures';

/**
 * A task whose next run would be capped though no cap stands yet (DOR-5060):
 * the row says so and offers Review file, which shows the file before anything
 * is approved, and Approve sends only the hash that review showed.
 *
 * The flag is drawn onto a seeded schedule's row by rewriting the list the
 * server answers, and the approval is answered here too: whether the server
 * flags a row and what it then approves are its own tests
 * (`agent-mode/__tests__/file-cap.test.ts`, `routes/__tests__/tasks-agent-mode.test.ts`).
 */
test.describe('Tasks — reviewing a task’s file with no cap standing', () => {
  test('Review file shows the whole file, and Approve sends only the hash it showed', async ({
    tasksApi,
    page,
    basePage,
    tasksPage,
  }) => {
    const task = await tasksApi.createTask(`review-${Date.now()}`);
    const review = {
      hash: 'sha256:e2e-shown',
      previous: null,
      current: 'Triage the inbox.\nReply to anything urgent.',
    };
    await page.route('**/api/tasks', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const tasks = (await response.json()) as Array<{ id: string }>;
      await route.fulfill({
        response,
        json: tasks.map((t) =>
          t.id === task.id ? { ...t, fileCapNext: true, fileReview: review } : t
        ),
      });
    });
    let sent: unknown = null;
    await page.route(`**/api/tasks/${task.id}/approve-file`, async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'urn:dorkos:problem:conflict',
          title: 'That clashes with a change made meanwhile.',
          status: 409,
          code: 'conflict',
          detail: 'Nothing to change',
          message: 'The file changed again. Review it once more.',
        }),
      });
    });

    // Routes are in place before the app first loads, so the list it fetches is the rewritten one.
    await basePage.goto();
    await basePage.waitForAppReady();
    await tasksPage.open();

    await expect(
      tasksPage.dialog.getByText('The next run is capped until you approve the file.')
    ).toBeVisible();
    await tasksPage.dialog.getByRole('button', { name: 'Review file', exact: true }).click();
    const reviewing = page.getByRole('dialog', { name: 'Review the file' });
    await expect(reviewing.getByText('Reply to anything urgent.')).toBeVisible();
    // No approved copy was kept, so the review says why every line reads as added.
    await expect(
      reviewing.getByText('No approved copy was kept, so the whole file shows.')
    ).toBeVisible();
    expect(sent).toBeNull();

    await reviewing.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => sent).toEqual({ hash: review.hash });
    // A file that moved on since the review approves nothing, and says why.
    await expect(reviewing.getByText('The file changed again. Review it once more.')).toBeVisible();
  });
});
