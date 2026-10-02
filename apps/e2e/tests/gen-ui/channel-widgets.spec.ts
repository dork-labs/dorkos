import { test, expect } from '../../fixtures';

for (const [name, width, height] of [
  ['phone', 390, 844],
  ['tablet', 768, 1024],
  ['desktop', 1440, 1000],
] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${name} ${theme}: native task submission and durable status`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript((value) => localStorage.setItem('dorkos-theme', value), theme);
      await page.goto('/dev/gen-ui?widgetChannel=only', { waitUntil: 'domcontentloaded' });
      const fixture = page.getByTestId('widget-channel-showcase');
      await expect(fixture).toBeVisible({ timeout: 30_000 });
      await fixture.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(fixture.getByText('Enter Task title.', { exact: true })).toBeVisible();
      const input = fixture.getByRole('textbox', { name: 'Task title' });
      await input.fill('My draft task');
      await fixture.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(fixture.getByText('Choose Priority.', { exact: true })).toBeVisible();
      await fixture.getByRole('combobox', { name: 'Priority' }).click();
      await page.getByRole('option', { name: 'Normal', exact: true }).click();
      await input.press('Enter');
      await expect(fixture.getByTestId('widget-action-status')).toContainText(
        'Saved; waiting for LifeOS.'
      );
      await expect(fixture.getByRole('button', { name: 'Save task', exact: true })).toBeEnabled();
      await fixture.getByRole('button', { name: 'Mark handled', exact: true }).click();
      await expect(fixture.getByTestId('widget-action-status')).toContainText(
        'reported that it handled'
      );
      await expect(input).toHaveValue('My draft task');
      await fixture.getByRole('button', { name: 'Toggle approval', exact: true }).click();
      await expect(
        fixture.getByRole('button', { name: 'Ask LifeOS to review', exact: true })
      ).toBeDisabled();
      await expect(fixture).toContainText('needs an approved document route');
      await fixture.screenshot({ path: `/tmp/doc-channel-widgets-${name}-${theme}.png` });
      expect(await fixture.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true
      );
    });
  }
}

test('uncertain save retries the same click while status updates preserve editing', async ({
  page,
}) => {
  await page.goto('/dev/gen-ui?widgetChannel=only', { waitUntil: 'domcontentloaded' });
  const fixture = page.getByTestId('widget-channel-showcase');
  await fixture.getByRole('textbox', { name: 'Task title' }).fill('Draft');
  await fixture.getByRole('combobox', { name: 'Priority' }).click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await fixture.getByRole('button', { name: 'Fail next save', exact: true }).click();
  await fixture.getByRole('button', { name: 'Save task', exact: true }).click();
  const row = fixture.getByTestId('widget-action-status');
  await expect(row).toContainText('Save not confirmed');
  const id = await row.getAttribute('data-event-id');
  await fixture.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(row).toContainText('Saved; waiting');
  expect(await row.getAttribute('data-event-id')).toBe(id);
  await fixture.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(fixture.getByTestId('widget-action-status')).toHaveCount(2);
  const input = fixture.getByRole('textbox', { name: 'Task title' });
  await input.focus();
  await input.evaluate((node: HTMLInputElement) => node.setSelectionRange(2, 2));
  await fixture
    .getByRole('button', { name: 'Mark unknown', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(fixture.getByTestId('widget-action-status').first()).toContainText(
    'outcome unknown'
  );
  await expect(input).toBeFocused();
  expect(await input.evaluate((node: HTMLInputElement) => node.selectionStart)).toBe(2);
  await expect(input).toHaveValue('Draft');
});
