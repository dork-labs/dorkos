import { test, expect } from '../../fixtures';

/** Real isolated PTYs, no commands or agent turns; closing views must preserve resources. */
for (const phone of [false, true]) {
  test.describe(`Terminal resource lifecycle — ${phone ? 'phone' : 'desktop'} @smoke`, () => {
    if (phone) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    test('a view closed during create stays closed after publication and reopens through +', async ({
      page,
      rightPanel,
    }, testInfo) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let created!: (id: string) => void;
      const publication = new Promise<string>((resolve) => {
        created = resolve;
      });
      const ids: string[] = [];
      let creates = 0;
      await page.route('**/api/terminal', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        creates += 1;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        const { id } = (await response.json()) as { id: string };
        ids.push(id);
        created(id);
        await gate;
        await route.fulfill({ response });
      });
      try {
        await rightPanel.goto('/session');
        await rightPanel.selectView('Terminal');
        await publication;
        const shell = rightPanel.header.getByRole('tab', { name: 'Shell 1', exact: true });
        await expect(shell).toBeVisible();
        await rightPanel.header
          .getByRole('button', { name: 'Close Shell 1 view', exact: true })
          .click();
        await expect(shell).toHaveCount(0);
        release();
        const closedIds = () =>
          page.evaluate(() =>
            Object.keys(sessionStorage)
              .filter((key) => key.startsWith('dork.terminal.tabs:'))
              .flatMap(
                (key) =>
                  (JSON.parse(sessionStorage.getItem(key)!) as { closedIds?: string[] })
                    .closedIds ?? []
              )
          );
        await expect.poll(async () => (await closedIds()).length).toBe(1);
        const [id] = await closedIds();
        expect(ids).toContain(id);
        await expect
          .poll(() =>
            page.evaluate(() =>
              Object.keys(sessionStorage)
                .filter((key) => key.startsWith('dork.terminal.tabs:'))
                .flatMap(
                  (key) => (JSON.parse(sessionStorage.getItem(key)!) as { ids: string[] }).ids
                )
            )
          )
          .toEqual([id]);
        const createsBeforeReopen = creates;
        await expect(shell).toHaveCount(0);
        await rightPanel.header.getByRole('button', { name: 'Add view', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Shell 1', exact: true }).click();
        await expect(shell).toHaveAttribute('aria-selected', 'true');
        await expect(shell).toHaveAttribute('id', `right-panel-tab-resource/terminal/${id}`);
        expect(creates, 'reopening a view must reuse its PTY').toBe(createsBeforeReopen);
        await page.screenshot({ path: testInfo.outputPath('pending-shell-reopened.png') });
      } finally {
        release();
        await page.unroute('**/api/terminal');
        for (const id of ids) await page.request.delete(`/api/terminal/${id}`);
      }
    });

    test('New terminal before its owner mounts appends a shell to persisted PTYs', async ({
      page,
      rightPanel,
    }, testInfo) => {
      const directory = await page.request.get('/api/directory/default');
      expect(directory.ok()).toBe(true);
      const { path: cwd } = (await directory.json()) as { path: string };
      const initial = await page.request.post('/api/terminal', { data: { cwd } });
      expect(initial.ok()).toBe(true);
      const { id: existing } = (await initial.json()) as { id: string };
      const ids = [existing];
      await page.addInitScript(
        ({ cwd, existing }) => {
          sessionStorage.setItem(
            `dork.terminal.tabs::${cwd}`,
            JSON.stringify({ ids: [existing], activeIndex: 0 })
          );
        },
        { cwd, existing }
      );
      await page.route('**/api/terminal', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        ids.push(((await response.json()) as { id: string }).id);
        await route.fulfill({ response });
      });
      try {
        await rightPanel.goto(`/session?dir=${encodeURIComponent(cwd)}`);
        await rightPanel.ensureTabStripOpen();
        await expect(rightPanel.header.locator('[data-view-category="terminal"]')).toHaveCount(0);
        await rightPanel.header.getByRole('button', { name: 'Add view', exact: true }).click();
        await page.getByRole('menuitem', { name: 'New terminal', exact: true }).click();
        const shells = rightPanel.header.locator('[role="tab"][data-view-category="terminal"]');
        await expect(shells).toHaveCount(2);
        const fresh = rightPanel.header.getByRole('tab', { name: 'Shell 2', exact: true });
        await expect(fresh).toHaveAttribute('aria-selected', 'true');
        await expect(fresh).toHaveAttribute(
          'id',
          /^right-panel-tab-resource\/terminal\/[0-9a-f-]{36}$/
        );
        const freshId = (await fresh.getAttribute('id'))!.replace(
          'right-panel-tab-resource/terminal/',
          ''
        );
        expect(freshId).not.toBe(existing);
        expect(ids).toContain(freshId);
        await expect
          .poll(() =>
            page.evaluate(
              (cwd) =>
                (
                  JSON.parse(sessionStorage.getItem(`dork.terminal.tabs::${cwd}`)!) as {
                    ids: string[];
                  }
                ).ids,
              cwd
            )
          )
          .toEqual([existing, freshId]);
        await expect(
          rightPanel.header.getByRole('tab', { name: 'Shell 1', exact: true })
        ).toHaveAttribute('id', `right-panel-tab-resource/terminal/${existing}`);
        await page.screenshot({ path: testInfo.outputPath('persisted-and-fresh-shell.png') });
      } finally {
        await page.unroute('**/api/terminal');
        for (const id of ids) await page.request.delete(`/api/terminal/${id}`);
      }
    });
  });
}
