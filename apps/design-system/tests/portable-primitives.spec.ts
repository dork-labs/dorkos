import { expect, test } from '@playwright/test';

test.describe('portable primitives @smoke', () => {
  test('keeps opposing portal themes through nested menus and dialogs', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Light theme', exact: true }).click();
    const colors: string[] = [];
    for (const theme of ['light', 'dark']) {
      const trigger = page.getByRole('button', { name: `Open ${theme} popover`, exact: true });
      await trigger.click();
      const host = page.locator(`[data-portal-host="${theme}"]`);
      const panel = host.locator(`[data-theme-overlay="${theme}"]`);
      await expect(panel).toBeVisible();
      colors.push(await panel.evaluate((el) => getComputedStyle(el).backgroundColor));
      const menuTrigger = panel.getByRole('button', { name: `${theme} nested menu`, exact: true });
      await menuTrigger.focus();
      await page.keyboard.press('ArrowDown');
      const menu = host.locator(`[data-theme-menu="${theme}"]`);
      await expect(menu.getByRole('menuitem', { name: 'First choice', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(menu.getByRole('menuitem', { name: 'More choices', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowRight');
      const submenu = host.locator(`[data-theme-submenu="${theme}"]`);
      await expect(
        submenu.getByRole('menuitem', { name: 'Nested choice', exact: true })
      ).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(menu).toHaveCount(0);
      await expect(
        page.locator(`[data-theme-island="${theme}"]`).getByText('Nested choice', { exact: true })
      ).toBeVisible();
      await expect(menuTrigger).toBeFocused();
      const dialogTrigger = panel.getByRole('button', { name: `Open ${theme} nested dialog` });
      await dialogTrigger.click();
      const dialog = host.getByRole('dialog', { name: `${theme} dialog`, exact: true });
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        await page
          .locator(`[data-theme-island="${theme}"]`)
          .evaluate((el) => getComputedStyle(el).backgroundColor)
      );
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(dialogTrigger).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(trigger).toBeFocused();
    }
    expect(colors[0]).not.toBe(colors[1]);
    await page.getByRole('button', { name: 'Open document popover' }).click();
    const defaultPortal = page.locator('[data-document-portal]');
    await expect(defaultPortal).toBeVisible();
    expect(await defaultPortal.evaluate((el) => el.closest('[data-catalog-theme]'))).toBeNull();
    expect(errors).toEqual([]);
  });

  test('retains selection, disabled controls and immediate menu reopen', async ({ page }) => {
    await page.goto('/');
    const checkbox = page.locator('#demo-check-b');
    await page.getByText('Auto-approve tool calls', { exact: true }).click();
    await expect(checkbox).toBeChecked();
    await page.getByText('Codex', { exact: true }).click();
    await expect(page.locator('#demo-radio-codex')).toBeChecked();
    const select = page.getByRole('region', { name: 'Select', exact: true }).getByRole('combobox');
    await select.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'Claude Code', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'Codex', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(select).toHaveText('Codex');
    await expect(select).toBeFocused();
    const menuTrigger = page.getByRole('button', { name: 'Open Menu', exact: true });
    await menuTrigger.click();
    await page.getByRole('menuitem', { name: 'View Details' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await menuTrigger.click();
    await expect(page.getByRole('menuitem', { name: 'View Details' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menuTrigger).toBeFocused();
  });

  test('opens hover surfaces and confirmation actions from real controls', async ({ page }) => {
    await page.goto('/');
    const tooltipTrigger = page.getByRole('button', { name: 'Hover me', exact: true });
    await tooltipTrigger.hover();
    await expect(page.getByRole('tooltip')).toHaveText('This is a tooltip');
    await page.getByRole('heading', { name: 'Shared foundations' }).hover();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.getByRole('button', { name: '@claude-code', exact: true }).hover();
    await expect(page.getByText('Claude Code Runtime', { exact: true })).toBeVisible();
    await page.getByRole('heading', { name: 'Shared foundations' }).hover();
    await expect(page.getByText('Claude Code Runtime', { exact: true })).toBeHidden();
    const trigger = page.getByRole('button', { name: 'Delete Agent', exact: true });
    await trigger.click();
    const alert = page.getByRole('alertdialog');
    await expect(alert.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await alert.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(alert).toBeHidden();
    await expect(trigger).toBeFocused();
    const toggle = page.locator('#demo-switch-on');
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('#demo-switch-disabled')).toBeDisabled();
    const textarea = page.getByPlaceholder('Write a message…');
    await textarea.fill('A typed example');
    await expect(textarea).toHaveValue('A typed example');
  });

  test('supports slider keys, real scrolling, tab panels and progress', async ({ page }) => {
    await page.goto('/');
    const slider = page
      .getByRole('region', { name: 'Slider', exact: true })
      .getByRole('slider')
      .first();
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuenow', '41');
    const tabs = page.getByRole('region', { name: 'Tabs', exact: true });
    await tabs.getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Settings' })).toBeFocused();
    await expect(tabs.getByRole('tabpanel')).toContainText('Settings content');
    const viewport = page.locator('#scroll-area [data-slot="scroll-area-viewport"]').first();
    await viewport.evaluate((el) => {
      el.scrollTop = 100;
    });
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Advance progress' }).click();
    await expect(page.getByRole('progressbar', { name: 'Example progress' })).toHaveAttribute(
      'aria-valuenow',
      '60'
    );
  });

  test('keeps context submenu selection inside its provider', async ({ page }) => {
    await page.goto('/');
    await page.getByText('Context menu area', { exact: true }).click({ button: 'right' });
    const host = page.locator('[data-catalog-portal-host]');
    await expect(host.getByRole('menuitem', { name: 'Open example', exact: true })).toBeVisible();
    await host.getByRole('menuitem', { name: 'More actions' }).hover();
    await host.getByRole('menuitem', { name: 'Copy example', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copied example' })).toBeVisible();
    await expect(host.getByRole('menu')).toHaveCount(0);
  });

  test('supplies collapsible animations and suppresses motion without client CSS', async ({
    page,
  }) => {
    await page.goto('/');
    const section = page.getByRole('region', { name: 'Collapsible', exact: true });
    await section.getByRole('button', { name: 'Toggle', exact: true }).click();
    const content = section.locator('[data-slot="collapsible-content"]');
    await expect(content).toBeVisible();
    await expect(content).toHaveCSS('animation-name', 'collapsible-down');
    expect(
      await content.evaluate((el) =>
        getComputedStyle(el).getPropertyValue('--radix-collapsible-content-height')
      )
    ).not.toBe('');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(content).toHaveCSS('animation-name', 'none');
    await page.getByRole('button', { name: 'Open Dialog', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create agent', exact: true });
    await expect(dialog).toHaveCSS('animation-name', 'none');
    await expect(dialog).toHaveCSS('transition-property', 'none');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open Right Sheet', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Agent Details', exact: true });
    await expect(sheet).toHaveCSS('animation-name', 'none');
    await expect(sheet).toHaveCSS('transition-property', 'none');
  });

  test('keeps dialogs and sheets inside a phone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    for (const [trigger, title] of [
      ['Open Dialog', 'Create agent'],
      ['Open Right Sheet', 'Agent Details'],
    ]) {
      await page.getByRole('button', { name: trigger, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: title, exact: true });
      await expect(dialog).toBeVisible();
      // Radix must trap keyboard navigation while a modal is open.
      for (let step = 0; step < 6; step++) {
        await page.keyboard.press('Tab');
        await expect
          .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
          .toBe(true);
      }
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      await expect
        .poll(async () => {
          const settled = await dialog.boundingBox();
          return settled ? settled.x + settled.width : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(391);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: trigger, exact: true })).toBeFocused();
    }
  });
});
