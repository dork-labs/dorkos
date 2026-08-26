import type { Locator, Page } from '@playwright/test';

/**
 * The four tabs of the home surface, in bar order, with the address each one
 * owns.
 *
 * The labels and the paths disagree on purpose in one place: "Schedules"
 * addresses `/tasks`. A URL is a contract, so the page was renamed and the route
 * was not (`layers/shared/config/home-tabs.ts`). Duplicated here rather than
 * imported — this package does not build against the client, and a test that
 * imports the table it is checking asserts nothing about it.
 */
export const HOME_TABS = [
  { label: 'Home', path: '/' },
  { label: 'Activity', path: '/activity' },
  { label: 'Schedules', path: '/tasks' },
  { label: 'Workspaces', path: '/workspaces' },
] as const;

/**
 * The four sidebar destinations, in the order the footer strip draws them.
 *
 * The count is the point. Seven sidebar entries became four when Activity,
 * Schedules and Workspaces moved into the home tab bar, and a fifth appearing
 * here is what the spec is watching for. They live in the footer strip now
 * (spec `sidebar-now-today-library` BC-47) — the header nav that used to hold
 * them, and the Search row beside it, were retired with it.
 */
export const SIDEBAR_NAV_LABELS = ['Home', 'Team', 'Marketplace', 'Connections'] as const;

/**
 * Page Object for the home surface — the tab strip over `/`, `/activity`,
 * `/tasks` and `/workspaces`, the shrunken sidebar beside it, and the "Jump back
 * in" panel that floats over the home composer.
 *
 * The strip rides INSIDE the one header bar since phase H1 — it used to be a
 * second row under it. The testids did not move with it (`home-tabs` is a tour
 * anchor), so every locator here still points at the same elements; what changed
 * is the height they are drawn at, which is the bar's 36px rather than a
 * standalone row's 44.
 *
 * Home IS the #team room now (spec `team-room-home` D3.2), so the composer here
 * is that room's, and everything below the tab bar is the ordinary room
 * surface.
 *
 * The tabs are links, not ARIA tabs (`bar-tab-strip.tsx` explains why), so they are
 * located by role `link` and their visible state is read from `data-active`
 * rather than from `aria-current` — `Link` computes the latter itself, so
 * asserting on it would test TanStack Router instead of this repo's resolver.
 */
export class HomeSurfacePage {
  readonly page: Page;

  /** The tab strip itself. Its testid is a tour anchor (`TOUR_ANCHORS.homeTabs`). */
  readonly tabBar: Locator;

  /** Every tab, in DOM order. */
  readonly tabs: Locator;

  /**
   * The scroll cue over the bar's left edge, drawn only while labels are hidden
   * behind it (DOR-1180). Absent from the DOM when there is nothing to
   * advertise, so `toHaveCount(0)` is the honest "no cue" assertion.
   */
  readonly tabsFadeStart: Locator;

  /** The same over the right edge — what a phone sees on a cold load. */
  readonly tabsFadeEnd: Locator;

  /** The sidebar's top-level nav block: four destinations plus Search. */
  readonly sidebarNav: Locator;

  /**
   * The home composer — the #team room's box, and the element the recents panel
   * floats over. Its testid is a tour anchor (`TOUR_ANCHORS.homeComposer`).
   */
  readonly composer: Locator;

  /**
   * The composer's text field. `role="combobox"` because it drives a palette;
   * that role is also how the popover tells the field apart from the buttons
   * beside it, so it is the honest selector here.
   */
  readonly composerField: Locator;

  /** The "Jump back in" panel, when it is up. */
  readonly jumpBackIn: Locator;

  /** Its rows. */
  readonly jumpBackInRows: Locator;

  constructor(page: Page) {
    this.page = page;
    this.tabBar = page.getByTestId('home-tabs');
    this.tabs = this.tabBar.getByRole('link');
    // Siblings of the bar, not children: they are pinned to what the strip
    // SHOWS, and inside the scroller they would scroll away with its content.
    this.tabsFadeStart = page.getByTestId('home-tabs-fade-start');
    this.tabsFadeEnd = page.getByTestId('home-tabs-fade-end');
    this.sidebarNav = page.getByTestId('sidebar-footer-strip-row');
    this.composer = page.getByTestId('home-composer');
    this.composerField = this.composer.getByRole('combobox');
    this.jumpBackIn = page.getByRole('listbox', { name: 'Jump back in' });
    this.jumpBackInRows = this.jumpBackIn.getByRole('option');
  }

  /** One tab, by the word printed on it. */
  tab(label: string): Locator {
    return this.tabBar.getByRole('link', { name: label, exact: true });
  }

  /** The tab currently drawn as active — `data-active`, the resolver's output. */
  get activeTab(): Locator {
    return this.tabBar.locator('a[data-active]');
  }

  /**
   * The destination buttons in the sidebar's footer strip.
   *
   * Located by `data-sidebar-destination`, which `SidebarFooterStrip` stamps
   * from the loop over its destination table — NOT by the four names. A
   * name-matching locator cannot see a fifth destination at all: it filters the
   * newcomer out before `toHaveCount` runs, so the count that exists to catch a
   * fifth would pass with one present. The strip's other two buttons (the `⋯`
   * fold and Ask DorkBot) carry no such attribute and are excluded by structure.
   */
  get sidebarNavButtons(): Locator {
    return this.sidebarNav.locator('[data-sidebar-destination]');
  }

  /**
   * Open the panel by pressing on the empty box, the way a person does.
   *
   * A click, not a programmatic focus: a composer that already holds the caret
   * dispatches no focus event at all, so `pointerdown` is the only signal the
   * gesture produces (`use-jump-back-in-popover.ts`).
   */
  async openJumpBackIn(): Promise<void> {
    await this.composerField.click();
    await this.jumpBackIn.waitFor({ state: 'visible' });
  }

  /**
   * One row, found by its tooltip rather than its text.
   *
   * A channel row draws its name in two halves — the spoken `#slug` in an
   * `sr-only` span, the visible `slug` beside the `#` glyph (`RoomTitle`) — so a
   * text query has to know which half it is asking for. Every row carries the
   * whole thing in `title`, which is one node and one answer.
   *
   * @param needle - Text that identifies the caller's own seeded row.
   */
  rowFor(needle: string): Locator {
    return this.jumpBackIn.locator(`[role="option"][title*="${needle}"]`);
  }

  /** The row Enter would open. */
  get highlightedRow(): Locator {
    return this.jumpBackIn.locator('[role="option"][data-selected="true"]');
  }

  /**
   * Walk the highlight down until it lands on a row whose text contains
   * `needle`, then leave it there.
   *
   * Bounded by the row count, and the list wraps, so this either finds the row
   * or throws having visited all of them. Necessary rather than fussy: the whole
   * suite shares one server, and this list is unfiltered — pressing Enter on
   * whatever happens to be first opens a neighbouring spec's thread (GOTCHAS,
   * "Assertions this suite cannot make").
   *
   * @param needle - Text that identifies the caller's own seeded row.
   */
  async highlightRowContaining(needle: string): Promise<void> {
    const rowCount = await this.jumpBackInRows.count();
    for (let step = 0; step < rowCount; step++) {
      const text = (await this.highlightedRow.textContent()) ?? '';
      if (text.includes(needle)) return;
      await this.composerField.press('ArrowDown');
    }
    throw new Error(`No "Jump back in" row contains ${JSON.stringify(needle)} within ${rowCount}`);
  }
}
