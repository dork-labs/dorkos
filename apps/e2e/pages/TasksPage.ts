import type { Page, Locator } from '@playwright/test';
import { openFromCommandPalette } from './command-palette';

/** Page Object Model for the Scheduled tasks dialog. */
export class TasksPage {
  readonly page: Page;
  readonly dialog: Locator;
  readonly newScheduleButton: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByRole('dialog', { name: /scheduled tasks/i });
    // Two different buttons open the same blank form, and which one is on
    // screen depends on whether any schedule exists: the populated panel heads
    // its list with "New Schedule", the empty state offers "New custom
    // schedule" under the preset gallery.
    this.newScheduleButton = this.dialog.getByRole('button', {
      name: /new (custom )?schedule/i,
    });
    this.closeButton = this.dialog.getByRole('button', { name: /close/i });
  }

  /** Open the Scheduled tasks dialog from the command palette. */
  async open() {
    await openFromCommandPalette(this.page, 'Scheduled tasks');
    await this.dialog.waitFor({ state: 'visible' });
  }

  async close() {
    await this.closeButton.click();
    await this.dialog.waitFor({ state: 'hidden' });
  }

  /** Get the heading of the Scheduled tasks dialog. */
  get heading() {
    return this.dialog.getByRole('heading', { name: /scheduled tasks/i });
  }

  // No accessor for the empty state or the schedule-list heading. Both describe
  // whether the SERVER has any schedules, which the suite's specs seed
  // concurrently — so any assertion built on one is a claim about state this
  // test does not own. Assert on a schedule you seeded instead.

  /** Get the "New Schedule" dialog (nested inside Tasks). */
  get createDialog() {
    return this.page.getByRole('dialog', { name: /new schedule/i });
  }

  /** Open the New Schedule creation dialog, which lands on the template picker. */
  async openCreateDialog() {
    await this.newScheduleButton.click();
    await this.createDialog.waitFor({ state: 'visible' });
  }

  /** The template picker's escape hatch to a blank form. */
  get startFromScratchButton() {
    return this.createDialog.getByRole('button', { name: 'Start from scratch' });
  }

  /**
   * Leave the template picker for the blank form.
   *
   * The create dialog opens on a picker, and none of the form fields exist in
   * the DOM until a starting point is chosen — so every field accessor below
   * needs this first.
   */
  async startFromScratch() {
    await this.startFromScratchButton.click();
    await this.nameInput.waitFor({ state: 'visible' });
  }

  // The three required fields are the only ones with a label association; the
  // `*` is part of the rendered label text, so it is part of the name.

  /** Get the Name field in the create dialog. */
  get nameInput() {
    return this.createDialog.getByRole('textbox', { name: 'Name *' });
  }

  /** Get the Description field in the create dialog. */
  get descriptionInput() {
    return this.createDialog.getByRole('textbox', { name: 'Description *' });
  }

  /** Get the Prompt field in the create dialog. */
  get promptInput() {
    return this.createDialog.getByRole('textbox', { name: 'Prompt *' });
  }

  /**
   * Reveal the cadence controls.
   *
   * They sit in a closed `<details>` whenever the form started blank, and
   * Playwright treats everything inside a closed `<details>` as hidden. The
   * summary has no implicit ARIA role, hence the tag selector.
   */
  async openScheduleSection() {
    await this.createDialog.locator('summary').filter({ hasText: 'Schedule' }).click();
  }

  /**
   * Pick a cadence by name — `Every 15 minutes`, `Every hour`, `Every day`,
   * `Every week`, `Every month`.
   *
   * @param label - The frequency option to choose.
   */
  async selectFrequency(label: string) {
    await this.createDialog.getByRole('combobox', { name: 'Frequency' }).click();
    // The listbox portals out of the dialog, so it is addressed on the page.
    await this.page.getByRole('option', { name: label, exact: true }).click();
  }

  /** Get the Create button in the create dialog. */
  get createButton() {
    return this.createDialog.getByRole('button', { name: /^create$/i });
  }

  /** Get the Cancel button in the create dialog. */
  get cancelButton() {
    return this.createDialog.getByRole('button', { name: /^cancel$/i });
  }
}
