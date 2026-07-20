import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * Page Object for the shell-level right inspector panel — its toggle, the Pulse
 * spine tab, and the ambient attention badge.
 *
 * The panel defaults CLOSED on every route; {@link open} reveals it. On routes
 * with no contextual tab (e.g. the dashboard) Pulse fills the panel; on `/session`
 * a contextual tab (Agent Profile) wins the default per the container's
 * auto-select.
 */
export class RightPanelPage {
  readonly page: Page;
  readonly basePage: BasePage;

  /** The always-present toggle in the top bar (aria-label starts "Open"/"Close right panel"). */
  readonly toggle: Locator;
  /** The shared right-panel header (tab strip / single-tab title live here). */
  readonly header: Locator;
  /** The Pulse panel body (rendered when Pulse is the active tab). */
  readonly pulsePanel: Locator;
  /** The ambient needs-attention count pill on the toggle. */
  readonly badge: Locator;
  /** Pulse's "Needs attention" section heading (scoped to the panel — the dashboard has its own). */
  readonly attentionHeading: Locator;
  /** Pulse's "Activity" section heading (scoped to the panel — the dashboard has its own). */
  readonly activityHeading: Locator;
  /** The header's single-tab title shown when only Pulse is visible. */
  readonly singleTabTitle: Locator;
  /** The Agent Profile contextual tab (visible on `/session`). */
  readonly agentProfileTab: Locator;
  /** The Pulse tab in the strip (present alongside contextual tabs on `/session`). */
  readonly pulseTab: Locator;

  constructor(page: Page) {
    this.page = page;
    this.basePage = new BasePage(page);
    // Matches both the closed ("Open right panel…") and open ("Close right panel")
    // labels, including the closed label's "— N items need attention" suffix.
    this.toggle = page.getByRole('button', { name: /right panel/i });
    this.header = page.locator('[data-slot="right-panel-header"]');
    this.pulsePanel = page.locator('[data-slot="pulse"]');
    this.badge = page.locator('[data-testid="right-panel-attention-badge"]');
    // Scope Pulse's own sections to the panel: the dashboard route renders its own
    // "Needs Attention"/"Recent activity" surfaces in the main column too.
    this.attentionHeading = this.pulsePanel.getByRole('heading', { name: 'Needs attention' });
    this.activityHeading = this.pulsePanel.getByRole('heading', { name: 'Activity' });
    this.singleTabTitle = this.header.getByText('Pulse', { exact: true });
    this.agentProfileTab = this.header.getByRole('tab', { name: 'Agent Profile' });
    this.pulseTab = this.header.getByRole('tab', { name: 'Pulse' });
  }

  /** Navigate to a route and wait for the shell. SSE means no networkidle — use DOM-ready. */
  async goto(path = '/') {
    await this.page.goto(path, { waitUntil: 'domcontentloaded' });
    await this.basePage.waitForAppReady();
  }

  /** Open the panel if it is currently closed (idempotent). */
  async open() {
    const label = await this.toggle.getAttribute('aria-label');
    if (label?.startsWith('Open')) {
      await this.toggle.click();
    }
  }
}
