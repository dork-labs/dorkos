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
        'Saved; waiting for the destination.'
      );
      const id = await fixture.getByTestId('widget-action-status').getAttribute('data-event-id');
      const proof = JSON.parse(
        (await fixture.getByTestId('widget-channel-fixture-proof').textContent())!
      );
      expect(id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(proof.attempts).toEqual([{ id, bytes: proof.persisted[0].bytes, signal: true }]);
      expect(proof.persisted).toHaveLength(1);
      expect(JSON.parse(proof.persisted[0].bytes)).toMatchObject({
        id,
        payload: { title: 'My draft task', priority: 'normal' },
      });
      await expect(fixture.getByRole('button', { name: 'Save task', exact: true })).toBeEnabled();
      await fixture.getByRole('button', { name: 'Mark handled', exact: true }).click();
      await expect(fixture.getByTestId('widget-action-status')).toContainText(
        'reported that it handled'
      );
      await expect(input).toHaveValue('My draft task');
      await fixture.getByRole('button', { name: 'Toggle approval', exact: true }).click();
      const unapproved = fixture.getByRole('button', {
        name: 'Ask LifeOS to review',
        exact: true,
      });
      await expect(
        fixture.getByRole('button', { name: 'Ask LifeOS to review', exact: true })
      ).toBeDisabled();
      await expect(unapproved).toHaveAttribute('aria-disabled', 'true');
      await expect(fixture).toContainText('needs an approved document route');
      const beforeRefusal = JSON.parse(
        (await fixture.getByTestId('widget-channel-fixture-proof').textContent())!
      );
      await unapproved.focus();
      await expect(unapproved).toBeFocused();
      await unapproved.press('Enter');
      expect(
        JSON.parse((await fixture.getByTestId('widget-channel-fixture-proof').textContent())!)
      ).toEqual(beforeRefusal);
      await fixture.screenshot({ path: `/tmp/doc-channel-widgets-${name}-${theme}.png` });
      const approvalReason = fixture.getByText('needs an approved document route', {
        exact: false,
      });
      await approvalReason.scrollIntoViewIfNeeded();
      await expect(approvalReason).toBeVisible();
      await page.screenshot({
        path: `/tmp/doc-channel-widgets-${name}-${theme}-approval-viewport.png`,
      });
      expect(await fixture.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true
      );
    });
  }
}

test('lost accepted response inspects the original without resending while editing is preserved', async ({
  page,
}) => {
  await page.goto('/dev/gen-ui?widgetChannel=only', { waitUntil: 'domcontentloaded' });
  const fixture = page.getByTestId('widget-channel-showcase');
  await fixture.getByRole('textbox', { name: 'Task title' }).fill('Draft');
  await fixture.getByRole('combobox', { name: 'Priority' }).click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await fixture.getByRole('button', { name: 'Lose next save response', exact: true }).click();
  await fixture.getByRole('button', { name: 'Save task', exact: true }).click();
  const row = fixture.getByTestId('widget-action-status');
  await expect(row).toContainText('Save not confirmed');
  const id = await row.getAttribute('data-event-id');
  const before = JSON.parse(
    (await fixture.getByTestId('widget-channel-fixture-proof').textContent())!
  );
  expect(before.attempts).toHaveLength(1);
  expect(before.persisted).toEqual([{ id, bytes: before.attempts[0].bytes }]);
  expect(before.attempts[0].signal).toBe(true);
  await fixture.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(row).toContainText('Saved; waiting');
  expect(await row.getAttribute('data-event-id')).toBe(id);
  const recovered = JSON.parse(
    (await fixture.getByTestId('widget-channel-fixture-proof').textContent())!
  );
  expect(recovered.attempts).toEqual(before.attempts);
  expect(recovered.persisted).toEqual(before.persisted);
  expect(recovered.inspections).toEqual([{ id, signal: true }]);
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

test('pre-persistence failure remains uncertain after generic 404 without resending', async ({
  page,
}) => {
  await page.goto('/dev/gen-ui?widgetChannel=only', { waitUntil: 'domcontentloaded' });
  const fixture = page.getByTestId('widget-channel-showcase');
  await fixture.getByRole('textbox', { name: 'Task title' }).fill('Unconfirmed draft');
  await fixture.getByRole('combobox', { name: 'Priority' }).click();
  await page.getByRole('option', { name: 'Normal', exact: true }).click();
  await fixture.getByRole('button', { name: 'Fail before saving', exact: true }).click();
  await fixture.getByRole('button', { name: 'Save task', exact: true }).click();
  const row = fixture.getByTestId('widget-action-status');
  await expect(row).toContainText('Save not confirmed');
  const id = await row.getAttribute('data-event-id');
  const before = JSON.parse(
    (await fixture.getByTestId('widget-channel-fixture-proof').textContent())!
  );
  expect(before.attempts).toHaveLength(1);
  expect(before.attempts[0]).toMatchObject({ id, signal: true });
  expect(before.persisted).toEqual([]);
  await fixture.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(row).toContainText('Review this action');
  expect(await row.getAttribute('data-event-id')).toBe(id);
  const after = JSON.parse(
    (await fixture.getByTestId('widget-channel-fixture-proof').textContent())!
  );
  expect(after.attempts).toEqual(before.attempts);
  expect(after.persisted).toEqual([]);
  expect(after.inspections).toEqual([{ id, signal: true }]);
  await expect(fixture.getByRole('textbox', { name: 'Task title' })).toHaveValue(
    'Unconfirmed draft'
  );
});
