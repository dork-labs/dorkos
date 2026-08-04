import { test, expect } from '../../fixtures';

/** One instant of the settings dialog, as the in-page sampler recorded it. */
interface PanelSample {
  /** What triggered the sample — a DOM mutation, an animation frame, or setup. */
  source: string;
  /** Ids inside the dialog that more than one element claims. */
  duplicateIds: string[];
  /** The id of every `role="tabpanel"` in the dialog. */
  panelIds: string[];
  /** Label of the tab marked `aria-selected="true"`. */
  selectedTab: string | null;
  /** How many elements the selected tab's `aria-controls` actually resolves to. */
  controlsResolvesTo: number | null;
}

/**
 * One panel per tab — asserted DURING the switch, not after it.
 *
 * DOR-693: the settings panel host used to crossfade with
 * `AnimatePresence mode="popLayout"`. The exiting wrapper stayed mounted and
 * re-rendered against the new tab, so for the ~150ms of the exit the dialog held
 * two `role="tabpanel"` elements carrying the same DOM id — invalid HTML, and a
 * tab whose `aria-controls` named two panels at once.
 *
 * Every assertion Playwright makes by default retries, which is exactly wrong
 * here: retrying waits the window out and reports the settled state. So this
 * spec installs its own sampler in the page first — a `MutationObserver` that
 * records the DOM on every change, plus a per-frame tick — drives the switches,
 * and only then asserts, over every instant it captured. With the crossfade
 * present this goes red on the mutation sample taken in the very commit that
 * swapped the tab.
 */
test.describe('Settings — one panel per tab, mid-transition @smoke', () => {
  test.beforeEach(async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();
  });

  test('never exposes two panels or a duplicate id while tabs change', async ({
    page,
    settingsPage,
  }) => {
    await settingsPage.open();
    await expect(settingsPage.activePanel).toBeVisible();

    // Install the sampler BEFORE the first click. Scoped to the settings dialog:
    // other surfaces (right panel, terminal, canvas) render their own tabpanels,
    // and this is a claim about this dialog.
    await page.evaluate(() => {
      const w = window as unknown as { __stopPanelSampling: () => PanelSample[] };
      const samples: PanelSample[] = [];

      const take = (source: string) => {
        const root = document.querySelector('[data-testid="settings-dialog"]');
        if (!root) return;

        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const el of root.querySelectorAll('[id]')) {
          if (seen.has(el.id)) duplicates.add(el.id);
          seen.add(el.id);
        }

        const panelIds = [...root.querySelectorAll('[role="tabpanel"]')].map((el) => el.id);
        const selected = root.querySelector('[role="tab"][aria-selected="true"]');
        const controls = selected?.getAttribute('aria-controls') ?? null;

        samples.push({
          source,
          duplicateIds: [...duplicates],
          panelIds,
          selectedTab: selected?.textContent?.trim() ?? null,
          controlsResolvesTo: controls
            ? root.querySelectorAll(`#${CSS.escape(controls)}`).length
            : null,
        });
      };

      let stopped = false;
      const observer = new MutationObserver(() => take('mutation'));
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['id', 'role', 'style', 'aria-selected', 'aria-controls'],
      });

      const tick = () => {
        take('frame');
        if (!stopped) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      w.__stopPanelSampling = () => {
        stopped = true;
        observer.disconnect();
        return samples;
      };

      take('start');
    });

    // Drive real switches. Deliberately NOT `settingsPage.switchTab` — that
    // settles on one panel, which is the state this test is trying to look past.
    for (const tabName of ['Preferences', 'Server', 'Appearance']) {
      await settingsPage.tab(tabName).click();
      await expect(settingsPage.tab(tabName)).toHaveAttribute('aria-selected', 'true');
    }
    // Let two real frames land under the sampler before harvesting, so an
    // async duplicate that appears just after the last commit is still seen.
    // Frame-based, not wall-clock: the panel host no longer animates, and the
    // mutation samples taken inside each switch commit are what catch a
    // reintroduced crossfade regardless of its duration.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })
    );

    const samples: PanelSample[] = await page.evaluate(() => {
      const w = window as unknown as { __stopPanelSampling: () => PanelSample[] };
      return w.__stopPanelSampling();
    });

    // A sampler that never fired would pass every assertion below. Three
    // switches plus half a second of frames is dozens of samples; this asserts
    // the instrument worked before trusting what it says.
    expect(samples.length).toBeGreaterThan(20);

    // (a) no two elements in the dialog ever shared an id, and (b) the selected
    // tab always pointed at exactly one panel — not two, and not zero.
    const offenders = samples.filter(
      (s) =>
        s.duplicateIds.length > 0 ||
        s.panelIds.length !== 1 ||
        (s.selectedTab !== null && s.controlsResolvesTo !== 1)
    );
    expect(
      offenders.slice(0, 5),
      `sampled ${samples.length} instants; ${offenders.length} of them did not show exactly one panel for the selected tab`
    ).toEqual([]);
  });
});
