import { test, expect } from '../../fixtures';

/**
 * The Pulse panel's Needs Attention showcase draws rows, and its neighbours
 * still draw theirs (DOR-1766 finding 20.5, DOR-1816).
 *
 * Batch 20 added a `PulsePanel` showcase and could only populate half of it.
 * The Activity half reads through TanStack Query, so an isolated seeded client
 * fills it; the Needs Attention half reads a session's lifecycle out of
 * `useSessionListStore`, a module-level Zustand store shared by every section
 * on the page — so seeding it is a write into state the neighbours can see,
 * and that PR declined to risk it.
 *
 * It is seeded now, and this is the check that the risk was actually handled
 * rather than argued away. **The two assertions have to happen in one page
 * load**: "the demo is populated" and "nothing beside it broke" are the two
 * halves of one claim, and a leak is exactly the kind of defect that only
 * appears when both are on screen together.
 *
 * `/dev/features` is the page that makes it a real test — the showcase sits at
 * the bottom of the same page as the agent sidebar, the fleet table and Jump
 * Back In, three sections that read the session-list store for themselves.
 *
 * Chrome only, no turns, no seeded server state: this is the playground.
 */

/** The rows Pulse draws under "Needs attention". */
const ATTENTION_ROW = '[data-slot="attention-signal-row"]';

/** A parked schedule draws its own card rather than a plain row. */
const SCHEDULE_CARD = '[data-testid="schedule-approval-card"]';

/** What `ShowcaseErrorBoundary` stamps on a showcase that threw. */
const BROKEN_SHOWCASE = '[data-showcase-error]';

/**
 * The console errors this page already logs, found by the browser pass this
 * spec came out of and filed rather than fixed here.
 *
 * `TaskTemplateCard`'s `toggle` variant renders a `Switch` — itself a
 * `<button>` — inside the card's own `<button>`, which is invalid HTML and
 * which React reports twice on every load. Only the playground reaches that
 * variant today (production renders `selectable`), so it is not a user-facing
 * defect and does not belong in a coverage PR; it is finding F2 in
 * `plans/ui-ux-audit-202609/notes/260907-143000-dor-1816-browser-pass-and-deferred-coverage.md`.
 *
 * Matched on the message shell rather than the whole thing: React interpolates
 * the tag names and appends a component stack, so the tail is not stable.
 */
const KNOWN_CONSOLE_ERRORS = ['cannot be a descendant of', 'cannot contain a nested'] as const;

test.describe('Dev Playground — the Pulse attention showcase is populated @smoke', () => {
  test('draws a parked schedule and a wedged session without breaking its neighbours', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto('/dev/features');

    // The showcase is at the bottom of a long page. Waiting for the heading is
    // waiting for the section to have mounted, which is the outcome — the
    // demos below it render synchronously off seeded caches once it has.
    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'PulsePanel' }),
    });
    await expect(section, 'the Agent & Relay page must render the PulsePanel section').toBeVisible({
      timeout: 15_000,
    });

    // Populated, and populated with BOTH blocking groups — the schedule half
    // is query-shaped and the wedged-session half is the Zustand half, so a
    // failure that named only "no rows" would not say which mechanism broke.
    const schedules = section.locator(SCHEDULE_CARD);
    await expect(
      schedules,
      'the parked schedule an agent proposed must draw its approval card'
    ).toHaveCount(1);

    const rows = section.locator(ATTENTION_ROW);
    await expect(
      rows,
      'the wedged session must draw an attention row — this is the half that needs the global ' +
        'session-list store, so zero rows means the store seed did not reach useAttentionSignals'
    ).toHaveCount(1);
    await expect(rows.first()).toContainText('Stopped with an error');

    // …and the sections beside it are still the sections beside it. Named
    // individually rather than counted, because a count that drifts when
    // somebody adds a showcase is a count somebody will relax.
    for (const neighbour of [
      'TasksPanel',
      'Jump back in rows',
      'AgentFleetTable',
      'SessionRow (compact)',
    ]) {
      await expect(
        page.getByRole('heading', { name: neighbour }),
        `the ${neighbour} showcase must still render beside the seeded one`
      ).toBeVisible();
    }

    // The blunt half of "nothing beside it broke": no showcase anywhere on the
    // page fell into its error boundary, and nothing new was logged. Batch 20
    // fixed a showcase that threw on every load of this page's sibling, so this
    // is a live regression and not a hypothetical.
    await expect(
      page.locator(BROKEN_SHOWCASE),
      'no showcase on this page may fall into its error boundary'
    ).toHaveCount(0);

    const unexpected = consoleErrors.filter(
      (message) => !KNOWN_CONSOLE_ERRORS.some((known) => message.includes(known))
    );
    expect(unexpected, 'the page logged a console error nothing has accounted for').toEqual([]);
    // The other half of the allowance, so it cannot outlive the defect: when
    // `TaskTemplateCard`'s toggle variant stops nesting a button, this fails
    // and asks for the entry above to be deleted rather than going on hiding
    // whatever the page logs next.
    for (const known of KNOWN_CONSOLE_ERRORS) {
      // ONE each, not "at least one". React reports each nesting rule once per
      // offending element and the page renders exactly one `variant="toggle"`
      // card, so the number is knowable — and a `toBeGreaterThan(0)` here would
      // go on passing if a second toggle card appeared, which is the same
      // defect twice and worth being told about.
      expect(
        consoleErrors.filter((message) => message.includes(known)).length,
        `the page must log the console error KNOWN_CONSOLE_ERRORS accounts for ("${known}") ` +
          `exactly once. Zero means finding F2 was fixed and that entry is owed a deletion; ` +
          `more than one means a second showcase now reaches the same defect`
      ).toBe(1);
    }
  });
});
