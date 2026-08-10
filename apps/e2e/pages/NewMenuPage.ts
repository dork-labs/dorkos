import type { Locator, Page } from '@playwright/test';

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
  | 'new-session'
  | 'new-channel'
  | 'new-message'
  | 'new-agent'
  | 'new-group';

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
   * Scoped to the shadcn `sidebar-group-action` slot so it never collides with
   * `AgentOnboardingCard`'s plain button, which matches the same name at small
   * fleet sizes. `data-sidebar` rather than `data-slot`: that is ours alone.
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
   * Open "Agent group" — a submenu, because a group is made by hand or from
   * rules — and take one of its entries.
   *
   * `ArrowRight` rather than a hover: it is the Radix LTR sub-open key, and it
   * is what the rest of this repo's menu tests use.
   *
   * The entry is addressed by id like everything else here. `renderNodes`
   * recurses into a submenu with the same walk, so its rows carry
   * `data-menu-item-id` too — and reaching for `'Empty group…'` by name would
   * bake in both the wording and the renderer's `…` convention, which is the
   * coupling this file exists to avoid.
   *
   * @param entryId - The submenu row's id, e.g. `'new-group-empty'`.
   */
  async chooseGroupSubmenu(entryId: string): Promise<void> {
    await this.trigger.click();
    const group = this.item('new-group');
    await group.waitFor({ state: 'visible' });
    await group.press('ArrowRight');
    await this.item(entryId).click();
  }
}
