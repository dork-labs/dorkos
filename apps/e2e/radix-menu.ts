/**
 * Opening a Radix submenu from the keyboard, deterministically (DOR-1800).
 *
 * **The sub-open key only means something while the trigger itself holds
 * focus.** Radix's `MenuSubTrigger` handles it in an `onKeyDown` that begins
 * `if (props.disabled || event.target !== event.currentTarget) return`
 * (`@radix-ui/react-menu`), so a keydown that arrives while focus sits anywhere
 * else — the menu's own content included — is dropped without a trace: nothing
 * opens, nothing errors, and the only symptom is the 30s timeout on the submenu
 * row that was never going to appear.
 *
 * And focus really does sit somewhere else for a moment. A menu opened with the
 * mouse leaves Radix's `FocusScope` to move focus onto the CONTENT on mount, and
 * that lands after the click's promise resolves — while `locator.press()`
 * focuses its own element first. The two race. The press won about four times in
 * five, which is a ~20% flake in every spec that makes a section, and twice
 * through CI's single retry is a merge-queue ejection.
 *
 * @module e2e/radix-menu
 */
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * How many times the sub-open key may be re-sent before the submenu has to be
 * open.
 *
 * More than one because the window between "the trigger is focused" and the
 * keydown is small rather than zero, and a dropped key leaves no mark to react
 * to. Small because each attempt already waits for focus to arrive, so a second
 * miss is a genuine one rather than an impatient first look.
 */
const SUBMENU_OPEN_ATTEMPTS = 4;

/** How long one attempt gives the submenu to answer the key, in milliseconds. */
const SUBMENU_OPEN_TIMEOUT_MS = 1_500;

/**
 * Open the submenu behind an already-visible trigger, and leave it open.
 *
 * The wait is on the two things the key actually needs, in order: the menu has
 * taken focus at all, and then the trigger itself is the focused element. The
 * result is read off the trigger's own `data-state` rather than off the
 * submenu's rows — it is Radix's answer to "is this open", so a retry cannot be
 * fooled by a row that has mounted but is not yet positioned.
 *
 * @param page - The page under test.
 * @param trigger - The submenu's trigger, already on screen.
 * @param name - What to call the submenu in a failure message.
 */
export async function openRadixSubmenu(page: Page, trigger: Locator, name: string): Promise<void> {
  await expect(trigger).toBeVisible();
  await expect(
    page.locator('[role="menu"]:focus-within'),
    `the menu holding "${name}" opened without ever taking focus, so no key can reach its items`
  ).not.toHaveCount(0);

  for (let attempt = 0; attempt < SUBMENU_OPEN_ATTEMPTS; attempt++) {
    if ((await trigger.getAttribute('data-state')) === 'open') return;
    await trigger.focus();
    // Retried by `expect`, so this waits out a focus that is still settling
    // rather than asserting against one frame of it.
    await expect(trigger).toBeFocused();
    await page.keyboard.press('ArrowRight');
    try {
      await expect(trigger).toHaveAttribute('data-state', 'open', {
        timeout: SUBMENU_OPEN_TIMEOUT_MS,
      });
      return;
    } catch {
      // Radix dropped the key. Nothing changed on screen, so the only way to
      // tell is to have asked — and the only fix is to ask again.
    }
  }

  await expect(
    trigger,
    `${SUBMENU_OPEN_ATTEMPTS} presses of ArrowRight never opened the "${name}" submenu`
  ).toHaveAttribute('data-state', 'open');
}
