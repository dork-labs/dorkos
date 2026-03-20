import { test, expect } from '../../fixtures';

test.describe('Pulse — Scheduler Dialog @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('opens and closes the Pulse Scheduler dialog', async ({ pulsePage }) => {
    await pulsePage.open();
    await expect(pulsePage.heading).toBeVisible();
    await expect(pulsePage.schedulesHeading).toBeVisible();

    await pulsePage.close();
    await expect(pulsePage.dialog).toBeHidden();
  });

  test('displays existing schedules', async ({ pulsePage }) => {
    await pulsePage.open();

    // The "test" schedule should be visible (created via API/config)
    await expect(pulsePage.dialog.getByText('test')).toBeVisible();
    await expect(pulsePage.dialog.getByText(/every hour/i)).toBeVisible();
  });

  test('opens and closes the New Schedule dialog', async ({ pulsePage }) => {
    await pulsePage.open();
    await pulsePage.openCreateDialog();

    await expect(pulsePage.createDialog).toBeVisible();
    await expect(pulsePage.nameInput).toBeVisible();
    await expect(pulsePage.promptInput).toBeVisible();
    await expect(pulsePage.scheduleInput).toBeVisible();
    await expect(pulsePage.createButton).toBeDisabled();

    await pulsePage.cancelButton.click();
    await expect(pulsePage.createDialog).toBeHidden();
  });

  test('shows cron preset buttons in create dialog', async ({ pulsePage }) => {
    await pulsePage.open();
    await pulsePage.openCreateDialog();

    const presets = ['5m', '15m', '1h', '6h', 'Daily', '9am', 'Weekdays', 'Weekly', 'Monthly'];
    for (const preset of presets) {
      await expect(
        pulsePage.createDialog.getByRole('button', { name: preset, exact: true })
      ).toBeVisible();
    }
  });

  test('preset populates schedule field', async ({ pulsePage }) => {
    await pulsePage.open();
    await pulsePage.openCreateDialog();

    await pulsePage.selectPreset('Daily');
    await expect(pulsePage.scheduleInput).toHaveValue(/0 0 \* \* \*/);
  });

  test('enables create button when required fields are filled', async ({ pulsePage }) => {
    await pulsePage.open();
    await pulsePage.openCreateDialog();

    await expect(pulsePage.createButton).toBeDisabled();

    await pulsePage.nameInput.fill('Test Schedule');
    await pulsePage.promptInput.fill('Run tests');
    await pulsePage.selectPreset('Daily');

    await expect(pulsePage.createButton).toBeEnabled();
  });

  test('schedule toggle switch is interactive', async ({ pulsePage }) => {
    await pulsePage.open();

    const toggle = pulsePage.dialog.getByRole('switch', { name: /toggle test/i });
    await expect(toggle).toBeVisible();
    // Toggle is checked by default (schedule is active)
    await expect(toggle).toBeChecked();
  });
});
