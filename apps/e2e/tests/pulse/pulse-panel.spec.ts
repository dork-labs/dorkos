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
  test('opens to Pulse, alone, on a route with nothing contextual to say', async ({
    rightPanel,
  }) => {
    // **Scheduled rather than Home, since phase R2.** Home IS #team (spec
    // `one-bar-header` §3.6), so it now has a contextual tab of its own and is
    // no longer a route where Pulse is the only thing in the panel — the case
    // below is what Home does instead. Scheduled still is one, which is what
    // this case has always been about: the panel with a single contribution in
    // it.
    await rightPanel.goto('/tasks');
    // The panel defaults closed everywhere — the operator opens it.
    await rightPanel.open();

    // No contextual tab applies here, so Pulse fills the panel.
    await expect(rightPanel.pulsePanel).toBeVisible();
    await expect(rightPanel.attentionHeading).toBeVisible();
    await expect(rightPanel.activityHeading).toBeVisible();

    // Single visible contribution → the header names it (Pulse) instead of a
    // blank close-only bar, and shows no tab strip.
    await expect(rightPanel.singleTabTitle).toBeVisible();
    await expect(rightPanel.header.getByRole('tablist')).toHaveCount(0);
  });

  test('opens on Home to the room, with Pulse one press away', async ({ rightPanel }) => {
    // Home renders #team, so the Room tab applies there and the contextual rule
    // hands it the default — the same rule that gives /session its Profile.
    // What Pulse is owed is that it stays REACHABLE (spec §5 case 9): it is the
    // panel's spine, and a contextual tab winning the default must never be a
    // contextual tab taking the panel.
    await rightPanel.goto('/');
    await rightPanel.open();

    await expect(rightPanel.roomTab).toHaveAttribute('aria-selected', 'true');
    await expect(rightPanel.pulseTab).toHaveAttribute('aria-selected', 'false');

    await rightPanel.pulseTab.click();
    await expect(rightPanel.pulsePanel).toBeVisible();
    await expect(rightPanel.attentionHeading).toBeVisible();
  });

  test('opens on a session to the contextual default (Profile), not Pulse', async ({
    rightPanel,
  }) => {
    // Fresh context, straight to /session: the container's auto-select prefers the
    // first contextual tab, so the always-present Pulse never steals the default.
    await rightPanel.goto('/session');
    await rightPanel.open();

    await expect(rightPanel.profileTab).toBeVisible();
    await expect(rightPanel.profileTab).toHaveAttribute('aria-selected', 'true');
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
    // Pulse is where that count lives, and on Home it is now one press away
    // rather than the default (the Room tab wins there, phase R2), so this does
    // what an operator does: opens the panel, then asks for Pulse.
    await rightPanel.open();
    await rightPanel.pulseTab.click();
    await expect(rightPanel.pulsePanel).toBeVisible();
    await expect(rightPanel.badge).toHaveCount(0);
  });
});
