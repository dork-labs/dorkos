import type { AxeResults } from 'axe-core';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { describeViolation, runAxe } from '../../axe';

/**
 * The Dev Playground page this spec drives.
 *
 * It renders `buildSidebarModel` over the four journey fixtures with no server
 * behind it, which is what lets this whole file be a `@smoke` test: it seeds
 * nothing, registers no agent, and cleans nothing up.
 */
const SHOWCASE_PATH = '/dev/sidebar-model';

/** What axe is pointed at: the page's content box, and none of the playground's chrome. */
const AXE_CONTEXT = '[data-slot="page-container"]';

/**
 * The sections each journey is expected to draw, in order.
 *
 * Hard-coded rather than derived from the page, because a test that reads its
 * expectation off the thing it is testing cannot fail. These are the four
 * journeys' answers as `buildSidebarModel` computes them: the top items always
 * first, Direct messages always standing (its empty state is the way to start
 * one), and `power`'s own two sections right under the top items.
 */
const EXPECTED_SECTIONS: Record<string, string[]> = {
  'first-run': ['top', 'channels', 'dms'],
  quiet: ['top', 'channels', 'dms'],
  busy: ['top', 'channels', 'dms'],
  power: ['top', 'group:group-frontend', 'group:group-codex', 'channels', 'dms'],
};

/** Every fixture the page draws, in the order it draws them. */
const FIXTURES = ['first-run', 'quiet', 'busy', 'power'] as const;

/**
 * How long the first navigation to `/dev` may take, cold.
 *
 * A **ceiling, not a delay**: against a warm dev server the panels resolve in
 * milliseconds and this costs nothing. What it pays for is the first
 * navigation of a run, when Vite faults in the Dev Playground's whole module
 * graph — every showcase on every page — on demand. Measured cold on a machine
 * running several agents: 32–39 seconds, with six workers all asking at once.
 * The suite's 5s locator default and its 30s per-test default were both under
 * that, so a cold run failed all six tests on a page that renders correctly.
 */
const PLAYGROUND_COLD_START_MS = 90_000;

/**
 * Open the showcase and wait until all four panels are on screen.
 *
 * @param page - The page under test.
 */
async function openShowcase(page: Page): Promise<Locator> {
  await page.goto(SHOWCASE_PATH);
  const panels = page.locator('[data-slot="sidebar-model-panel"]');
  await expect(panels).toHaveCount(FIXTURES.length, { timeout: PLAYGROUND_COLD_START_MS });
  return panels;
}

/**
 * Switch the playground's theme and wait until the document actually wears it.
 *
 * The click and the class are two different events — the store writes on the
 * next commit — so asserting the class is what makes the screenshot and the axe
 * run below belong to the theme this says they do.
 *
 * @param page - The page under test.
 * @param theme - Which theme to put the document in.
 */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${theme} theme$`, 'i') }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(theme === 'dark');
}

/**
 * Assert the page fits inside the viewport, before axe is asked anything.
 *
 * **This is the coverage guarantee, and it replaced a number that could not be
 * one.** axe-core's `color-contrast` builds a spatial grid bounded by the
 * viewport and does not evaluate text whose rect falls outside it — not a
 * violation, not a pass, not even an `incomplete`. The gate here used to be
 * `evaluated > 200`, which the page clears comfortably while still dropping its
 * bottom half: measured at 1600×2400 it evaluated 260 nodes and missed two
 * injected 1.91:1 labels, and at 1600×4000 it evaluated 322 and missed the same
 * two. An absolute floor is not coverage, because it does not move when the page
 * does.
 *
 * This does. Measured: the page's scroller overflows by 2420px at 1600×2400 and
 * by 820px at 1600×4000 — the two viewports where the old floor passed while
 * both canaries went unevaluated — and by 0 at the viewport this suite uses.
 * When a new showcase pushes the column past the viewport, this reds with the
 * actual reason, and the fix is to raise the viewport (or split the page), not
 * to loosen a threshold.
 *
 * @param page - The page under test.
 */
async function expectPageFitsViewport(page: Page): Promise<void> {
  const fit = await page.evaluate((context) => {
    const content = document.querySelector(context);
    // The SCROLLER's extent, not the content box's own height. The page
    // container is `h-full` (`PageContainer scroll={false}`), so its bounding
    // rect is clamped to the viewport and its children overflow it visibly —
    // measuring that box reported "fits" at every viewport, including the ones
    // where axe was demonstrably missing a third of the page. The nearest
    // scrolling ancestor is the only thing that knows how tall the page is.
    let scroller = content?.parentElement ?? null;
    while (
      scroller !== null &&
      !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)
    ) {
      scroller = scroller.parentElement;
    }
    const box = scroller ?? document.documentElement;
    return { overflow: box.scrollHeight - box.clientHeight, height: box.scrollHeight };
  }, AXE_CONTEXT);

  expect(
    fit.overflow,
    `the showcase page is ${fit.height}px and does not fit the viewport, so axe stopped evaluating partway down — raise the viewport in test.use() (or split the page); never lower a threshold to make this pass`
  ).toBe(0);
}

/**
 * Assert axe actually evaluated every reason chip on the page.
 *
 * The second half of the coverage guarantee, and the one that tracks content
 * rather than geometry. There is exactly one chip per section and per
 * row, they carry text, and they run top to bottom of the page — so "axe saw all
 * of them" is the strongest statement available about whether it saw the page.
 * Add a showcase and the denominator grows on its own; no constant to bump.
 *
 * @param page - The page under test.
 * @param results - What the axe run returned.
 */
async function expectEveryReasonChipEvaluated(page: Page, results: AxeResults): Promise<void> {
  const evaluated = [...results.passes, ...results.violations, ...results.incomplete]
    .filter((rule) => rule.id === 'color-contrast')
    .flatMap((rule) => rule.nodes.map((node) => node.target.join(' ')));

  const missed = await page.evaluate((targets) => {
    const seen = new Set<Element>();
    for (const target of targets) {
      const element = document.querySelector(target);
      if (element) seen.add(element);
    }
    return [...document.querySelectorAll('[data-slot="sidebar-model-reason"]')]
      .filter((chip) => !seen.has(chip))
      .map((chip) => chip.getAttribute('data-reason') ?? '(no reason)');
  }, evaluated);

  expect(
    missed.slice(0, 8),
    `axe did not evaluate ${missed.length} of the page's reason chips — it stopped looking before the page ended, so a contrast failure down there would not be reported`
  ).toEqual([]);
}

/**
 * The mandatory R1 gate, plus the model's section contracts, read off a real
 * browser.
 *
 * The four journey fixtures drive the model's table tests, the Dev Playground's
 * showcases and this file, so what a reviewer looks at and what CI asserts are
 * the same states (spec `sidebar-now-today-library` §13). The unit suite proves
 * `buildSidebarModel` decides the right things; only a browser can prove the
 * decisions survive being drawn — and only a browser can measure contrast on a
 * tint composited from four translucent layers.
 *
 * A NEW file rather than an addition to `sidebar-groups.spec.ts`: that spec
 * seeds an agent and serializes on one shared `ui.sidebar`, and none of this
 * needs either.
 *
 * **P1 AC-6 asks for zero contrast violations and this page has two**, both
 * dimmed rows, both quarantined below. Half of that is inherited and half is
 * self-inflicted: `busy` mutes `#noise`, so any honest drawing of that journey
 * carries it, while the `archive` row in the unread-tier showcase is this
 * branch's own. Both fail for one reason — `SidebarRow` dims muted rows, which
 * no opacity value can make legible (DOR-1098) — so neither is fixable here,
 * and the second is kept because the rule it demonstrates is real. AC-6 is met
 * for everything the page controls, and the gap is named rather than hidden.
 */
test.describe('Sidebar model showcase @smoke', () => {
  /**
   * **The viewport height is load-bearing, and this is the trap that ate an
   * afternoon.** axe-core builds a spatial grid bounded by the viewport, and
   * `color-contrast` silently declines to match any element whose text rect
   * falls outside it — no violation, no pass, no incomplete, just nothing. At
   * the default 720px this page returned ONE evaluated node out of ~320 and an
   * injected 1.7:1 label went undetected: a gate that could not fail. At 5200px
   * the whole page is inside the grid, 300+ nodes are evaluated, and the same
   * injected failure is caught. Do not shrink this below the page's own height.
   *
   * It grows with the page, which is the point: `expectPageFitsViewport` reds
   * the moment a new showcase pushes the column past it, and the fix is this
   * number rather than a looser threshold. A taller viewport than the page is
   * harmless; a shorter one is the trap.
   */
  test.use({ viewport: { width: 1600, height: 10800 } });

  // The per-test default is 30s, which is under the cold cost of the first
  // navigation to `/dev` — see PLAYGROUND_COLD_START_MS. A locator ceiling
  // longer than the test timeout it sits inside can never be reached, so the
  // two are raised together.
  test.describe.configure({ timeout: 150_000 });

  test('renders all four journeys, and asks the server for nothing', async ({ page }) => {
    // Collected from before the navigation, so a call made during the initial
    // render is caught rather than missed (P1 AC-8: the playground renders all
    // four fixtures without a running server).
    const apiCalls: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url());
    });

    const panels = await openShowcase(page);
    expect(await panels.evaluateAll((nodes) => nodes.map((n) => n.dataset.fixture))).toEqual([
      ...FIXTURES,
    ]);

    // Let anything the page was going to fetch actually be fetched before the
    // list is read — an empty list read too early proves nothing.
    await page.waitForLoadState('networkidle');
    expect(apiCalls, 'the sidebar model showcase must render with no server behind it').toEqual([]);
  });

  test('draws the sections each journey earns, and never a session or a thread', async ({
    page,
  }) => {
    await openShowcase(page);

    for (const fixture of FIXTURES) {
      const panel = page.locator(`[data-slot="sidebar-model-panel"][data-fixture="${fixture}"]`);
      const sections = panel.locator('[data-slot="sidebar-model-section"]');
      expect(
        await sections.evaluateAll((nodes) => nodes.map((n) => n.dataset.section)),
        `${fixture} draws the wrong sections`
      ).toEqual(EXPECTED_SECTIONS[fixture]);

      // Places only: no row is a session or a thread. The one reason allowed to
      // say "thread" is the Threads door at the top (`top:threads`) — a page
      // that holds them, not a thread itself — and every fixture draws it.
      const reasons = await panel
        .locator('[data-slot="sidebar-model-reason"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-reason') ?? ''));
      expect(reasons).toContain('top:threads');
      expect(
        reasons.filter((reason) => reason !== 'top:threads' && /session|thread/.test(reason))
      ).toEqual([]);
    }
  });

  test('says why every row it drew is there', async ({ page }) => {
    await openShowcase(page);

    for (const fixture of FIXTURES) {
      const panel = page.locator(`[data-slot="sidebar-model-panel"][data-fixture="${fixture}"]`);
      const rows = await panel.locator('[data-slot="sidebar-model-row"]').count();
      expect(rows, `${fixture} drew no rows at all`).toBeGreaterThan(0);

      // Per row, not a total. `reasons.length > rows` was slack enough to be
      // decorative — power could have lost NINE chips and stayed green — and it
      // could not fail anyway, since the chip is emitted in the same expression
      // as the row. This asks the question that matters: does each row's own
      // list item carry a reason? Deleting the `expansion` prop reds it.
      const rowsWithoutReason = await panel.evaluate((root) =>
        [...root.querySelectorAll('[data-slot="sidebar-model-row"]')]
          .filter(
            (row) => row.closest('li')?.querySelector('[data-slot="sidebar-model-reason"]') == null
          )
          .map((row) => row.textContent?.trim().slice(0, 40) ?? '(empty row)')
      );
      expect(rowsWithoutReason, `${fixture} drew a row that does not say why`).toEqual([]);

      // Sections carry one too, including the headerless top items — which
      // have no header to hang a chip off, so they get their own line.
      const sections = await panel.locator('[data-slot="sidebar-model-section"]').count();
      const reasons = await panel
        .locator('[data-slot="sidebar-model-reason"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-reason') ?? ''));
      expect(reasons.length, `${fixture} has a section with no reason`).toBe(rows + sections);
      for (const reason of reasons) {
        expect(reason, `${fixture} has a malformed reason`).toMatch(/^[a-z-]+:[a-z-]+$/);
      }
    }
  });

  test('a folded section keeps the signal folding it hid', async ({ page }) => {
    await openShowcase(page);

    // `power` folds Channels while some of its rooms are unread and
    // some of its agents are working. Both have to survive the fold (BC-31),
    // and neither does it as a number: the unread rows stay on screen under
    // the header, drawn as they are when the section is open, and the header
    // carries one working dot and no count.
    const channels = page.locator(
      '[data-slot="sidebar-model-panel"][data-fixture="power"] [data-slot="sidebar-model-section"][data-section="channels"]'
    );
    const header = channels.getByRole('button', { name: /^Channels/ });
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(header, 'a folded header is never bold').not.toHaveClass(/font-semibold/);
    await expect(header, 'a folded header carries no count').not.toHaveText(/\d/);
    await expect(header.getByRole('img', { name: 'Agents working' })).toBeVisible();

    // The unread rows are still there, and every one of them is bold.
    const kept = channels.locator('[data-slot="sidebar-model-kept-rows"] [data-sidebar-row]');
    await expect(kept.first()).toBeVisible();
    const states = await kept.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-row-state'))
    );
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((state) => state === 'emphasized')).toBe(true);

    // Expanding gives the section all its rows back, and the dot goes.
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(header.getByRole('img', { name: 'Agents working' })).toHaveCount(0);
    await expect(channels.locator('[data-slot="sidebar-model-kept-rows"]')).toHaveCount(0);
  });

  // The R1 gate. A `for` loop rather than two copies so neither theme can be
  // quietly dropped: removing one is removing a loop entry, which reads as a
  // deletion in a diff.
  for (const theme of ['light', 'dark'] as const) {
    test(`meets 4.5:1 on the panel in the ${theme} theme`, async ({ page }, testInfo) => {
      await openShowcase(page);
      await setTheme(page, theme);

      // The both-themes screenshot pair P1 AC-6 requires, attached to the run
      // rather than described in a PR comment — so a reviewer sees the same
      // pixels the contrast assertion below was computed from.
      await testInfo.attach(`sidebar-model-${theme}.png`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });

      // ── Coverage, before correctness ──
      //
      // Asserted FIRST and page-relatively, because axe reports success for a
      // page it never looked at. Both checks below move with the page: they
      // cannot be satisfied by a page that outgrew the viewport, which an
      // absolute floor could be. See PAGE_MUST_FIT_VIEWPORT.
      await expectPageFitsViewport(page);
      const results = await runAxe(page, AXE_CONTEXT);
      await expectEveryReasonChipEvaluated(page, results);

      // **No quarantine any more, and that is the news.** Two muted rows used to
      // be excused here: `SidebarRow` dimmed them with `opacity-60` over a label
      // already at 5.9:1, which measured 2.6:1 in light and 3.6:1 in dark — a
      // number no opacity clears from that start. DOR-1098 is the decision that
      // muted means fewer signals rather than less legibility, and it ships with
      // `sidebar-simplification` D1: the dim is gone, a muted row keeps its
      // label at full contrast and loses its bold, badge and dot instead. So the
      // bar is simply the bar, for every label on the page.
      const contrast = results.violations.filter((violation) => violation.id === 'color-contrast');
      expect(
        contrast.map(describeViolation),
        `every label must meet 4.5:1 in the ${theme} theme (design-system §Accessibility)`
      ).toEqual([]);

      // Every other rule, held to the same bar. The landmarks, the heading order
      // and the list semantics are as much a part of what this page shows as its
      // colours are.
      const others = results.violations.filter((violation) => violation.id !== 'color-contrast');
      expect(others.map(describeViolation), `axe found a11y defects in the ${theme} theme`).toEqual(
        []
      );

      // What axe declined to judge, pinned. Every one of these is a one-digit
      // unread badge tripping axe's "content is too short to be text" heuristic;
      // anything else appearing here is a hole in the gate that somebody has to
      // decide about rather than inherit.
      //
      // **Matched on what makes it a count pill, not on which component
      // drew it, and read off the node axe reported rather than off a selector
      // resolved again.** The allowance used to name the showcase's own
      // stand-in and look it up by
      // `querySelector` — which silently answers `null` for a target axe
      // reports as more than one selector, so the filter counted nothing and
      // the gate failed with no explanation. `node.html` is the element itself,
      // as axe saw it.
      const undecided = results.incomplete.flatMap((rule) => rule.nodes);
      // The one-digit counts axe declines to judge, enumerated. Each is a
      // DECISION recorded here rather than an exemption inherited: the panel's
      // directed-unread mark since P1, and P4's mobile Home badge.
      //
      // **The mobile badge was measured before it was pinned, and the measuring
      // changed it.** As drawn first — white on amber-500 — it was 2.15:1, a
      // serious failure that would have hidden inside this list precisely
      // because axe cannot judge two-character text. It is amber-950 on
      // amber-500 now: 6.97:1, in both themes, since the pill carries its own
      // background. **Every count admitted here is measured below** — one that
      // is not is a colour nothing checks.
      //
      // **Matched on the node axe reported, not on a selector resolved again.**
      // `document.querySelector` silently answers `null` for a target axe
      // reports as more than one selector — which is most of them once this
      // page grew past its first fold — so a `closest()` filter counted nothing
      // and the gate failed naming elements it had in fact been handed.
      const isCountBadge = (text: string) =>
        /data-slot="count-pill"/.test(text) ||
        /aria-label="(\d+|More than \d+) (mentions?|new messages?)"/.test(text) ||
        /data-testid="mobile-tab-badge-/.test(text);
      const badges = undecided.filter(
        (node) => isCountBadge(node.html) || isCountBadge(node.target.join(' '))
      ).length;
      expect(
        undecided.length - badges,
        `axe could not judge something new in the ${theme} theme: ${undecided
          .map((node) => `${node.target.join(' ')} :: ${node.html}`)
          .join(' | ')}`
      ).toBe(0);

      // **What the pin above costs, paid back.** Forgiving a badge from the
      // undecided list leaves its colours guarded by nothing — axe declines to
      // judge two-character text, so "not a violation" says nothing about it.
      // That is not hypothetical: the mobile badge shipped white-on-amber at
      // 2.15:1 and this list is where it hid.
      //
      // **Scoped to the mobile badge here.** The panel's own count pill has a
      // translucent tint, so it is judged further down, composited over the
      // panel behind it.
      //
      // **Colours are read as pixels, never parsed as text.** Tailwind v4 emits
      // `oklch()`, and a regex pulling the first three numbers out of
      // `oklch(0.769 0.188 70.08)` reads them as RGB — which scored
      // white-on-amber at 19.26:1 and made the first version of this check
      // incapable of failing. A 1×1 canvas makes the browser do the conversion.
      const badgeContrast = await page.evaluate((selector) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        const pixel = (value: string): [number, number, number, number] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return [r!, g!, b!, a! / 255];
        };
        const channel = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const luminance = ([r, g, b]: number[]) =>
          0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
        return [...document.querySelectorAll(selector)].map((node) => {
          const style = getComputedStyle(node);
          const fg = pixel(style.color);
          const bg = pixel(style.backgroundColor);
          const [a, b] = [luminance(fg), luminance(bg)];
          return {
            text: node.textContent ?? '',
            opaque: bg[3] === 1 && fg[3] === 1,
            ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
          };
        });
      }, '[data-testid^="mobile-tab-badge-"]');

      // Observable half first: there ARE badges on this page, so the bars below
      // cannot be cleared by a page that happens to draw none.
      expect(badgeContrast.length, 'no mobile count badges on the page to check').toBeGreaterThan(
        0
      );
      // …and each carries its own opaque background, which is what makes the
      // ratio above a complete answer rather than one missing a backdrop.
      expect(badgeContrast.filter((badge) => !badge.opaque)).toEqual([]);
      expect(
        badgeContrast.filter((badge) => badge.ratio < 4.5),
        `a count badge axe could not judge is below 4.5:1 in the ${theme} theme`
      ).toEqual([]);

      // **The sidebar's count pill, paid back the same way.** Neutral ink on a
      // translucent neutral tint: the tint is composited over the first solid
      // backdrop behind the pill, and the ink is read against that.
      const pillContrast = await page.evaluate((selector) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        const pixel = (value: string): [number, number, number, number] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = value;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return [r!, g!, b!, a! / 255];
        };
        const channel = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const luminance = ([r, g, b]: number[]) =>
          0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
        const over = (top: number[], under: number[]) =>
          [0, 1, 2].map((i) => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
        const backdrop = (node: Element): [number, number, number, number] => {
          for (let el: Element | null = node.parentElement; el !== null; el = el.parentElement) {
            const painted = pixel(getComputedStyle(el).backgroundColor);
            if (painted[3] === 1) return painted;
          }
          return [255, 255, 255, 1];
        };
        return [...document.querySelectorAll(selector)].map((node) => {
          const style = getComputedStyle(node);
          const tint = over(pixel(style.backgroundColor), backdrop(node));
          const ink = over(pixel(style.color), tint);
          const [a, b] = [luminance(ink), luminance(tint)];
          return {
            text: node.textContent ?? '',
            ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
          };
        });
      }, '[data-slot="count-pill"]');

      expect(pillContrast.length, 'no count pills on the page to check').toBeGreaterThan(0);
      expect(
        pillContrast.filter((pill) => pill.ratio < 4.5),
        `a sidebar count pill is below 4.5:1 in the ${theme} theme`
      ).toEqual([]);
    });
  }
});
