import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertRetainedStores, assertCleanStores } from '../retained-stores-fixture.js';
import { readdir } from 'node:fs/promises';
import {
  supplied,
  requestId,
  profile,
  setup,
  open,
  report,
  click,
  closeOriginal,
  finish,
} from './retained-stores.fixtures.js';

it.skipIf(!supplied || process.platform !== 'darwin' || process.arch !== 'arm64').each([
  { scenario: 'retained-clean', mutant: false },
  { scenario: 'persistence-mutant', mutant: true },
])(
  'three exact clean process restarts and separate clean return: $scenario',
  async ({ scenario, mutant }) => {
    const f = await setup();
    let failed = false,
      primary: unknown;
    const sessions: boolean[] = [];
    try {
      let engine = f.makeEngine(),
        page = f.origin.configure({ role: 'A' });
      let opened = await open(f, engine, {
        kind: 'open',
        requestId: requestId(),
        mode: 'persistent',
        profileId: profile('A'),
      });
      await report(f, page, 0);
      await click(f, engine, opened.tab, 60);
      await expect
        .poll(() => f.origin.reports.some((r) => r.page === page && r.local === 'A'), {
          timeout: 5000,
        })
        .toBe(true);
      assertRetainedStores(f.origin.reports.filter((r) => r.page === page).at(-1)!, 'A', 0);
      const warmed = f.origin.httpRequests;
      for (let restart = 0; restart < 3; restart++) {
        const old = opened;
        await closeOriginal(f, engine, opened);
        await f.calls.call('original-shutdown', () => engine.shutdown(), 6000);
        engine = f.makeEngine();
        page = f.origin.configure({ role: 'A', reset: mutant && restart === 0 });
        opened = await open(f, engine, {
          kind: 'open',
          requestId: requestId(),
          mode: 'persistent',
          profileId: profile('A'),
        });
        expect(opened.browserId).not.toBe(old.browserId);
        expect(opened.tab.tabId).not.toBe(old.tab.tabId);
        const current = await report(f, page, 0);
        sessions.push(current.sessionCookie);
        if (mutant) {
          expect(() => assertRetainedStores(current, 'A', 0)).toThrow('RETAINED_STORE_MISSING');
          return;
        }
        assertRetainedStores(current, 'A', 0);
        expect(f.origin.httpRequests).toBe(warmed);
      }
      const durable = opened,
        pageA = page;
      const before = f.origin.httpRequests;
      const cleanPage = f.origin.configure({ role: 'C' });
      const clean = await open(f, engine, {
        kind: 'open',
        requestId: requestId(),
        mode: 'ephemeral',
      });
      assertCleanStores(await report(f, cleanPage, 0));
      expect(f.origin.httpRequests).toBe(before + 1);
      const ephemeral = await readdir(join(f.config.dataDir, 'ephemeral'));
      expect(ephemeral).toHaveLength(1);
      await click(f, engine, clean.tab, 60);
      await expect
        .poll(() => f.origin.reports.some((r) => r.page === cleanPage && r.local === 'C'), {
          timeout: 5000,
        })
        .toBe(true);
      await click(f, engine, clean.tab, 210);
      assertRetainedStores(await report(f, cleanPage, 1), 'C', 1);
      await closeOriginal(f, engine, clean);
      expect(await readdir(join(f.config.dataDir, 'ephemeral'))).toEqual([]);
      expect(engine.listTabs(durable.browserId, durable.browserGeneration)).toEqual([durable.tab]);
      const priorDurableReports = f.origin.reports.filter((r) => r.page === pageA).length;
      await click(f, engine, durable.tab, 350);
      await expect
        .poll(() => f.origin.reports.filter((r) => r.page === pageA).length)
        .toBe(priorDurableReports + 1);
      assertRetainedStores(f.origin.reports.filter((r) => r.page === pageA).at(-1)!, 'A', 0);
      await closeOriginal(f, engine, durable);
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      await finish(f, failed, primary, scenario, sessions);
    }
  },
  120000
);
