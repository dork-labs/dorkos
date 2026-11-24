import { expect, it } from 'vitest';
import { verifiedLibrary } from '../../runtime/public-library.js';
import { ownFixtureSession } from '../fixture-session-custody.js';
import {
  assertRetainedStores,
  assertCleanStores,
  assertIsolatedStores,
} from '../retained-stores-fixture.js';
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

it.skipIf(!supplied || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'seeded clean-context native negative control fails its named gate',
  async () => {
    const f = await setup();
    let failed = false,
      primary: unknown;
    try {
      const engine = f.makeEngine(),
        page = f.origin.configure({ role: 'C', seedClean: true });
      const opened = await open(f, engine, {
        kind: 'open',
        requestId: requestId(),
        mode: 'ephemeral',
      });
      const seeded = await report(f, page, 0);
      expect(() => assertCleanStores(seeded)).toThrow('CLEAN_CONTEXT_SEEDED');
      await closeOriginal(f, engine, opened);
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      await finish(f, failed, primary, 'clean-mutant', []);
    }
  },
  40000
);

it
  .skipIf(!supplied || process.platform !== 'darwin' || process.arch !== 'arm64')
  .each([false, true])(
  'two unattended profile workers100+100 with same-live-Page reattachment (shared mutant=%s)',
  async (shared) => {
    const f = await setup();
    let failed = false,
      primary: unknown;
    try {
      const engine = f.makeEngine(),
        pageA = f.origin.configure({ role: 'A' });
      const a = await open(f, engine, {
        kind: 'open',
        requestId: requestId(),
        mode: 'persistent',
        profileId: profile('A'),
      });
      await report(f, pageA, 0);
      await click(f, engine, a.tab, 60);
      await expect
        .poll(() => f.origin.reports.some((r) => r.page === pageA && r.local === 'A'), {
          timeout: 5000,
        })
        .toBe(true);
      const pageB = shared ? pageA : f.origin.configure({ role: 'B' });
      const b = shared
        ? a
        : await open(f, engine, {
            kind: 'open',
            requestId: requestId(),
            mode: 'persistent',
            profileId: profile('B'),
          });
      if (shared) {
        expect(() =>
          assertIsolatedStores(f.origin.reports.at(-1)!, f.origin.reports.at(-1)!)
        ).toThrow('PROFILE_STATE_SHARED');
        await closeOriginal(f, engine, a);
        return;
      }
      await report(f, pageB, 0);
      await click(f, engine, b.tab, 60);
      await expect
        .poll(() => f.origin.reports.some((r) => r.page === pageB && r.local === 'B'), {
          timeout: 5000,
        })
        .toBe(true);
      const library = await f.calls.call('library:verify', () => verifiedLibrary(f.config.runtime));
      const attach = async (opened: typeof a) => {
        const receiver = f.receivers.find((r) => r.browserId === opened.browserId)!;
        const endpoint = receiver.verifiedBrowserAdminEndpoint();
        if (!endpoint) throw Error('ORIGINAL_PAGE_ENDPOINT_MISSING');
        let closing: Promise<void> | undefined;
        const closeController = (value: Awaited<ReturnType<typeof library.connectOverCDP>>) =>
          (closing ??= Promise.resolve().then(() => value.close()));
        const controller = await f.custody.acquire(
          'observer:attach',
          () => library.connectOverCDP(endpoint.url, { timeout: 5000 }),
          closeController
        );
        const context = controller.contexts()[0]!,
          page = context.pages()[0]!;
        if (controller.contexts().length !== 1 || context.pages().length !== 1)
          throw Error('ORIGINAL_PAGE_AMBIGUOUS');
        const session = await f.custody.acquire(
          'observer:target-session',
          async () => ownFixtureSession(await context.newCDPSession(page), controller),
          (value) => value.close(),
          5000,
          (value) =>
            !!value && typeof value === 'object' && 'observed' in value && value.observed === true
        );
        const target = await f.calls.call('observer:target-identity', () =>
          session.session.send('Target.getTargetInfo')
        );
        if (
          typeof target.targetInfo.targetId !== 'string' ||
          !target.targetInfo.targetId ||
          target.targetInfo.type !== 'page'
        )
          throw Error('ORIGINAL_TARGET_UNAVAILABLE');
        const nativePage = await f.calls.call('observer:fixture-marker', () =>
          session.session.send('Runtime.evaluate', {
            expression:
              'JSON.stringify({page:PAGE,role:ROLE,marker:document.getElementById("marker").textContent,revision:Number(localStorage.getItem("revision")||0),url:location.href})',
            returnByValue: true,
          })
        );
        if (nativePage.exceptionDetails || typeof nativePage.result.value !== 'string')
          throw Error('ORIGINAL_PAGE_MARKER_UNAVAILABLE');
        const marker = JSON.parse(nativePage.result.value) as {
          page: string;
          role: string;
          marker: string;
          revision: number;
          url: string;
        };
        if (
          marker.page !== (opened.browserId === a.browserId ? pageA : pageB) ||
          marker.role !== (opened.browserId === a.browserId ? 'A' : 'B') ||
          marker.marker !== marker.role ||
          marker.url !== f.config.network.origin + '/'
        )
          throw Error('ORIGINAL_PAGE_MARKER_MISMATCH');
        let closed: Promise<void> | undefined;
        const close = () =>
          (closed ??= Promise.resolve().then(async () => {
            let failed = false,
              primary: unknown;
            try {
              const result = await session.close();
              if (!result.observed) throw Error('OBSERVER_SESSION_RETURN_UNOBSERVED');
            } catch (error) {
              failed = true;
              primary = error;
            }
            try {
              await closeController(controller);
            } catch (error) {
              if (!failed) primary = error;
              failed = true;
            }
            if (failed) throw primary;
          }));
        return {
          controller,
          context,
          page,
          targetId: target.targetInfo.targetId,
          contextId: target.targetInfo.browserContextId,
          marker,
          endpoint,
          close,
        };
      };
      const originals = [await attach(a), await attach(b)];
      for (const original of originals) await f.calls.call('observer:detach', original.close);
      await f.custody.operation(
        'two-workers:mutations',
        async () => {
          await Promise.all(
            (
              [
                [a, pageA],
                [b, pageB],
              ] as const
            ).map(async ([opened, page]) => {
              for (let revision = 1; revision <= 100; revision++) {
                await click(f, engine, opened.tab, 210);
                await report(f, page, revision);
              }
            })
          );
        },
        90000
      );
      assertIsolatedStores(await report(f, pageA, 100), await report(f, pageB, 100));
      for (const [index, opened] of [a, b].entries()) {
        expect(engine.listTabs(opened.browserId, opened.browserGeneration)).toEqual([opened.tab]);
        const attached = await attach(opened),
          original = originals[index]!;
        expect(attached.targetId).toBe(original.targetId);
        expect(attached.contextId).toBe(original.contextId);
        expect(attached.marker).toEqual({ ...original.marker, revision: 100 });
        expect(attached.controller).not.toBe(original.controller);
        expect(attached.page).not.toBe(original.page); // New SDK facade, same actual native target.
        expect(original.controller.isConnected()).toBe(false);
        expect(attached.endpoint).toEqual(original.endpoint);
        const role = index === 0 ? 'A' : 'B',
          page = index === 0 ? pageA : pageB;
        const before = f.origin.reports.filter((row) => row.page === page).length;
        await click(f, engine, opened.tab, 350);
        await expect
          .poll(() => f.origin.reports.filter((row) => row.page === page).length)
          .toBe(before + 1);
        assertRetainedStores(
          f.origin.reports.filter((row) => row.page === page).at(-1)!,
          role,
          100
        );
        expect(
          (
            await f.calls.call(
              'original-capture',
              () =>
                engine.capture({ kind: 'capture', binding: opened.tab, requestId: requestId() }),
              2500
            )
          ).receipt.binding
        ).toEqual(opened.tab);
        await f.calls.call('observer:detach', attached.close);
      }
      // Each worker emitted exactly one acknowledged report for revisions 1..100; the reattachment read adds one final100 report.
      for (const page of [pageA, pageB]) {
        const revisions = f.origin.reports.filter((row) => row.page === page && row.revision > 0);
        expect(revisions).toHaveLength(101);
        expect(revisions.slice(0, 100).map((row) => row.revision)).toEqual(
          Array.from({ length: 100 }, (_, index) => index + 1)
        );
      }
      for (const opened of [a, b]) await closeOriginal(f, engine, opened);
      for (const role of ['A', 'B'] as const) {
        const page = f.origin.configure({ role });
        const opened = await open(f, engine, {
          kind: 'open',
          requestId: requestId(),
          mode: 'persistent',
          profileId: profile(role),
        });
        assertRetainedStores(await report(f, page, 100), role, 100);
        await closeOriginal(f, engine, opened);
      }
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      await finish(f, failed, primary, shared ? 'shared-mutant' : 'isolated100', []);
    }
  },
  150000
);
