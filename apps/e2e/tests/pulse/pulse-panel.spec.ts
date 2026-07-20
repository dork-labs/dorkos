import { test, expect } from '../../fixtures';

/**
 * Pulse — the right panel's always-present spine tab, its ambient attention
 * badge, and the contextual-tab-wins rule.
 *
 * These exercise the shell, not a runtime, so they need no real Claude response:
 * the panel, its tabs, and the badge are pure client state over route + the
 * attention/activity models.
 */
test.describe('Pulse — right inspector panel @smoke', () => {
  test('opens on the dashboard to Pulse with its attention + activity sections', async ({
    rightPanel,
  }) => {
    await rightPanel.goto('/');
    // The panel defaults closed everywhere — the operator opens it.
    await rightPanel.open();

    // No contextual tab applies on the dashboard, so Pulse fills the panel.
    await expect(rightPanel.pulsePanel).toBeVisible();
    await expect(rightPanel.attentionHeading).toBeVisible();
    await expect(rightPanel.activityHeading).toBeVisible();

    // Single visible contribution → the header names it (Pulse) instead of a
    // blank close-only bar, and shows no tab strip.
    await expect(rightPanel.singleTabTitle).toBeVisible();
    await expect(rightPanel.header.getByRole('tablist')).toHaveCount(0);
  });

  test('opens on a session to the contextual default (Agent Profile), not Pulse', async ({
    rightPanel,
  }) => {
    // Fresh context, straight to /session: the container's auto-select prefers the
    // first contextual tab, so the always-present Pulse never steals the default.
    await rightPanel.goto('/session');
    await rightPanel.open();

    await expect(rightPanel.agentProfileTab).toBeVisible();
    await expect(rightPanel.agentProfileTab).toHaveAttribute('aria-selected', 'true');
    // Pulse is still a reachable tab, just not the active one here.
    await expect(rightPanel.pulseTab).toHaveAttribute('aria-selected', 'false');
  });

  test('the attention badge is honest — hidden when nothing needs the operator', async ({
    rightPanel,
  }) => {
    await rightPanel.goto('/');

    // With the panel closed, the badge reflects the needs-attention count. The
    // toggle's aria-label is the source of truth: a plain "Open right panel"
    // means zero pending → no badge; a "— N items need attention" suffix means
    // the env has real items → the badge must then be present. Either way the
    // badge and the label agree.
    const label = (await rightPanel.toggle.getAttribute('aria-label')) ?? '';
    if (/need/i.test(label)) {
      await expect(rightPanel.badge).toBeVisible();
    } else {
      await expect(rightPanel.badge).toHaveCount(0);
    }

    // Opening the panel always hides the badge — the count is on screen inside.
    await rightPanel.open();
    await expect(rightPanel.pulsePanel).toBeVisible();
    await expect(rightPanel.badge).toHaveCount(0);
  });
});
