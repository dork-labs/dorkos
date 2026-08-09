import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { openCockpit } from './open-cockpit';
import { expectCaretAt, expectComposerText } from '../../pages/composer-probe';

// Same reasoning as the other rooms specs: these share one server and one room
// list, so they run one at a time with a ceiling sized for a machine that is
// several worktrees deep in concurrent agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * Read `aria-activedescendant` off the composer and resolve it to an element.
 *
 * This indirection is the point of the file. Asserting on the row carrying
 * `data-selected` would test the paint; resolving the id the composer publishes
 * tests what a screen reader is actually handed — and an id pointing at nothing,
 * which announces nothing at all, fails here instead of passing quietly.
 */
async function announced(page: Page, composer: Locator): Promise<Locator> {
  const id = await composer.getAttribute('aria-activedescendant');
  expect(id, 'the composer names an active row').toBeTruthy();
  const row = page.locator(`#${id}`);
  await expect(row, 'aria-activedescendant resolves to a rendered row').toHaveCount(1);
  return row;
}

/**
 * Which of `names` the announced row is for.
 *
 * The picker's row order is the roster's, and memberships are ordered
 * `(joinedAt, authorId)` — a seeded roster ties on `joinedAt`, so a ULID decides
 * which agent comes first and it differs run to run. Reading the announcement
 * instead of assuming it keeps these assertions about the thing under test
 * (announcement follows the cursor, and matches what Enter inserts) rather than
 * about a coin flip.
 */
async function announcedNameAmong(page: Page, composer: Locator, names: string[]): Promise<string> {
  const row = await announced(page, composer);
  const text = (await row.textContent()) ?? '';
  const match = names.find((name) => text.includes(name));
  expect(match, `announced row is one of ${names.join(', ')} — got "${text}"`).toBeTruthy();
  return match!;
}

/**
 * The `@` mention picker in a room, in a real browser.
 *
 * Three claims live here and nowhere else:
 *
 * 1. **What a screen reader is told.** jsdom loads no CSS and computes
 *    accessible names differently, and this repo shipped a room row that
 *    announced its name twice while every unit test stayed green (DOR-583).
 * 2. **The menu-to-editor focus race.** Clicking a row moves focus off the
 *    textarea, and the composer dismisses an open panel on blur. If the panel
 *    does not swallow that mousedown, the row unmounts under the pointer and
 *    the click lands on nothing. jsdom runs no such race.
 * 3. **That the mention actually reached somebody.** The text reads the same
 *    either way; only the entry the server stored says whether anyone was
 *    addressed, so these read it back over the API.
 *
 * **Only the Agents section appears here, and that is not an omission.** A local
 * install mints exactly one human author (ADR 260727-184933 D6 closes
 * registration after the first account), and the picker never offers the reader
 * their own row — so there is no second person for a People section to hold. The
 * cursor crossing a section boundary is covered in jsdom, where a roster with
 * two humans can simply be handed to the component.
 *
 * No Claude SDK or API key: the fixture sets every agent member of a channel to
 * `silent` on the membership itself, so the `@mention` this test types addresses
 * an agent for real and still starts no turn.
 */
test.describe('Rooms — the @ mention picker @smoke', () => {
  test('announces the row it inserts, and addresses that agent for real', async ({
    page,
    roomsApi,
    roomsPage,
    basePage,
  }) => {
    // Slug handles, because that is what an `@` can carry: a name with a space
    // in it is not addressable at all, which the server tests cover separately.
    const ana = await roomsApi.registerAgent(`e2e-ana-${roomsApi.runId}`, '🦊', '#e07b39');
    const kai = await roomsApi.registerAgent(`e2e-kai-${roomsApi.runId}`, '🦉', '#5b8def');
    const slug = `mention-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, `#${slug}`, [ana, kai]);

    await openCockpit(basePage);
    await page.goto(`/channels?id=${room.id}`);

    const composer = roomsPage.composer(`#${slug}`);
    await expect(composer).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // Real keystrokes: trigger detection runs off the caret, and `fill` sets a
    // value without ever moving one.
    await composer.click();
    await composer.pressSequentially('please look @');

    // --- 1. The accessibility tree, as Chromium computes it ---
    const listbox = page.getByRole('listbox', { name: 'Mentions' });
    await expect(listbox).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    const groups = listbox.getByRole('group');
    await expect(groups).toHaveCount(1);
    await expect(groups.first()).toHaveAccessibleName('Agents');

    // A row is named by the agent plus the handle that addresses it, once each.
    // The WHOLE name, not a substring: `toContainText` would be satisfied by the
    // duplicate-announcement defect this suite exists to catch. The emoji is
    // decoration and must not be in the name.
    const anaRow = listbox.getByRole('option').filter({ hasText: ana.name });
    await expect(anaRow).toHaveCount(1);
    await expect(anaRow).toHaveAccessibleName(`${ana.name} @${ana.name}`);

    // --- 2. What is announced is what Enter inserts ---
    // Read the announced row FIRST. Asserting only on the resulting text would
    // pass just as happily while a screen reader was reading out the other one.
    const both = [ana.name, kai.name];
    const opened = await announcedNameAmong(page, composer, both);

    // The announcement follows the cursor, both ways.
    await composer.press('ArrowDown');
    const moved = await announcedNameAmong(page, composer, both);
    expect(moved).not.toBe(opened);
    await composer.press('ArrowUp');
    expect(await announcedNameAmong(page, composer, both)).toBe(opened);

    // Whoever is announced now is who Enter must insert.
    await expect(await announced(page, composer)).toHaveAccessibleName(`${opened} @${opened}`);
    await composer.press('Enter');

    await expectComposerText(composer, `please look @${opened} `);
    await expect(listbox).toBeHidden();
    await expect(composer).toHaveAttribute('aria-expanded', 'false');

    // --- 3. It reached the agent it named ---
    await composer.press('Enter');
    const text = `please look @${opened}`;
    await expect
      .poll(async () => (await roomsApi.listEntries(room.id)).map((e) => e.body.text), {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .toContain(text);

    const posted = (await roomsApi.listEntries(room.id)).find((e) => e.body.text === text)!;
    const roster = await roomsApi.getRoom(room.id);
    const addressed = roster.members.find((m) => m.author.displayName === opened)?.author.id;
    expect(addressed, `${opened} is on the roster`).toBeTruthy();
    // Exactly the agent that was announced — not "somebody was mentioned", and
    // not both of them.
    expect(posted.mentions).toEqual([addressed]);
  });

  test('a click on a row inserts it, which the focus race would otherwise eat', async ({
    page,
    roomsApi,
    roomsPage,
    basePage,
  }) => {
    const ana = await roomsApi.registerAgent(`e2e-click-${roomsApi.runId}`, '🦊', '#e07b39');
    const slug = `mention-click-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, `#${slug}`, [ana]);

    await openCockpit(basePage);
    await page.goto(`/channels?id=${room.id}`);

    const composer = roomsPage.composer(`#${slug}`);
    await expect(composer).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await composer.click();
    await composer.pressSequentially('@');

    const listbox = page.getByRole('listbox', { name: 'Mentions' });
    await expect(listbox).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    const row = listbox.getByRole('option').filter({ hasText: ana.name });
    await expect(row).toHaveCount(1);

    await row.click();

    await expectComposerText(composer, `@${ana.name} `);
    // And the composer has the keyboard back, with the caret past the mention,
    // so the sentence can just be continued. Both halves matter: focus without
    // the caret leaves the next word landing in the wrong place.
    await expect(composer).toBeFocused();
    await expectCaretAt(composer, `@${ana.name} `.length);

    await composer.pressSequentially('please look');
    await expectComposerText(composer, `@${ana.name} please look`);
  });

  test('re-taking a mention already written leaves the caret past it', async ({
    page,
    roomsApi,
    roomsPage,
    basePage,
  }) => {
    const ana = await roomsApi.registerAgent(`e2e-recaret-${roomsApi.runId}`, '🦊', '#e07b39');
    const slug = `mention-recaret-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, `#${slug}`, [ana]);

    await openCockpit(basePage);
    await page.goto(`/channels?id=${room.id}`);

    const composer = roomsPage.composer(`#${slug}`);
    await expect(composer).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await composer.click();
    await composer.pressSequentially(`hey @${ana.name} there`);

    // Arrow the caret back INTO the mention that is already written, which is
    // enough to reopen the picker — a caret move is a trigger.
    //
    // Real key presses, because that is what a person does. It is also the only
    // thing that reopens the picker here: a programmatic `setSelectionRange` on
    // the focused textarea DOES fire a native `selectionchange` (measured in
    // Chromium), but it does not reach React's synthesised `onSelect`, so the
    // composer never reports the new caret and the panel stays shut.
    for (let i = 0; i < ' there'.length; i++) await composer.press('ArrowLeft');
    await expect(page.getByRole('listbox', { name: 'Mentions' })).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    const caretInsideMention = `hey @${ana.name}`.length;
    await expectCaretAt(composer, caretInsideMention);

    await composer.press('Enter');

    // Taking the row rewrites the text to exactly what it already said, so the
    // value never changes — and the caret contract still applies. Left where it
    // was, the next word lands against the handle.
    await expectComposerText(composer, `hey @${ana.name} there`);
    await expectCaretAt(composer, caretInsideMention + 1);

    // And the caret request does not survive to fire on the next edit, dragging
    // the caret back into the middle of the sentence a keystroke later.
    await composer.press('End');
    await composer.pressSequentially('!');
    await expectComposerText(composer, `hey @${ana.name} there!`);
    await expectCaretAt(composer, `hey @${ana.name} there!`.length);
  });

  test('a name nobody has leaves Enter alone, so the message still sends', async ({
    page,
    roomsApi,
    roomsPage,
    basePage,
  }) => {
    const ana = await roomsApi.registerAgent(`e2e-plain-${roomsApi.runId}`, '🦊', '#e07b39');
    const slug = `mention-plain-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, `#${slug}`, [ana]);

    await openCockpit(basePage);
    await page.goto(`/channels?id=${room.id}`);

    const composer = roomsPage.composer(`#${slug}`);
    await expect(composer).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await composer.click();
    // A price, not a mention — and the panel that opens has nothing to pick.
    await composer.pressSequentially('refunded @99');
    // Scoped to the listbox: the same sentence also lives in the composer's
    // screen-reader announcer, so a bare text match resolves to two elements.
    await expect(page.getByRole('listbox').getByText('No one by that name.')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // Enter must reach the send path rather than being swallowed by a panel
    // with no rows in it.
    await composer.press('Enter');
    await expectComposerText(composer, '');

    await expect
      .poll(async () => (await roomsApi.listEntries(room.id)).map((e) => e.body.text), {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .toContain('refunded @99');

    // Stored exactly as typed, addressing nobody.
    const entries = await roomsApi.listEntries(room.id);
    expect(entries.find((e) => e.body.text === 'refunded @99')!.mentions).toEqual([]);
  });
});
