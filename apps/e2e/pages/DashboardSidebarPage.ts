import { expect, type Page, type Locator } from '@playwright/test';
import { NewMenuPage } from './NewMenuPage';

/** dnd-kit's `PointerSensor` arms only after the pointer travels this far. */
const DND_ACTIVATION_PX = 8;
/** Gap between the two box reads that have to agree before a row counts as still. */
const SETTLE_POLL_MS = 150;
/** How many times to re-read before giving up on the sidebar ever settling. */
const SETTLE_ATTEMPTS = 15;
/** How many times a held drag re-aims at a target that moved under it. */
const REAIM_ATTEMPTS = 12;
/**
 * How many `Tab` presses may pass before the sidebar has to have been reached.
 *
 * A ceiling, not a count. The panel is a handful of composite Tab stops and the
 * chrome above it a handful more, so the real number is small — but writing the
 * real number down would make this fail on the day a button is added anywhere
 * before the roster, which is not what it is asking about.
 */
const TAB_PRESSES = 40;
/** How many arrow presses may pass before a row inside a section has to be reached. */
const ARROW_PRESSES = 20;
/** How many arrow presses a lifted row gets to find the section it is aimed at. */
const KEYBOARD_DRAG_PRESSES = 15;

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
   * The one create surface (BC-45).
   *
   * The Agents section's `+` used to open its own popover with New agent… /
   * Bring in a project / New group… in it. That popover is gone: the `+` is a
   * deep link into the New menu now, so anything this page object used to make
   * from it, it makes from here.
   */
  readonly newMenu: NewMenuPage;

  constructor(page: Page) {
    this.page = page;
    this.newSessionButton = page.getByRole('button', { name: /new session/i });
    this.newMenu = new NewMenuPage(page);
  }

  /** Start a new session via the roster's per-agent "New session" action. */
  async createNewSession() {
    await this.newSessionButton.first().click();
  }

  /**
   * The bottom sheet a long press opens on a touch screen (P4.2).
   *
   * The sidebar's THIRD menu renderer, beside the right-click menu and the
   * "⋮" — all three walk one node list, so anything a spec asserts about the
   * items in here is an assertion about that list.
   */
  get longPressSheet(): Locator {
    return this.page.getByTestId('sidebar-menu-sheet');
  }

  /**
   * Press and hold a real finger on something, then lift it.
   *
   * **A real touch, dispatched through CDP.** Playwright's `touchscreen` can
   * only tap, and `page.mouse` is a different input entirely: a mouse press is
   * never handed to the compositor, which is exactly what the scroll case turns
   * on. `RoomsPage.longPress` drives the room composer's gesture with a mouse
   * for historical reasons; a spec about a TOUCH affordance should use this.
   *
   * @param target - What to press.
   * @param options.holdMs - How long the finger stays down. Below
   *   `TIMING.LONG_PRESS_MS` (500) this is a tap.
   * @param options.driftPx - How far it travels upward mid-hold — what a scroll
   *   that began on this row looks like to the gesture.
   */
  async longPress(
    target: Locator,
    options: { holdMs?: number; driftPx?: number } = {}
  ): Promise<void> {
    const { holdMs = 800, driftPx = 0 } = options;
    const box = await target.boundingBox();
    if (box === null) throw new Error('Cannot press an element with no box on screen');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await this.page.context().newCDPSession(this.page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    if (driftPx > 0) {
      // A scroll is a series of moves, not one jump — and the first few are
      // what the drift guard sees before the compositor takes the gesture.
      for (const step of [0.25, 0.5, 0.75, 1]) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y - driftPx * step }],
        });
      }
    }
    await this.page.waitForTimeout(holdMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  /** The sidebar panel itself — the surface the density is measured against. */
  get panel(): Locator {
    return this.page.locator('[data-slot="sidebar-inner"]');
  }

  /** One agent row in the roster, matched by its rendered display name. */
  agentRow(displayName: string): Locator {
    return this.page.locator('[data-slot="agent-list-item"]').filter({ hasText: displayName });
  }

  /**
   * Any sidebar row as the shared `SidebarRow` primitive stamps them.
   *
   * **Deliberately caller-DEPENDENT**, and only useful alongside
   * {@link rowControls}: this counts rows built from the primitive, so on its
   * own it can only ever say "the rows that adopted it are fine". Comparing the
   * two counts is what catches a section that opted out.
   */
  get rows(): Locator {
    return this.page.locator('[data-sidebar-row]');
  }

  /**
   * Every row control the sidebar's lists actually render, however they were
   * built.
   *
   * Asks the DOM what a row IS — an interactive control sitting in a sidebar
   * menu item — rather than asking which component built it, so a hand-rolled
   * row that skipped the primitive still shows up here and still has to meet
   * the density bar.
   *
   * The exclusions are structural, not convenient. A row's two SATELLITES — the
   * "⋮" in its right gutter and the face that opens a profile over its glyph —
   * sit beside the row rather than being rows, and an `aria-expanded` button in
   * a list is a reveal affordance ("+ 2 automated") rather than a destination.
   */
  get rowControls(): Locator {
    // Scoped to the scroll BODY, not the whole panel. The nav header's
    // destinations and the footer strip are chrome — shadcn `SidebarMenuButton`s
    // that answer "which part of DorkOS", not "which conversation" — and the
    // redesign rebuilds them in its own phase (BC-43, BC-47). The roster is
    // what `SidebarRow` owns, and the roster is what this measures.
    return this.page.locator(
      '[data-slot="sidebar-content"] [data-slot="sidebar-menu-item"] ' +
        'button:not([data-sidebar-actions]):not([data-sidebar-glyph-action]):not([aria-expanded])'
    );
  }

  /**
   * The row controls that did NOT come from the shared primitive — the
   * regression the density bar exists to catch, named rather than counted so a
   * failure says which section opted out.
   */
  async optedOutRowControls(): Promise<string[]> {
    return this.rowControls.evaluateAll((elements) =>
      elements
        .filter((el) => !el.hasAttribute('data-sidebar-row'))
        .map(
          (el) => `${el.className.slice(0, 40)} :: ${(el.textContent ?? '').trim().slice(0, 40)}`
        )
    );
  }

  /**
   * One zone's `<section>`, by the id the model gave it.
   *
   * @param id - `now`, `getting-started`, `today` or `library`.
   */
  zone(id: 'now' | 'getting-started' | 'today' | 'library'): Locator {
    return this.page.locator(`[data-sidebar-zone="${id}"]`);
  }

  /** Every row inside Today, in the order it is drawn. */
  get todayRows(): Locator {
    return this.zone('today').locator('[data-sidebar-row]');
  }

  /**
   * Today's anchor — the conversation the operator has open, which BC-21 pins
   * to the top of the zone.
   *
   * Matched on `aria-current="page"` inside Today rather than on "the first
   * row", so the assertion is about the row the panel CLAIMS is open rather
   * than about a position that would be true of whatever happened to sort
   * first.
   */
  get todayAnchor(): Locator {
    return this.zone('today').locator('[data-sidebar-row][aria-current="page"]');
  }

  /**
   * One Library section's fold toggle, by the label on its header.
   *
   * @param label - `Channels`, `Direct messages`, `Agents` or `Pins`.
   */
  librarySectionToggle(label: string): Locator {
    return this.zone('library')
      .locator('h3')
      .filter({ hasText: label })
      .locator('[data-sidebar-section-toggle]');
  }

  /**
   * A row anywhere in the sidebar whose text contains `text`.
   *
   * @param text - Part of the row's visible sentence.
   */
  rowWithText(text: string): Locator {
    return this.rows.filter({ hasText: text });
  }

  /** A group's header toggle button — shows the group name, expands/collapses. */
  groupHeader(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true });
  }

  /**
   * The wrapper (header + member rows) for one user-defined group.
   *
   * **Scoped by `data-sidebar-section`, not by `data-slot="sidebar-group"`.**
   * The section stamps its own model id and `group:` prefixes exactly the one
   * wrapper meant here. It mattered more when a section rendered INSIDE Agents
   * and a `sidebar-group` filter matched the ancestor as well as the descendant
   * — sections are peers now (D3) — and it is still the precise handle.
   */
  groupContainer(name: string): Locator {
    return this.page
      .locator('[data-sidebar-section^="group:"]')
      .filter({ has: this.groupHeader(name) });
  }

  /**
   * How far a row's own content sits from the panel's left edge, in CSS pixels.
   *
   * Measured from the row BUTTON's content box — its border box minus its own
   * left padding — because the inset is what a reader sees, not where the
   * clickable area starts. The redesign pays it in exactly two places (the
   * panel's 8px and the row's 8px) and nowhere else; before it, three levels
   * each added their own and the total was 30px.
   *
   * @param row - The row to measure.
   */
  async rowInset(row: Locator): Promise<number> {
    const panelBox = await this.panel.boundingBox();
    if (!panelBox) throw new Error('the sidebar panel is not visible');
    return row.evaluate((element, panelLeft) => {
      const box = element.getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(element).paddingLeft);
      return Math.round(box.left + padding - panelLeft);
    }, panelBox.x);
  }

  /**
   * Create a new section via the "+" menu's inline create flow (Enter commits;
   * the input never blurs during this sequence, which would cancel it instead).
   */
  async createGroup(name: string) {
    // Two steps, and they are the product's: the New menu's "Section" is a
    // submenu — by hand, or from rules — and "Empty section" is the by-hand
    // entry that mounts the inline editor at the top of Library (BC-45, D3).
    await this.newMenu.chooseGroupSubmenu('new-group-empty');
    const input = this.page.getByRole('textbox', { name: 'New section name' });
    await input.fill(name);
    await input.press('Enter');
    await this.groupHeader(name).waitFor({ state: 'visible' });
  }

  /**
   * Read a row's box only once it has stopped moving.
   *
   * `waitFor({ state: 'visible' })` returns while a row is still animating —
   * Playwright counts `opacity: 0` as visible, and a new group enters on a
   * spring that also translates it, while the create-input below it unmounts on
   * an exit transition. Measuring in that window aims the press at where the row
   * WAS. Two consecutive reads that agree mean the layout has settled (DOR-1035).
   *
   * @param locator - The row to measure.
   * @param name - Which endpoint this is, for the error message.
   */
  private async stableBox(locator: Locator, name: string) {
    let previous = await locator.boundingBox();
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      await this.page.waitForTimeout(SETTLE_POLL_MS);
      const current = await locator.boundingBox();
      if (!current) throw new Error(`Drag ${name} is not visible`);
      if (previous && current.x === previous.x && current.y === previous.y) return current;
      previous = current;
    }
    throw new Error(`Drag ${name} never stopped moving — the sidebar is still laying out.`);
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
   *
   * Both endpoints are measured only once they stop moving, and the release
   * waits for the sidebar to say what the drag is over. Every way this gesture
   * has failed — a press below the fold, a press aimed at a row mid-animation,
   * a release that beat dnd-kit's collision pass — looked identical afterwards:
   * a group that stayed empty, with the spec blaming the DOM. Each now fails
   * here, saying which one it was.
   */
  async dragAgentIntoGroup(agentDisplayName: string, groupName: string) {
    await this.dragRowIntoGroup(this.agentRow(agentDisplayName), groupName);
  }

  /**
   * Drag ANY Library row onto a section header — the same gesture, without an
   * opinion about what is being dragged.
   *
   * A section holds channels and conversations as well as agents (DOR-581), and
   * D3 is what finally says so on screen, so the page object stops naming one
   * kind. {@link dragAgentIntoGroup} is the agent-shaped caller.
   *
   * @param source - The row to pick up.
   * @param groupName - The section header to drop it on.
   */
  async dragRowIntoGroup(source: Locator, groupName: string) {
    const target = this.groupHeader(groupName);
    await target.scrollIntoViewIfNeeded();
    await source.scrollIntoViewIfNeeded();
    const sourceBox = await this.stableBox(source, 'source');
    const targetBox = await this.stableBox(target, 'target');
    this.assertOnScreen('source', sourceBox);
    this.assertOnScreen('target', targetBox);

    const startX = sourceBox.x + sourceBox.width / 2;
    const startY = sourceBox.y + sourceBox.height / 2;
    const endX = targetBox.x + targetBox.width / 2;
    const endY = targetBox.y + targetBox.height / 2;

    const STEPS = 8;
    await this.page.mouse.move(startX, startY);
    await this.page.mouse.down();
    // One deliberate step past the activation distance before heading for the
    // target, so the sensor arms on a move that cannot be shorter than 8px
    // however close the two rows happen to sit.
    await this.page.mouse.move(startX, startY + DND_ACTIVATION_PX * 2);
    for (let i = 1; i <= STEPS; i++) {
      await this.page.mouse.move(
        startX + ((endX - startX) * i) / STEPS,
        startY + ((endY - startY) * i) / STEPS
      );
    }
    await this.page.mouse.move(endX, endY);

    // Re-aim at the group until the sidebar agrees the drag is over it, then
    // release.
    //
    // Two things make a single measured point unreliable, and both did on CI.
    // dnd-kit resolves `over` on its own collision pass rather than on the move
    // event, so a release can beat it and be classified as a drop on nothing.
    // And the Channels and Direct-message sections arrive from their own query,
    // so one can mount mid-gesture and move everything below it — CI reported
    // "Over Channels." for a point measured on the group header before the
    // press. Re-reading the target's CURRENT box and moving again converges on
    // the row wherever it has gone, instead of trusting one stale guess.
    const liveRegion = this.page.locator('[id^="DndLiveRegion"]');
    const overGroup = `Over ${groupName}`;
    for (let attempt = 0; attempt < REAIM_ATTEMPTS; attempt++) {
      if ((await liveRegion.textContent())?.includes(overGroup)) break;
      const box = await target.boundingBox();
      if (box) {
        // Two moves a pixel apart: dnd-kit recomputes on pointer movement, and
        // re-sending an identical coordinate is not movement.
        await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 1);
        await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      }
      await this.page.waitForTimeout(SETTLE_POLL_MS);
    }
    await expect(liveRegion, `the drag never came to rest over ${groupName}`).toContainText(
      overGroup
    );
    await this.page.mouse.up();
  }

  /** dnd-kit's live region — what a screen reader is told about a drag in progress. */
  get dndLiveRegion(): Locator {
    return this.page.locator('[id^="DndLiveRegion"]');
  }

  /**
   * Walk `Tab` from wherever focus is until it lands on a section's header.
   *
   * **Presses, not `.focus()`.** The question these helpers exist to ask is
   * whether a keyboard can get anywhere near a sidebar row at all, and a
   * programmatic focus answers it by assuming it (DOR-1746). The panel is a
   * roving-tabindex list — one Tab stop per section — so the header is the stop
   * Tab is entitled to reach.
   *
   * @param label - The section header to walk to, e.g. `Agents`.
   */
  async tabToSectionHeader(label: string) {
    const toggle = this.librarySectionToggle(label);
    await expect(toggle).toBeVisible();
    for (let press = 0; press < TAB_PRESSES; press++) {
      if (await toggle.evaluate((node) => node === document.activeElement)) return;
      await this.page.keyboard.press('Tab');
    }
    await expect(toggle, `Tab never reached the ${label} header`).toBeFocused();
  }

  /**
   * Arrow down from wherever focus is inside a section until it lands on `row`.
   *
   * The count is not fixed because a section's stops are its header, its `+` and
   * then its rows, and how many rows sit above the one wanted depends on what
   * the run seeded.
   *
   * @param row - The row to arrive on.
   */
  async arrowToRow(row: Locator) {
    for (let press = 0; press < ARROW_PRESSES; press++) {
      if (await row.evaluate((node) => node === document.activeElement)) return;
      await this.page.keyboard.press('ArrowDown');
    }
    await expect(row, 'arrowing down the section never reached the row').toBeFocused();
  }

  /**
   * Pick a row up, walk it to a section, and put it down — keyboard only.
   *
   * The keyboard equivalent of {@link dragRowIntoGroup}, and it converges the
   * same way: dnd-kit resolves what a drag is OVER on its own collision pass, so
   * the loop presses an arrow and re-reads the live region rather than assuming
   * a fixed number of steps lands on the target. The live region is the right
   * place to read what a drag is over, and the wrong place to read whether one
   * STARTED — see the pick-up below.
   *
   * @param row - The row to lift. Must already have focus.
   * @param groupName - The section header to drop it on.
   */
  async keyboardDragRowIntoGroup(row: Locator, groupName: string) {
    await expect(row, 'the row has to hold focus before a keyboard drag can lift it').toBeFocused();

    // Which way the section lies, read off the page rather than assumed: a
    // hand-made section sorts wherever the panel puts it. Measured BEFORE the
    // lift, while both boxes are still where a reader last saw them.
    const rowBox = await row.boundingBox();
    const targetBox = await this.groupHeader(groupName).boundingBox();
    const key = (targetBox?.y ?? 0) < (rowBox?.y ?? 0) ? 'ArrowUp' : 'ArrowDown';

    // Space lifts. Enter deliberately does not — it opens what the row points
    // at, which is a row's first job (DOR-1746).
    await this.page.keyboard.press('Space');
    // **The drag's STATE, not its announcement.** The live region is a running
    // commentary: "Picked up …" is replaced by "Over …" the instant dnd-kit's
    // first collision pass lands, which here is the same tick. Waiting for a
    // string that has already scrolled past is how this read as "picked nothing
    // up" on a drag that had in fact started.
    await expect(
      this.page.locator('[data-sidebar-dragging]'),
      'Space on the focused row picked nothing up'
    ).toHaveCount(1);

    const overGroup = `Over ${groupName}`;
    for (let press = 0; press < KEYBOARD_DRAG_PRESSES; press++) {
      if ((await this.dndLiveRegion.textContent())?.includes(overGroup)) break;
      await this.page.keyboard.press(key);
    }
    await expect(
      this.dndLiveRegion,
      `${KEYBOARD_DRAG_PRESSES} presses of ${key} never brought the row over ${groupName}`
    ).toContainText(overGroup);

    // Space again drops it, and nothing is left in the air.
    await this.page.keyboard.press('Space');
    await expect(
      this.page.locator('[data-sidebar-dragging]'),
      'the row never came back down'
    ).toHaveCount(0);
  }
}
