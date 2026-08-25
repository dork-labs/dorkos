import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { visibleText } from '../../pages/RoomsPage';
import { openCommandPalette, scopePaletteTo } from '../../pages/command-palette';
import { openCockpit } from './open-cockpit';

// Same reasoning as `rooms-in-palette.spec.ts`: these share one server and one
// room list, so they run one at a time with a ceiling sized for a machine that
// is several worktrees deep in concurrent agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * ⌘K scope chips, in a browser (P3 AC-3, design-decisions §15).
 *
 * Three of these claims cannot be settled anywhere else, and each is a thing
 * jsdom cannot know:
 *
 * - **Tab has to reach the palette at all.** The palette lives inside a Radix
 *   dialog, whose focus trap owns Tab and moves focus out of the input on it.
 *   A jsdom test dispatches `keydown` at a node and never exercises the trap,
 *   so "Tab scopes" is a claim only a real browser can make.
 *   `preventDefault` + `stopPropagation` on the palette's own handler is what
 *   makes it true, and deleting either would leave every unit test green.
 * - **The chip has to be drawn ON the search line**, beside the caret rather
 *   than above or below it. That is a claim about layout, and every element in
 *   jsdom is 0x0.
 * - **The caret rule.** Backspace pops the chip only with the caret at the
 *   start, which needs a real caret in a real input.
 *
 * No Claude SDK or API key: the agent and the channel are seeded over REST and
 * every seeded agent is silent, so nothing here can trigger an agent turn.
 */
test.describe('Scope chips in the command palette @smoke', () => {
  test('an agent becomes a chip on the search line, and Backspace puts it down', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const agent = await roomsApi.registerAgent(
      `E2E Scope Otter ${roomsApi.runId}`,
      '🦦',
      '#3b82f6'
    );

    await openCockpit(basePage);
    const palette = await openCommandPalette(page);

    // Before: the agent is a row in the list, which is the control for every
    // "it is gone" below — without it, an empty list would satisfy them all.
    //
    // From `results`, so the control is a real one: ⌘K's hand-off row draws the
    // typed query, which here IS the agent's name, so on `options` this would
    // also match the hand-off and the control would hold even if the agent's
    // own row had gone missing (DOR-685).
    await palette.input.fill(`@${agent.name}`);
    await expect(palette.results.filter({ hasText: agent.name }).first()).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    await scopePaletteTo(palette, `@${agent.name}`, agent.name);

    // 1. The chip is on screen and says who it is.
    await expect(palette.chip).toHaveText(new RegExp(agent.name));

    // 2. It is drawn ON the input's line, not above or below it — the mockup's
    //    whole shape. Measured as painted geometry, which is the only place
    //    this claim exists: their vertical centres sit within a few pixels.
    const [chipBox, inputBox] = await Promise.all([
      palette.chip.boundingBox(),
      palette.input.boundingBox(),
    ]);
    expect(chipBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    const chipCentre = chipBox!.y + chipBox!.height / 2;
    const inputCentre = inputBox!.y + inputBox!.height / 2;
    expect(Math.abs(chipCentre - inputCentre)).toBeLessThan(8);
    // And it sits BEFORE the caret, reading left to right.
    expect(chipBox!.x).toBeLessThan(inputBox!.x);

    // 3. The list is now the scope's contents, and nothing else. This agent has
    //    no conversations, so the honest answer is a sentence rather than an
    //    empty box — and it is the ONLY row, which is what "filters to that
    //    agent's items" means: the agent's own row went with everything else.
    //
    //    Counted rather than "the agent row is absent": the status row names the
    //    agent too, so a text filter would match it and pass for the wrong
    //    reason.
    //
    //    Over `options` rather than `results`, deliberately — this one is an
    //    absence claim, so counting the hand-off row IN is the stronger version.
    //    Picking up a chip clears the query (`applyScope`), and an empty query
    //    means no hand-off, so the honest total here is 1. If that row ever
    //    turned up under a chip, this line should be the one that says so.
    await expect(palette.options).toHaveCount(1);
    await expect(palette.options.first()).toHaveText(`No conversations with ${agent.name} yet.`);

    // 4. The way out is told, and so is its one condition — Backspace clears
    //    the scope only with the caret at the start, and step 5 is that rule.
    await expect(page.getByText('Clear scope, at the start')).toBeVisible();

    // 5. Backspace with the caret at the start pops the chip — and the residual
    //    query survives it, which is AC-3 verbatim.
    //
    //    The caret is walked back with ArrowLeft rather than Home, and that is
    //    a fact about cmdk rather than a style choice: its root handler claims
    //    Home and End for jumping the HIGHLIGHT to the first and last row, and
    //    calls `preventDefault` on them, so Home never reaches the caret. Only
    //    a browser can show that — jsdom dispatches at a node and moves no
    //    caret at all.
    await palette.input.fill('probe');
    for (let step = 0; step < 'probe'.length; step += 1) {
      await palette.input.press('ArrowLeft');
    }
    await palette.input.press('Backspace');

    await expect(palette.chip).toHaveCount(0);
    await expect(palette.input).toHaveValue('probe');
  });

  test('a channel scopes the same way, and Tab is not stolen by the dialog', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const slug = `scope-chip-${roomsApi.runId}`;
    await roomsApi.createChannel(slug);

    await openCockpit(basePage);
    const palette = await openCommandPalette(page);

    await scopePaletteTo(palette, `#${slug}`, slug);

    // The chip names the channel the way a person types it — once. The `#` is
    // drawn as a mark, so the visible run of text must not repeat it: `# #general`
    // is the defect DOR-583 fixed on every other room row, and a chip is one
    // more place to reintroduce it.
    await expect(palette.chip).toHaveText(new RegExp(`#${slug}`));
    expect(await visibleText(palette.chip)).toBe(slug);
    // Focus stayed in the search field: the palette's handler stopped Tab
    // before the dialog's focus trap could move it. This is the whole reason
    // this case is in a browser.
    await expect(palette.input).toBeFocused();
    await expect(page.getByText(`No conversations came from #${slug}.`)).toBeVisible();
  });
});
