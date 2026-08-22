import { test, expect } from '../../fixtures';

/**
 * The /connections page, as it exists today.
 *
 * This spec used to drive a dialog opened by `?relay=open` with an
 * "Integrations / Activity" tab strip. That was not selector drift — the
 * surface was replaced (DOR-857). It is a page now, with two regions on one
 * scroll: Messaging and Accounts.
 *
 * The messaging region has an empty state for an install with no connection at
 * all. It is not reachable here: DorkOS registers a built-in `claude-code`
 * connection of its own, so a running server always has at least one.
 */
test.describe('Connections page @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('both regions are on one page, no tabs between them', async ({ connectionsPage }) => {
    await connectionsPage.goto();

    await expect(connectionsPage.heading).toBeAttached();
    await expect(connectionsPage.messaging).toBeVisible();
    await expect(connectionsPage.accounts).toBeVisible();
    // The separation is a heading and a scroll, not a click. A tab strip here
    // would mean one region's consent story is hidden behind the other.
    await expect(connectionsPage.page.getByRole('tablist')).toHaveCount(0);
  });

  test('the command palette lands on the page', async ({ connectionsPage }) => {
    await connectionsPage.openFromPalette();

    await expect(connectionsPage.heading).toBeAttached();
    await expect(connectionsPage.page).toHaveURL(/\/connections/);
  });

  test('a link to the retired messaging dialog lands on the messaging region', async ({
    connectionsPage,
  }) => {
    await connectionsPage.page.goto('/?relay=open');

    await expect(connectionsPage.page).toHaveURL(/\/connections/);
    await expect(connectionsPage.page).toHaveURL(/region=messaging/);
    await expect(connectionsPage.messaging).toBeVisible();
  });

  test('a retired Settings link lands there too', async ({ connectionsPage }) => {
    await connectionsPage.page.goto('/?settings=integrations');

    await expect(connectionsPage.page).toHaveURL(/\/connections/);
    await expect(connectionsPage.messaging).toBeVisible();
  });

  test('messaging lists the built-in Claude Code connection, switched on', async ({
    connectionsPage,
  }) => {
    await connectionsPage.goto();

    await expect(
      connectionsPage.messaging.getByRole('heading', { name: 'Live now' })
    ).toBeVisible();
    await expect(connectionsPage.liveConnection('Claude Code').getByRole('switch')).toBeChecked();
  });

  test('messaging offers a way to reach agents that is not set up yet', async ({
    connectionsPage,
  }) => {
    await connectionsPage.goto();

    await expect(
      connectionsPage.messaging.getByRole('heading', { name: 'Add a way to reach them' })
    ).toBeVisible();
    await expect(connectionsPage.addConnection('Telegram')).toBeVisible();
  });

  test('accounts names its carriers rather than inventing a word for them', async ({
    connectionsPage,
  }) => {
    await connectionsPage.goto();

    // "Composio & Nango", verbatim. Both "engine" and "provider" failed to mean
    // anything to the people using this, so the section says who they are.
    await expect(connectionsPage.carrierSection).toBeVisible();
    await expect(connectionsPage.accounts.getByText(/\bprovider\b/i)).toHaveCount(0);
  });

  test('accounts renders something honest even with nothing connectable', async ({
    connectionsPage,
  }) => {
    await connectionsPage.goto();

    // The region never vanishes. With no carrier key it names the services and
    // the one-time setup standing in the way, in the vendor's own name.
    await expect(connectionsPage.accounts).toBeVisible();
    await expect(
      connectionsPage.accounts.getByText(/connects through composio|connected/i).first()
    ).toBeVisible();
  });
});
