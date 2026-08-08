import type { Page, Locator } from '@playwright/test';

/**
 * Page Object for the web cockpit's left sidebar — the DashboardSidebar agent
 * roster.
 *
 * The registry-backed session-sidebar drill-in and its tab strip (Overview /
 * Sessions / Schedules / Connections) were retired: the roster now persists on
 * every route and per-session context lives in the right-panel inspector. So
 * this POM models only the roster's session affordances — the old `tabList` /
 * `switchTab` / `getActiveTab` helpers were removed with the strip they drove.
 */
export class DashboardSidebarPage {
  readonly page: Page;

  /**
   * The roster's per-agent "New session" action. It lives inside the active
   * agent's expanded row (the retired drill-in header's always-present button is
   * gone), so a caller may need the active agent row expanded — with at least
   * one existing session — before it is visible.
   */
  readonly newSessionButton: Locator;

  /**
   * The roster's "+" add-agent trigger (opens New agent… / Bring in a
   * project / Browse Marketplace / New group…). Scoped to the shadcn
   * `sidebar-group-action` slot so it never collides with
   * `AgentOnboardingCard`'s plain "Add agent" button, which matches the same
   * accessible name at small fleet sizes.
   */
  readonly addAgentButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.newSessionButton = page.getByRole('button', { name: /new session/i });
    // Scoped by `data-sidebar`, not `data-slot`. The trigger is a Radix
    // `PopoverTrigger asChild`, and Radix's own `data-slot="popover-trigger"`
    // wins over the one `SidebarGroupAction` sets — so the `data-slot` form of
    // this selector matched nothing. `data-sidebar` is ours alone, and it keeps
    // the scoping this locator exists for.
    this.addAgentButton = page.locator(
      'button[data-sidebar="group-action"][aria-label="Add agent"]'
    );
  }

  /** Start a new session via the roster's per-agent "New session" action. */
  async createNewSession() {
    await this.newSessionButton.first().click();
  }

  /** One agent row in the roster, matched by its rendered display name. */
  agentRow(displayName: string): Locator {
    return this.page.locator('[data-slot="agent-list-item"]').filter({ hasText: displayName });
  }

  /** A group's header toggle button — shows the group name, expands/collapses. */
  groupHeader(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true });
  }

  /** The `SidebarGroup` wrapper (header + member rows) for one user-defined group. */
  groupContainer(name: string): Locator {
    return this.page.locator('[data-slot="sidebar-group"]').filter({ has: this.groupHeader(name) });
  }

  /**
   * Create a new top-level group via the "+" menu's inline create flow (Enter
   * commits; the input never blurs during this sequence, which would cancel
   * it instead).
   */
  async createGroup(name: string) {
    await this.addAgentButton.click();
    await this.page.getByRole('button', { name: 'New group…' }).click();
    const input = this.page.getByRole('textbox', { name: 'New group name' });
    await input.fill(name);
    await input.press('Enter');
    await this.groupHeader(name).waitFor({ state: 'visible' });
  }

  /**
   * Assert a drag endpoint's centre is on screen, naming it if it is not.
   *
   * `page.mouse` dispatches at viewport coordinates, so a press aimed below the
   * fold lands on no element at all: dnd-kit's `PointerSensor` never arms and
   * the drop silently does not happen. Playwright reports none of that — the
   * gesture "succeeds" and only the assertion afterwards fails, pointing at the
   * DOM rather than at the pointer. So the geometry is checked up front and
   * fails with the measurement (DOR-1035).
   *
   * @param name - Which endpoint this is, for the error message.
   * @param box - The endpoint's bounding box.
   */
  private assertOnScreen(name: string, box: { y: number; height: number }) {
    const viewport = this.page.viewportSize();
    if (!viewport) return;
    const centerY = box.y + box.height / 2;
    if (centerY >= 0 && centerY <= viewport.height) return;
    throw new Error(
      `Drag ${name} is off screen (centre y=${Math.round(centerY)}, viewport height ${viewport.height}). ` +
        'A pointer drag needs both endpoints visible at once, and the sidebar is now taller than that allows.'
    );
  }

  /**
   * Drag an agent row onto a group header via real pointer events. dnd-kit's
   * `PointerSensor` requires an 8px move past the start point before a drag
   * arms, so a single jump from start to end is not enough — step through
   * several intermediate points so the sensor sees the motion.
   *
   * The scroll order is load-bearing. The sidebar is a scroll container, and
   * once an install carries a few rows it is taller than the viewport — so
   * bringing one endpoint into view can push the other back out. The SOURCE is
   * scrolled last because the press that arms the drag happens there. Scrolling
   * it first (as this did until DOR-1035) left the agent row at y=763 in a
   * 720px-tall viewport once the identity work grew the sidebar, and every drop
   * silently did nothing.
   */
  async dragAgentIntoGroup(agentDisplayName: string, groupName: string) {
    const source = this.agentRow(agentDisplayName);
    const target = this.groupHeader(groupName);
    await target.scrollIntoViewIfNeeded();
    await source.scrollIntoViewIfNeeded();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) {
      throw new Error('Drag source or target is not visible');
    }
    this.assertOnScreen('source', sourceBox);
    this.assertOnScreen('target', targetBox);

    const startX = sourceBox.x + sourceBox.width / 2;
    const startY = sourceBox.y + sourceBox.height / 2;
    const endX = targetBox.x + targetBox.width / 2;
    const endY = targetBox.y + targetBox.height / 2;

    const STEPS = 8;
    await this.page.mouse.move(startX, startY);
    await this.page.mouse.down();
    for (let i = 1; i <= STEPS; i++) {
      await this.page.mouse.move(
        startX + ((endX - startX) * i) / STEPS,
        startY + ((endY - startY) * i) / STEPS
      );
    }
    await this.page.mouse.move(endX, endY);
    await this.page.mouse.up();
  }
}
