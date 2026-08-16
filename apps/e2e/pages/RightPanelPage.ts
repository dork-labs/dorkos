import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * Page Object for the shell-level right inspector panel — its toggle, the Pulse
 * spine tab, and the ambient attention badge.
 *
 * The panel defaults CLOSED on every route; {@link open} reveals it. On routes
 * with no contextual tab (Home, Activity, Scheduled) Pulse fills the panel; on
 * `/session` a contextual tab (Profile) wins the default per the container's
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
  /** Pulse's "Needs attention" section heading (scoped to the panel — Home has its own). */
  readonly attentionHeading: Locator;
  /** Pulse's "Activity" section heading (scoped to the panel). */
  readonly activityHeading: Locator;
  /** The header's single-tab title shown when only Pulse is visible. */
  readonly singleTabTitle: Locator;
  /** The Profile contextual tab (visible on `/session`). */
  readonly profileTab: Locator;
  /** The Pulse tab in the strip (present alongside contextual tabs on `/session`). */
  readonly pulseTab: Locator;
  /** The tab strip's scroll container — the box the edge fades are measured against. */
  readonly tabScroller: Locator;
  /** The fade over the strip's left edge, drawn only when tabs are behind it. */
  readonly fadeStart: Locator;
  /** The fade over the strip's right edge, drawn only when tabs are behind it. */
  readonly fadeEnd: Locator;

  constructor(page: Page) {
    this.page = page;
    this.basePage = new BasePage(page);
    // Matches both the closed ("Open right panel…") and open ("Close right panel")
    // labels, including the closed label's "— N items need attention" suffix.
    this.toggle = page.getByRole('button', { name: /right panel/i });
    this.header = page.locator('[data-slot="right-panel-header"]');
    this.pulsePanel = page.locator('[data-slot="pulse"]');
    this.badge = page.locator('[data-testid="right-panel-attention-badge"]');
    // Scope Pulse's own sections to the panel: Home's pinned triage header
    // renders its own "Needs Attention" group in the main column too.
    this.attentionHeading = this.pulsePanel.getByRole('heading', { name: 'Needs attention' });
    this.activityHeading = this.pulsePanel.getByRole('heading', { name: 'Activity' });
    this.singleTabTitle = this.header.getByText('Pulse', { exact: true });
    this.profileTab = this.header.getByRole('tab', { name: 'Profile' });
    this.pulseTab = this.header.getByRole('tab', { name: 'Pulse' });
    // The scroller is the tablist's parent; there is no test id on it, and adding
    // one would put a test hook in the shell header for a box the DOM already
    // identifies unambiguously.
    this.tabScroller = this.header.locator('div:has(> [role="tablist"])');
    this.fadeStart = page.locator('[data-testid="right-panel-tabs-fade-start"]');
    this.fadeEnd = page.locator('[data-testid="right-panel-tabs-fade-end"]');
  }

  /**
   * Pin the right panel's share of the window before the app mounts.
   *
   * Writes the exact JSON `react-resizable-panels` persists for the shell's
   * `autoSaveId`, as an init script rather than an evaluate: the first navigation
   * has to find the value already there, because the panel reads it once on mount.
   *
   * @param rightPct - Percentage of the window the right panel should occupy.
   */
  async seedSplit(rightPct: number) {
    await this.page.addInitScript(
      (value) => {
        try {
          localStorage.setItem('react-resizable-panels:app-shell-right-panel', value);
        } catch {
          // about:blank has an opaque origin — the write lands on the real navigation.
        }
      },
      JSON.stringify({
        'main-content,right-panel': { expandToSizes: {}, layout: [100 - rightPct, rightPct] },
      })
    );
  }

  /** Width of the tab strip's scroll box, or 0 when the panel is collapsed or absent. */
  async tabStripWidth(): Promise<number> {
    return this.page.evaluate(() => {
      const tablist = document.querySelector('[data-slot="right-panel-header"] [role="tablist"]');
      return tablist?.parentElement?.clientWidth ?? 0;
    });
  }

  /**
   * Make sure the tab strip is open and measurable, opening the panel if it is not.
   *
   * Idempotent and safe to call in a loop, which it has to be: the panel restores
   * its per-agent layout as soon as the agent query settles, and on a cold cache
   * that can land a second after the panel was opened and close it again. It also
   * only clicks the toggle when the toggle itself says the panel is closed, so a
   * call that arrives while the panel is already open can never toggle it shut.
   */
  async ensureTabStripOpen() {
    await this.header.getByRole('tablist').waitFor({ state: 'visible', timeout: 15_000 });
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await this.tabStripWidth()) > 0) return;
      await this.open();
      await this.page.waitForTimeout(200);
    }
    throw new Error('the right panel never opened wide enough to measure its tab strip');
  }

  /**
   * Measure the tab strip: how much is out of view, and where the selected tab sits.
   *
   * @returns The selected tab's contribution id, the scroll box's width (0 while
   *   the panel is collapsed), the scroll deficit, the scroll offset, how far the
   *   selected tab falls outside the scroll box on each side (0 when it is fully
   *   visible), and whether each edge fade is drawn.
   */
  async measureTabStrip(): Promise<{
    selectedId: string;
    clientWidth: number;
    deficit: number;
    scrollLeft: number;
    selectedPastStart: number;
    selectedPastEnd: number;
    fadeStart: boolean;
    fadeEnd: boolean;
  }> {
    return this.tabScroller.evaluate((el) => {
      const selected = el.querySelector('[role="tab"][aria-selected="true"]');
      if (!selected) throw new Error('the tab strip has no selected tab');
      const box = el.getBoundingClientRect();
      const rect = selected.getBoundingClientRect();
      return {
        selectedId: selected.id.replace('right-panel-tab-', ''),
        clientWidth: el.clientWidth,
        deficit: el.scrollWidth - el.clientWidth,
        scrollLeft: el.scrollLeft,
        selectedPastStart: Math.max(0, box.left - rect.left),
        selectedPastEnd: Math.max(0, rect.right - box.right),
        // Read in the same evaluate as the geometry on purpose: comparing a fade
        // seen at one moment against a scroll position read at another is a race
        // the test would lose about once in eight runs.
        fadeStart: !!document.querySelector('[data-testid="right-panel-tabs-fade-start"]'),
        fadeEnd: !!document.querySelector('[data-testid="right-panel-tabs-fade-end"]'),
      };
    });
  }

  /**
   * Select a tab the way the app's own code does, without focusing it.
   *
   * A real click focuses the tab, and the browser scrolls what it focuses — which
   * hides the whole class of bug this exercises. A synthetic `click()` fires the
   * handler without moving focus, which is exactly what a server `ui_command` or a
   * restored layout does to the strip.
   *
   * @param contributionId - Id of the contribution whose tab should be selected.
   */
  async activateTabWithoutFocus(contributionId: string) {
    await this.page.evaluate((id) => {
      document.getElementById(`right-panel-tab-${id}`)?.click();
    }, contributionId);
  }

  /** Navigate to a route and wait for the shell. SSE means no networkidle — use DOM-ready. */
  async goto(path = '/') {
    await this.page.goto(path, { waitUntil: 'domcontentloaded' });
    await this.basePage.waitForAppReady();
  }

  /**
   * Open an agent's profile in the panel, on one of its pushed pages.
   *
   * Fleet-level session surfaces — the runtime marks, the per-row context gauge
   * — used to be reachable from the sidebar and then from the Agent Hub's
   * Sessions tab. Both are gone: the rows live on the Profile's Sessions page
   * now (spec `profile-unification` §1.5), and this is the address that opens
   * it. The deep link rather than a click on the row, because that address is
   * itself a supported entry point and is covered by `dialog-deep-link.spec`;
   * a caller wanting the click path drives the row's `data-profile-row` instead.
   *
   * @param pageId - The `ProfilePageId` to land on (e.g. `'sessions'`).
   * @param agentDir - The agent's directory; it is both the session's `dir` and
   *   the profile the link names, so the panel and the page agree on whose.
   */
  async openProfilePage(pageId: string, agentDir: string) {
    const dir = encodeURIComponent(agentDir);
    await this.page.goto(
      `/session?panel=profile&profilePage=${pageId}&agentPath=${dir}&dir=${dir}`,
      { waitUntil: 'domcontentloaded' }
    );
    await this.basePage.waitForAppReady();
    await this.page.locator('[data-slot="profile"][data-home="docked"]').waitFor({
      state: 'visible',
      timeout: 15_000,
    });
    await this.page
      .locator('[data-slot="profile-page-title"]')
      .waitFor({ state: 'visible', timeout: 15_000 });
  }

  /** Open the panel if it is currently closed (idempotent). */
  async open() {
    const label = await this.toggle.getAttribute('aria-label');
    if (label?.startsWith('Open')) {
      await this.toggle.click();
    }
  }
}
