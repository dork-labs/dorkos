import { test, expect } from '../../fixtures';

/**
 * The Scheduled tasks dialog.
 *
 * Two things about this spec used to be untrue of the product. It assumed a
 * schedule called `test` already existed — it never seeded one, so the dialog's
 * contents were whatever the developer's own data directory happened to hold.
 * And it asserted a row of cron preset buttons (`5m`, `9am`, `Weekdays`…) that
 * no longer exists anywhere in the client: creating a schedule now starts on a
 * template picker, and the cadence is chosen with a frequency control rather
 * than a preset row.
 *
 * Both are fixed here by seeding what the test needs and asserting what the UI
 * actually renders. The seeded schedule uses a cron that can never fire — the
 * suite's API leg enables tasks *and* runs the real agent runtime, so an
 * ordinary cadence would eventually spawn a billed agent turn mid-run.
 */
test.describe('Tasks — Scheduler Dialog @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('opens and closes the Scheduled tasks dialog', async ({ tasksPage }) => {
    await tasksPage.open();
    await expect(tasksPage.heading).toBeVisible();

    // Deliberately no assertion about the panel being empty. Whether anything is
    // scheduled is a property of the whole server, and the two tests below seed
    // schedules into it — under `fullyParallel` they run alongside this one, so
    // "No schedules yet." is a claim only one test can be right about at a time.
    // This test owns the dialog opening and closing; that is what it asserts.
    await tasksPage.close();
    await expect(tasksPage.dialog).toBeHidden();
  });

  test('displays a seeded schedule', async ({ tasksApi, page, basePage, tasksPage }) => {
    const task = await tasksApi.createTask(`test-${Date.now()}`);

    // Seed first, then load — the task list is fetched when the dialog mounts.
    await page.reload();
    await basePage.waitForAppReady();
    await tasksPage.open();

    await expect(tasksPage.dialog.getByText(task.name)).toBeVisible();
    // The row humanizes its cron. This one is the 31st of February, which is why
    // it never runs. `.first()` because the row renders the cadence twice — once
    // in the collapsed summary and once in the detail beneath it.
    await expect(tasksPage.dialog.getByText(/only in February/i).first()).toBeVisible();
  });

  test("a seeded schedule's toggle reports it as on", async ({
    tasksApi,
    page,
    basePage,
    tasksPage,
  }) => {
    const task = await tasksApi.createTask(`test-${Date.now()}`);

    await page.reload();
    await basePage.waitForAppReady();
    await tasksPage.open();

    // The switch is labelled from the schedule's slug and carries no text of its
    // own, so this has to be an accessible-name match.
    const toggle = tasksPage.dialog.getByRole('switch', { name: `Toggle ${task.name}` });
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();
  });

  test('creating a schedule starts on the template picker', async ({ tasksPage }) => {
    await tasksPage.open();
    await tasksPage.openCreateDialog();

    await expect(tasksPage.createDialog.getByText('Start from a template')).toBeVisible();
    await expect(tasksPage.startFromScratchButton).toBeVisible();
    // The form is not merely hidden behind a disclosure — it is not rendered at
    // all until a starting point is chosen.
    await expect(tasksPage.nameInput).toHaveCount(0);
  });

  test('Start from scratch opens an empty form that will not submit', async ({ tasksPage }) => {
    await tasksPage.open();
    await tasksPage.openCreateDialog();
    await tasksPage.startFromScratch();

    await expect(tasksPage.nameInput).toBeVisible();
    await expect(tasksPage.descriptionInput).toBeVisible();
    await expect(tasksPage.promptInput).toBeVisible();
    await expect(tasksPage.createButton).toBeDisabled();

    await tasksPage.cancelButton.click();
    await expect(tasksPage.createDialog).toBeHidden();
  });

  test('the form enables Create once a name and a prompt are given', async ({ tasksPage }) => {
    await tasksPage.open();
    await tasksPage.openCreateDialog();
    await tasksPage.startFromScratch();

    await expect(tasksPage.createButton).toBeDisabled();

    await tasksPage.nameInput.fill('E2E Draft Schedule');
    await tasksPage.promptInput.fill('Run the checks');

    // A cadence is deliberately not required — a schedule with no cron is an
    // on-demand task.
    await expect(tasksPage.createButton).toBeEnabled();
  });

  test('the cadence is chosen by frequency, and previewed in words', async ({ tasksPage }) => {
    await tasksPage.open();
    await tasksPage.openCreateDialog();
    await tasksPage.startFromScratch();
    await tasksPage.openScheduleSection();

    await tasksPage.selectFrequency('Every day');
    await expect(tasksPage.createDialog.getByText('Runs every day at 9:00 AM')).toBeVisible();
  });
});
