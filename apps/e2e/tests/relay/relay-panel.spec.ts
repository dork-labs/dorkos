import { test, expect } from '../../fixtures';

/**
 * The Relay dialog, as it exists today.
 *
 * This spec used to assert an "Activity / Endpoints / Adapters" tab strip and a
 * `relay.system.console` endpoint row. That was not drift in a selector — the UI
 * was replaced (DOR-523). The dialog is titled "Connections", the palette entry
 * that opens it says "Integrations", and the panel has two tabs: Integrations
 * and Activity.
 *
 * The panel has an empty state too, for an install with no adapter instance at
 * all. It is not reachable here: DorkOS registers a built-in `claude-code`
 * adapter of its own, so a running server always has at least one connection and
 * always renders the tabs.
 */
test.describe('Relay — Connections dialog @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('opens and closes the Connections dialog', async ({ relayPage }) => {
    await relayPage.open();
    await expect(relayPage.heading).toBeVisible();

    await relayPage.close();
    await expect(relayPage.dialog).toBeHidden();
  });

  test('has Integrations and Activity tabs, starting on Integrations', async ({ relayPage }) => {
    await relayPage.open();

    await expect(relayPage.tab('Integrations')).toBeVisible();
    await expect(relayPage.tab('Activity')).toBeVisible();
    await expect(relayPage.tab('Integrations')).toHaveAttribute('aria-selected', 'true');
  });

  test('the Integrations tab lists the built-in Claude Code connection, switched on', async ({
    relayPage,
  }) => {
    await relayPage.open();

    const active = relayPage.activePanel;
    await expect(active.getByRole('heading', { name: 'Active Integrations' })).toBeVisible();
    await expect(active.getByText('Claude Code', { exact: true })).toBeVisible();

    // Anchored to the Claude Code card, not to the first switch on the panel.
    // The suite shares one server, so a spec running alongside this one can add
    // an adapter of its own and change what "first" means. The card's toggle
    // carries no accessible name, so the only way to reach it is structurally:
    // the nearest ancestor of the adapter's name that holds a switch.
    const claudeCodeCard = active
      .getByText('Claude Code', { exact: true })
      .locator('xpath=ancestor::div[.//*[@role="switch"]][1]');
    await expect(claudeCodeCard.getByRole('switch')).toBeChecked();
  });

  test('the catalog offers an integration that is not configured yet', async ({ relayPage }) => {
    await relayPage.open();

    const active = relayPage.activePanel;
    await expect(active.getByRole('heading', { name: 'Add Integration' })).toBeVisible();
    await expect(active.getByRole('button', { name: 'Add Telegram' })).toBeVisible();
  });

  test('switches to the Activity tab', async ({ relayPage }) => {
    await relayPage.open();
    await relayPage.tab('Activity').click();

    await expect(relayPage.tab('Activity')).toHaveAttribute('aria-selected', 'true');
    await expect(relayPage.activePanel).toBeVisible();
  });
});
