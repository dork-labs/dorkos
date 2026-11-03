import { test, expect } from '../../fixtures';

/**
 * The /connections page, as it exists today: one plain list of apps (DOR-2418).
 *
 * It used to be a dialog opened by `?relay=open` (DOR-857 replaced it with a
 * page), then a page with two regions, Messaging and Accounts. Now every
 * connection is a row in one list, and chat apps carry a small "Chat" tag.
 *
 * The suite shares one server, so another spec may have set up an app; these
 * tests assert what holds either way rather than a first-visit page.
 */
test.describe('Connections page @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('keeps apps in one list, beside browser setup', async ({ connectionsPage }) => {
    await connectionsPage.goto();

    await expect(connectionsPage.heading).toBeAttached();
    await expect(connectionsPage.allApps).toBeVisible();
    // Apps stay one list; browser discovery has its own tab.
    await expect(connectionsPage.content).toBeVisible();
    await expect(
      connectionsPage.content.getByRole('tab', { name: 'Apps', exact: true })
    ).toBeVisible();
    await expect(
      connectionsPage.content.getByRole('tab', { name: 'Browsers', exact: true })
    ).toBeVisible();
    await expect(connectionsPage.content.getByRole('region', { name: 'Messaging' })).toHaveCount(0);
    await expect(
      connectionsPage.content.getByRole('region', { name: 'Accounts', exact: true })
    ).toHaveCount(0);
  });

  test('the command palette lands on the page', async ({ connectionsPage }) => {
    await connectionsPage.openFromPalette();

    await expect(connectionsPage.heading).toBeAttached();
    await expect(connectionsPage.page).toHaveURL(/\/connections/);
  });

  test('a link to the retired messaging dialog lands on the list', async ({ connectionsPage }) => {
    await connectionsPage.page.goto('/?relay=open');

    await expect(connectionsPage.page).toHaveURL(/\/connections/);
    await expect(connectionsPage.page).not.toHaveURL(/region=/);
    await expect(connectionsPage.allApps).toBeVisible();
  });

  test('a retired Settings link lands there too', async ({ connectionsPage }) => {
    await connectionsPage.page.goto('/?settings=integrations');

    await expect(connectionsPage.page).toHaveURL(/\/connections/);
    await expect(connectionsPage.allApps).toBeVisible();
  });

  test('an old ?region= link still lands on the list', async ({ connectionsPage }) => {
    await connectionsPage.page.goto('/connections?region=messaging');

    await expect(connectionsPage.allApps).toBeVisible();
  });

  test('never shows the built-in agent relay as something to connect', async ({
    connectionsPage,
  }) => {
    await connectionsPage.goto();

    // DorkOS's own Claude Code relay is how it works inside, not an app.
    await expect(connectionsPage.list.getByText('Claude Code')).toHaveCount(0);
  });

  test('lists chat apps as ordinary rows with a Chat tag', async ({ connectionsPage }) => {
    await connectionsPage.goto();

    const telegram = connectionsPage
      .catalogApp('telegram')
      .or(connectionsPage.yourApp('Telegram'))
      .first();
    await expect(telegram).toBeVisible();
    await expect(telegram).toContainText('Chat');
  });

  test('keeps the webhook with the tools for developers', async ({ connectionsPage }) => {
    await connectionsPage.goto();

    const developers = connectionsPage.page.getByRole('region', { name: 'For developers' });
    const setUp = connectionsPage.yourApp('Webhook');
    // Set up once, a webhook moves to "Yours"; otherwise it waits in its group.
    await expect(developers.getByText('Webhook').or(setUp).first()).toBeVisible();
    await expect(
      connectionsPage.page.getByTestId('all-apps-list').getByText('Webhook')
    ).toHaveCount(0);
  });

  test('lists the popular apps even with nothing set up to reach them', async ({
    connectionsPage,
  }) => {
    await connectionsPage.goto();

    await expect(
      connectionsPage.connect('Gmail').or(connectionsPage.yourApp('Gmail')).first()
    ).toBeVisible();
    // The page names Composio and Nango where it points at Settings ›
    // Connections, where those keys live. "provider" meant nothing to people.
    await expect(connectionsPage.carrierSection).toBeVisible();
    await expect(connectionsPage.list.getByText(/\bprovider\b/i)).toHaveCount(0);
  });
});

test('browser discovery reads only on tap and forgets picker email @smoke', async ({
  connectionsPage,
}, testInfo) => {
  const page = connectionsPage.page;
  let scans = 0;
  await page.route('**/api/your-browser/scan', async (route) => {
    scans += 1;
    expect(route.request().method()).toBe('POST');
    await route.fulfill({
      json: {
        supported: true,
        unreadable: [],
        profiles: [
          {
            browser: 'chrome',
            directory: 'Default',
            displayName: 'Demo work',
            email: 'work@example.test',
          },
          {
            browser: 'edge',
            directory: 'Profile 1',
            displayName: 'Demo personal',
            email: 'personal@example.test',
          },
        ],
      },
    });
  });
  await connectionsPage.goto();
  await page.getByRole('tab', { name: 'Browsers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Find my browsers' })).toBeVisible();
  expect(scans).toBe(0);
  await page.getByRole('button', { name: 'Find my browsers' }).click();
  await expect(page.getByText('work@example.test', { exact: true })).toBeVisible();
  expect(scans).toBe(1);
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('button', { name: 'Use Chrome · Demo work' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`browser-picker-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Use Chrome · Demo work' }).click();
  await expect(page.getByText('work@example.test', { exact: true })).toHaveCount(0);
  await expect(page.getByText('personal@example.test', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Selected · Off', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Chrome · Demo work' })).toBeFocused();
  await page.getByRole('tab', { name: 'Apps', exact: true }).click();
  await page.getByRole('tab', { name: 'Browsers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Find my browsers' })).toBeVisible();
  await expect(page.getByText('Selected · Off', { exact: true })).toHaveCount(0);
  expect(scans).toBe(1);
});
