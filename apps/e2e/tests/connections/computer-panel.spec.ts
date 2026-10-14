import { test, expect } from '../../fixtures';
import { readFileSync } from 'node:fs';

/** Uses the existing test-mode project; every computer call is intercepted, with no guest or inference. */
test.describe('Computer — panel and PiP resource lifecycle @smoke', () => {
  test('moves one observing desktop between panel and PiP without stopping the computer', async ({
    page,
    rightPanel,
  }) => {
    const seed = await page.request.post('/api/test/seed-agent');
    expect(seed.ok()).toBe(true);
    const { agentDir } = (await seed.json()) as { agentDir: string };
    let phase: 'ready' | 'stopped' = 'ready';
    let controlled = false;
    const calls: string[] = [];
    const inputs: { kind: string; action?: string; x?: number; y?: number }[] = [];
    const png = `data:image/png;base64,${readFileSync(new URL('../../fixtures/computer-desktop.png', import.meta.url)).toString('base64')}`;
    await page.route('**/api/computers**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      calls.push(`${request.method()} ${path}`);
      if (path === '/api/computers/input') {
        inputs.push(request.postDataJSON());
        return route.fulfill({ json: { ok: true } });
      }
      if (path === '/api/computers/frame') {
        return route.fulfill({
          json: {
            dataUrl: png,
            width: 640,
            height: 360,
            generation: 4,
            controlledByYou: controlled,
          },
        });
      }
      if (path === '/api/computers/control') {
        controlled = request.method() === 'POST';
        return route.fulfill({
          json: controlled ? { leaseId: 'test-lease', generation: 4 } : { ok: true },
        });
      }
      if (path === '/api/computers') {
        return route.fulfill({
          json: {
            id: 'local',
            name: 'Fixture computer',
            supported: true,
            phase,
            generation: 4,
            ready: phase === 'ready',
            runtimeId: 'test-mode',
            cwd: agentDir,
          },
        });
      }
      // Unexpected lifecycle requests fail the test instead of reaching the real server.
      return route.fulfill({ status: 500, json: { error: 'Unexpected computer mutation' } });
    });
    await rightPanel.goto(`/session?dir=${encodeURIComponent(agentDir)}`);
    await rightPanel.selectView('Computer');
    const desktop = page.getByRole('img', { name: 'Live computer desktop' });
    await expect(desktop).toBeVisible();
    await expect(page.getByText('Watching', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Take over', exact: true }).click();
    await expect(page.getByText('You have control', { exact: true })).toBeVisible();
    const control = page.getByRole('application', { name: 'Computer desktop control' });
    const box = await control.boundingBox();
    if (!box) throw new Error('The computer control has no viewport');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => inputs.some((input) => input.action === 'down')).toBe(true);
    const down = inputs.find((input) => input.action === 'down')!;
    // The physical mouse rounds CSS coordinates; two guest pixels cover that rounding at this scale.
    expect(Math.abs(down.x! - 320)).toBeLessThanOrEqual(2);
    expect(Math.abs(down.y! - 180)).toBeLessThanOrEqual(2);
    await expect.poll(() => inputs.some((input) => input.action === 'up')).toBe(true);
    inputs.length = 0;
    await page.mouse.click(box.x + box.width / 2, box.y + 1);
    // The tall panel letterboxes the wide desktop; blank pixels are never guest input.
    expect(inputs).toEqual([]);

    await page.getByRole('button', { name: 'Pop computer out', exact: true }).click();
    const pip = page.locator('[data-slot="floating-panel"]');
    await expect(pip).toHaveAttribute('aria-label', 'Fixture computer');
    await expect(pip.getByRole('img', { name: 'Live computer desktop' })).toBeVisible();
    await expect(page.getByText('Viewing in PiP.', { exact: true })).toBeVisible();
    await expect(desktop).toHaveCount(1);
    await expect(pip.getByText('Watching', { exact: true })).toBeVisible();
    await expect(pip).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: test.info().outputPath('computer-panel-pip.png'),
      fullPage: true,
    });
    expect(calls).toContain('DELETE /api/computers/control');
    await rightPanel.selectView('Files');
    await expect(pip).toHaveAttribute('aria-label', 'Fixture computer');
    await expect(pip.getByRole('img', { name: 'Live computer desktop' })).toBeVisible();

    await pip.getByRole('button', { name: 'Return computer to panel', exact: true }).click();
    await expect(pip).toHaveCount(0);
    await expect(desktop).toBeVisible();
    await page.getByRole('button', { name: 'Pop computer out', exact: true }).click();
    phase = 'stopped';
    await expect(pip.getByText('Computer stopped.', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(desktop).toHaveCount(0);
    phase = 'ready';
    await pip.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(desktop).toBeVisible();
    await pip.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(pip).toHaveCount(0);
    await expect(desktop).toBeVisible();
    expect(calls.filter((call) => /\/(stop|start|sessions|sign-in)$/.test(call))).toEqual([]);
  });
});

test.describe('Computer — phone PiP @smoke', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('moves out of the modal panel and releases control on minimize', async ({
    page,
    rightPanel,
  }) => {
    const seed = await page.request.post('/api/test/seed-agent');
    const { agentDir } = (await seed.json()) as { agentDir: string };
    let controlled = false;
    const calls: string[] = [];
    const png = `data:image/png;base64,${readFileSync(new URL('../../fixtures/computer-desktop.png', import.meta.url)).toString('base64')}`;
    await page.route('**/api/computers**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      calls.push(`${request.method()} ${path}`);
      if (path === '/api/computers/frame')
        return route.fulfill({
          json: {
            dataUrl: png,
            width: 640,
            height: 360,
            generation: 4,
            controlledByYou: controlled,
          },
        });
      if (path === '/api/computers/control') {
        controlled = request.method() === 'POST';
        return route.fulfill({
          json: controlled ? { leaseId: 'phone-lease', generation: 4 } : { ok: true },
        });
      }
      if (path === '/api/computers')
        return route.fulfill({
          json: {
            id: 'local',
            name: 'Phone fixture computer',
            supported: true,
            phase: 'ready',
            generation: 4,
            ready: true,
            runtimeId: 'test-mode',
            cwd: agentDir,
          },
        });
      return route.fulfill({ status: 500, json: { error: 'Unexpected computer mutation' } });
    });
    await rightPanel.goto(`/session?dir=${encodeURIComponent(agentDir)}`);
    await rightPanel.selectView('Computer');
    const add = rightPanel.header.getByRole('button', { name: 'Add view', exact: true });
    await expect(add).toHaveCSS('width', '44px');
    await expect(add).toHaveCSS('height', '44px');
    await add.click();
    await expect(page.getByRole('menuitem', { name: 'Files', exact: true })).toHaveCSS(
      'min-height',
      '44px'
    );
    await page.keyboard.press('Escape');
    const dialog = page.getByRole('dialog', { name: 'Panel', exact: true });
    await page.evaluate(() => {
      Object.defineProperties(window.visualViewport!, {
        height: { value: 420, configurable: true },
        offsetTop: { value: 50, configurable: true },
      });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(dialog).toHaveCSS('top', '50px');
    await expect(dialog).toHaveCSS('height', '420px');
    await page.evaluate(() => {
      delete (window.visualViewport as unknown as { height?: number }).height;
      delete (window.visualViewport as unknown as { offsetTop?: number }).offsetTop;
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect(page.getByRole('img', { name: 'Live computer desktop' })).toBeVisible();
    await page.getByRole('button', { name: 'Pop computer out', exact: true }).click();
    const sheet = page.locator('[data-slot="pip-sheet"]');
    await expect(sheet).toBeVisible();
    await expect(rightPanel.header).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Take over', exact: true }).click();
    await expect(sheet.getByText('You have control', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 900, height: 600 });
    await expect(page.locator('[data-slot="floating-panel"]')).toBeVisible();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => controlled).toBe(false);
    await expect(page.locator('[data-slot="computer-viewer"]')).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    // Desktop-to-phone rotation lands minimized so the returning sheet never covers the chat.
    await expect(page.locator('[data-slot="pip-minibar"]')).toBeVisible();
    await page
      .locator('[data-slot="pip-minibar"]')
      .getByRole('button', { name: 'Phone fixture computer', exact: true })
      .click();
    await expect(sheet).toBeVisible();
    await expect(page.locator('[data-slot="floating-panel"]')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Take over', exact: true }).click();
    await expect(sheet.getByText('You have control', { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(page.locator('[data-slot="pip-minibar"]')).toBeVisible();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => controlled).toBe(false);
    expect(calls).toContain('DELETE /api/computers/control');
    await page.screenshot({
      path: test.info().outputPath('computer-phone-minibar.png'),
      fullPage: true,
    });
    expect(calls.filter((call) => /\/(stop|start|sessions|sign-in|input)$/.test(call))).toEqual([]);
  });
});
