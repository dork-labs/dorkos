import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SOLE_SIDEBAR_TAG } from '../../fixtures/sole-access';
import { BasePage } from '../../pages/BasePage';
import { DashboardSidebarPage } from '../../pages/DashboardSidebarPage';

/**
 * Where this spec's agent directory lives, and the scan root it registers under.
 *
 * The same tree `fixtures/rooms-api.ts` uses, for the same three reasons: it is
 * inside the checkout (so the server's boundary accepts it), it is disposable,
 * and naming it as the `scanRoot` is what keeps the namespace derivation from
 * falling back to the server's own default.
 */
const AGENT_ROOT = join(import.meta.dirname, '..', '..', '.temp', 'fixtures');

/**
 * An agent registered, renamed or removed shows up in EVERY open window, and so
 * does a settings change — with no reload and no click (DOR-2052).
 *
 * ## The bug, and why only a browser can prove it is gone
 *
 * The sidebar draws its agent rows from `['mesh','agent-paths']` (30s stale) and
 * its sections from `['config','current']` (30s). TanStack Query refetches a
 * stale query on window focus or a stream reconnect and at no other time, so a
 * person who stayed in one window saw neither. Asking DorkBot to register two
 * projects and put them in a section did exactly that: both writes landed, the
 * sidebar did not move, and DorkBot told the operator to refresh the page.
 *
 * Every assertion below could be made green by a reload, which is precisely why
 * this spec never performs one. Both windows are opened BEFORE anything is
 * written, nothing is clicked between the write and the assertion, and the
 * second window is never focused — a `page.bringToFront()` anywhere in here
 * would hand the test a window-focus refetch and prove nothing at all.
 *
 * ## Two pages in ONE context
 *
 * Real windows of one browser share a profile, and sharing it is what makes the
 * second window a genuine second reader of `/api/events` rather than a second
 * browser. Same reasoning as `multi-window.spec.ts` next door.
 *
 * ## Why it wears the sole-sidebar tag
 *
 * It renders the shared panel and writes the whole `ui.sidebar` section, which
 * is the pair of things `fixtures/sole-access.ts` exists for.
 */
test.describe(
  'agents and settings reach every open window @smoke',
  { tag: SOLE_SIDEBAR_TAG },
  () => {
    // Two windows, four API writes and a settled assertion after each. Generous
    // rather than tight: the failure this guards reports as an assertion that
    // never becomes true, and the suite default would turn that into a bare test
    // timeout with nothing naming which write went unheard.
    test.setTimeout(120_000);

    /**
     * How long an assertion waits for a broadcast to land.
     *
     * The hooks coalesce on a trailing edge (400ms for agents, 500ms for config),
     * so the floor is the window plus a round trip. Eight seconds is far above
     * that and far below the 30-second stale time a poll would need — which is
     * the whole point: an assertion that waited 30s would pass on the OLD code
     * too, and prove nothing.
     */
    const LIVE_MS = 8_000;

    const runId = randomUUID().slice(0, 8);
    const agentName = `E2E Live Agent ${runId}`;
    const renamedName = `E2E Live Renamed ${runId}`;
    const groupName = `E2E Live Section ${runId}`;
    const agentDir = join(AGENT_ROOT, `live-agent-list-${runId}`);

    test('a register, a rename, a removal and a settings write all land live in both', async ({
      page,
      context,
      request,
      basePage,
      dashboardSidebar,
    }) => {
      const second = await context.newPage();
      const secondBase = new BasePage(second);
      const secondSidebar = new DashboardSidebarPage(second);

      /** Assert something about the sidebar in BOTH windows. */
      const inBoth = async (
        what: string,
        check: (sidebar: DashboardSidebarPage, which: string) => Promise<void>
      ) => {
        await test.step(what, async () => {
          await check(dashboardSidebar, 'window 1');
          await check(secondSidebar, 'window 2');
        });
      };

      /** The `ui.sidebar` this machine had before the test, to put back after. */
      let sidebarBefore: unknown;

      try {
        await test.step('open two windows, neither of which will be reloaded again', async () => {
          await basePage.goto();
          await basePage.waitForAppReady();
          await basePage.ensureSidebarOpen();
          await secondBase.goto();
          await secondBase.waitForAppReady();
          await secondBase.ensureSidebarOpen();

          // A sentinel on each window, planted AFTER the last navigation this
          // test performs. Any reload — by the app, by a stray `goto`, by
          // anything — replaces the document and takes it with it. The check at
          // the end says why the obvious `performance` reading cannot do this.
          for (const target of [page, second]) {
            await target.evaluate(() => {
              const w = window as unknown as { __dor2052: string; __dor2052Wakes: number };
              w.__dor2052 = 'same document';
              // The OTHER way TanStack Query refetches a stale query: the focus
              // manager listens for `visibilitychange`. Counting them closes the
              // last hole in this test — a pass explained by the window waking
              // up rather than by the broadcast.
              w.__dor2052Wakes = 0;
              window.addEventListener('visibilitychange', () => (w.__dor2052Wakes += 1));
              window.addEventListener('focus', () => (w.__dor2052Wakes += 1));
            });
          }
        });

        // Read the config AFTER both windows are up, so the restore below puts
        // back what was really there rather than anything this test caused.
        const configBefore = await request.get('/api/config');
        expect(configBefore.ok(), 'could not read the config to restore later').toBe(true);
        const parsed = (await configBefore.json()) as { ui: { sidebar: unknown } };
        sidebarBefore = parsed.ui.sidebar;

        // --- Register -------------------------------------------------------
        // Through `roomsApi`'s own path shape: a directory this run owns, named
        // as its scan root, so the agent lands in this run's namespace.
        const registered = await test.step('register an agent over the API', async () => {
          await mkdir(agentDir, { recursive: true });
          const res = await request.post('/api/mesh/agents', {
            data: {
              path: agentDir,
              scanRoot: AGENT_ROOT,
              overrides: { name: agentName, runtime: 'claude-code', icon: '🛰️', color: '#8b5cf6' },
            },
          });
          expect(res.status(), await res.text()).toBe(201);
          return (await res.json()) as { id: string };
        });

        await inBoth('the row appears in both windows, with no reload', async (sidebar, which) => {
          await expect(
            sidebar.agentRow(agentName),
            `${which} never showed the new agent`
          ).toBeVisible({ timeout: LIVE_MS });
        });

        // --- Rename ---------------------------------------------------------
        await test.step('rename it over the API', async () => {
          const res = await request.patch(`/api/mesh/agents/${registered.id}`, {
            data: { displayName: renamedName },
          });
          expect(res.status(), await res.text()).toBe(200);
        });

        await inBoth('the row renames itself in both windows', async (sidebar, which) => {
          await expect(sidebar.agentRow(renamedName), `${which} kept the old name`).toBeVisible({
            timeout: LIVE_MS,
          });
          await expect(
            sidebar.agentRow(agentName),
            `${which} still shows the old name`
          ).toHaveCount(0, { timeout: LIVE_MS });
        });

        // --- Remove ---------------------------------------------------------
        await test.step('remove it over the API', async () => {
          const res = await request.delete(`/api/mesh/agents/${registered.id}`);
          expect(res.status(), await res.text()).toBe(200);
        });

        await inBoth('the row leaves both windows', async (sidebar, which) => {
          await expect(
            sidebar.agentRow(renamedName),
            `${which} still draws a gone agent`
          ).toHaveCount(0, { timeout: LIVE_MS });
        });

        // --- Settings -------------------------------------------------------
        // The whole `ui.sidebar` section, because `PATCH /api/config` replaces
        // arrays and the client writes the complete section every time.
        await test.step('add a sidebar section over the API', async () => {
          const current = sidebarBefore as { groups?: unknown[] };
          const res = await request.patch('/api/config', {
            data: {
              ui: {
                sidebar: {
                  ...current,
                  groups: [
                    ...(current.groups ?? []),
                    { id: `e2e-live-${runId}`, name: groupName, items: [] },
                  ],
                },
              },
            },
          });
          expect(res.status(), await res.text()).toBe(200);
        });

        await inBoth('the section appears in both windows', async (sidebar, which) => {
          await expect(
            sidebar.groupHeader(groupName),
            `${which} never drew the new section`
          ).toBeVisible({ timeout: LIVE_MS });
        });

        // Nothing was reloaded: prove it rather than assert it in prose, because
        // a reload would make every assertion above pass for the wrong reason.
        //
        // **Not by counting navigation entries.** The first cut of this check
        // asserted `performance.getEntriesByType('navigation').length === 1`,
        // which is 1 before a reload AND 1 after it — a reload replaces the
        // document and its performance timeline rather than appending to it, so
        // the count never moves. That check could not fail, and review measured
        // it failing to fail.
        //
        // Two things CAN tell the difference: the navigation entry's own `type`,
        // which a reload sets to `'reload'`, and a sentinel planted on `window`
        // after the last deliberate navigation, which a fresh document does not
        // have.
        for (const [which, target] of [
          ['window 1', page],
          ['window 2', second],
        ] as Array<[string, Page]>) {
          const state = await target.evaluate(() => ({
            navigationType: (
              performance.getEntriesByType('navigation')[0] as
                PerformanceNavigationTiming | undefined
            )?.type,
            sentinel: (window as unknown as { __dor2052?: string }).__dor2052,
            wakes: (window as unknown as { __dor2052Wakes?: number }).__dor2052Wakes,
          }));
          expect(
            state.navigationType,
            `${which} reports a reload navigation, which would fake every pass above`
          ).not.toBe('reload');
          expect(
            state.sentinel,
            `${which} lost its page-lifetime sentinel, so its document was replaced ` +
              'and every assertion above proved nothing'
          ).toBe('same document');
          expect(
            state.wakes,
            `${which} was focused or made visible during the test, so a focus refetch ` +
              'could explain the pass instead of the broadcast'
          ).toBe(0);
        }
      } finally {
        if (sidebarBefore !== undefined) {
          await request
            .patch('/api/config', { data: { ui: { sidebar: sidebarBefore } } })
            .catch(() => {});
        }
        await rm(agentDir, { recursive: true, force: true }).catch(() => {});
        await second.close();
      }
    });
  }
);
