import { expect, type Locator, type Page } from '@playwright/test';
import { openRadixSubmenu } from '../radix-menu';

/**
 * The sidebar's one create surface (spec `sidebar-now-today-library` BC-45).
 *
 * Making anything used to be a one-step press on whichever `+` was nearest.
 * It is two steps now, and deliberately: the `+` on a section no longer runs a
 * handler of its own — it **deep-links** into this menu with the matching item
 * already picked out. So every page object that used to click a `+` and wait
 * for a dialog now goes through here.
 *
 * **Items are addressed by id, never by label.** `data-menu-item-id` is stamped
 * by the shared menu renderer (`shared/ui/sidebar-menu-node`) precisely so a
 * test and a deep link can name a row without either breaking the next time the
 * wording changes. The ids are the five from `model/create-flow-store.ts`.
 *
 * @module e2e/pages/NewMenuPage
 */

/** The New menu's items, matching `NEW_MENU_ITEM_IDS` in the client. */
export type NewMenuItemId =
  'new-session' | 'new-channel' | 'new-message' | 'new-agent' | 'new-group';

/** Driving the one create surface. */
export class NewMenuPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** The "New" button in the sidebar's header block — the door that always exists. */
  get trigger(): Locator {
    return this.page.getByTestId('sidebar-new-button');
  }

  /**
   * A section header's `+`, by its accessible name.
   *
   * Scoped to the shadcn `sidebar-group-action` slot so it can only ever match
   * a section header's own `+`, never some other button in the panel wearing
   * the same accessible name. `data-sidebar` rather than `data-slot`: that is
   * ours alone.
   *
   * @param label - The `+`'s accessible name, e.g. `'New channel'`.
   */
  sectionPlus(label: string): Locator {
    return this.page.locator(`button[data-sidebar="group-action"][aria-label="${label}"]`);
  }

  /**
   * One item in the open menu.
   *
   * @param id - Its stable id.
   */
  item(id: NewMenuItemId | string): Locator {
    return this.page.locator(`[data-menu-item-id="${id}"]`);
  }

  /**
   * Open the menu from the New button and take one item.
   *
   * @param id - The item to run.
   */
  async choose(id: NewMenuItemId): Promise<void> {
    await this.trigger.click();
    await this.item(id).click();
  }

  /**
   * Open the menu the way a section's `+` does, and take the item that `+`
   * stands for.
   *
   * This is the path worth exercising rather than the New button: it is the
   * only thing that proves the `+` still leads somewhere after BC-45 took its
   * handler away.
   *
   * @param plusLabel - The `+`'s accessible name.
   * @param id - The item that `+` deep-links to.
   */
  async chooseFromSectionPlus(plusLabel: string, id: NewMenuItemId): Promise<void> {
    await this.sectionPlus(plusLabel).first().click();
    await this.item(id).click();
  }

  /**
   * Take "Section" and end up at the by-hand entry — whichever of its two
   * shapes this install is currently drawing.
   *
   * **"Section" is a submenu only for a fleet big enough for rules** (DOR-1800).
   * `buildNewMenuNodes` renders `new-group` as a submenu — Empty section, the
   * presets, Custom rules — above the smart-preset gate, and as a plain ACTION
   * below it, where the action IS the by-hand entry that the submenu's
   * `new-group-empty` would have run. The gate is `offersGroupAffordances`:
   * eight agents, or two runtimes.
   *
   * And which side of it a run is on is decided by data that arrives after the
   * panel does. Each candidate's runtime is read from its MANIFEST, with
   * `?? 'claude-code'` while that query is in flight — so a two-runtime fleet
   * reads as single-runtime until the second agent's manifest lands, and the
   * menu opened in that window offers "Section" as an action with no
   * `new-group-empty` anywhere under it. That is the whole of the flake this
   * helper was blamed for: the spec seeds a codex agent, waits only for the
   * FIRST agent's row, and one run in five spent its 30s waiting for a submenu
   * row that was never going to be rendered.
   *
   * So the shape is read rather than assumed. Both roads end at the same inline
   * name field, which is what every caller is actually after — and the shape
   * itself stays pinned where it is decided, by `NewMenu.test.tsx`.
   *
   * **Which road a given run takes stays undetermined, by design.** The spec's
   * `beforeEach` waits only for the FIRST agent's row, so nothing establishes
   * that the codex agent's manifest has landed by the time a menu opens — and
   * making it wait would pin the GATE rather than the section, which is not
   * what any of these tests are about. Both roads are pinned at the renderer by
   * the unit suite, and both were driven in a real browser with the gate forced
   * each way, so neither is a path this suite has only reasoned about.
   *
   * The entry is addressed by id like everything else here. `renderNodes`
   * recurses into a submenu with the same walk, so its rows carry
   * `data-menu-item-id` too — and reaching for `'Empty group…'` by name would
   * bake in both the wording and the renderer's `…` convention, which is the
   * coupling this file exists to avoid.
   *
   * @param entryId - The submenu row's id, e.g. `'new-group-empty'`.
   */
  async chooseSectionEntry(entryId: string): Promise<void> {
    await this.trigger.click();
    const group = this.item('new-group');
    await expect(group).toBeVisible();

    // Radix stamps `aria-haspopup="menu"` on a sub trigger and on nothing else
    // in this list, so it is the shape's own answer rather than an inference
    // from what happens to be on screen.
    if ((await group.getAttribute('aria-haspopup')) !== 'menu') {
      expect(
        entryId,
        'this fleet is below the smart-preset gate, so "Section" is the by-hand entry ' +
          'and there is no submenu to take a preset from'
      ).toBe('new-group-empty');
      await group.click();
      return;
    }

    // `ArrowRight` rather than a hover: it is the Radix LTR sub-open key, and it
    // is what the rest of this repo's menu tests use. {@link openRadixSubmenu}
    // is what makes that key land rather than being silently dropped.
    await openRadixSubmenu(this.page, group, 'Section');
    await this.item(entryId).click();
  }
}
