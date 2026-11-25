import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type {} from '../../configuration.js';
import { verifiedLibrary } from '../../runtime/public-library.js';
import { ownFixtureSession } from '../fixture-session-custody.js';
import {
  fixtureJSON,
  requestId,
  profileId,
  fixture,
  originals,
  gone,
  restart,
  finishFixture,
} from './supervisor-crash-recovery.fixtures.js';

it.skipIf(!fixtureJSON || process.platform !== 'darwin').each(['renderer', 'browser'] as const)(
  'original %s crash retires IDs, retains quarantine and permits a distinct fresh relationship without replay',
  async (mode) => {
    const f = await fixture();
    let observed = false,
      failed = false,
      primary: unknown;
    let controller:
      | Awaited<ReturnType<Awaited<ReturnType<typeof verifiedLibrary>>['connectOverCDP']>>
      | undefined;
    try {
      const opened = await f.engine.open({
        kind: 'open',
        mode: 'persistent',
        profileId,
        requestId: requestId(),
      });
      await writeFile(
        join(f.config.dataDir, 'profiles', profileId, 'fixture-marker'),
        'original-value',
        { mode: 0o600 }
      );
      expect(
        await f.engine.input({
          kind: 'input',
          requestId: requestId(),
          binding: opened.tab,
          steps: [{ kind: 'click', x: 60, y: 45, button: 'left' }],
        })
      ).toMatchObject({ outcome: 'completed' });
      await expect.poll(f.effects).toBe(1);
      const snapshot = await originals(f),
        receiver = f.receivers[0]!;
      const endpoint = receiver.verifiedBrowserAdminEndpoint();
      if (!endpoint) throw new Error('FIXTURE_ORIGINAL_ENDPOINT_UNAVAILABLE');
      if (mode === 'browser') {
        const version = await f.custody.operation('crash-socket:discovery', async () => {
          const response = await fetch(`${endpoint.url}/json/version`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error('FIXTURE_CDP_DISCOVERY_FAILED');
          return (await response.json()) as { webSocketDebuggerUrl?: string };
        });
        const socketURL = new URL(version.webSocketDebuggerUrl!);
        if (
          socketURL.protocol !== 'ws:' ||
          socketURL.host !== new URL(endpoint.url).host ||
          !socketURL.pathname.startsWith('/devtools/browser/')
        )
          throw new Error('FIXTURE_CDP_ENDPOINT_MISMATCH');
        const socket = new WebSocket(socketURL);
        const originalSend = socket.send,
          originalClose = socket.close;
        const closed = new Promise<void>((resolve) =>
          socket.addEventListener(
            'close',
            (event) => {
              if (event.target === socket) resolve();
            },
            { once: true }
          )
        );
        f.custody.adopt('crash-socket:close', socket, async (original) => {
          if (original.readyState !== WebSocket.CLOSED) Reflect.apply(originalClose, original, []);
          await closed;
        });
        await f.custody.operation(
          'crash-socket:open',
          () =>
            new Promise<void>((resolve, reject) => {
              socket.addEventListener('open', () => resolve(), { once: true });
              socket.addEventListener(
                'error',
                () => reject(new Error('FIXTURE_CDP_SOCKET_FAILED')),
                { once: true }
              );
            })
        );
        await f.custody.operation('named-crash:submission', async () => {
          const currentEndpoint = receiver.verifiedBrowserAdminEndpoint();
          if (
            !currentEndpoint ||
            currentEndpoint.url !== endpoint.url ||
            JSON.stringify(currentEndpoint.root) !== JSON.stringify(endpoint.root) ||
            JSON.stringify(currentEndpoint.supervisor) !== JSON.stringify(endpoint.supervisor)
          )
            throw new Error('FIXTURE_ORIGINAL_ENDPOINT_CHANGED');
          Reflect.apply(originalSend, socket, [JSON.stringify({ id: 1, method: 'Browser.crash' })]);
        });
      } else {
        const library = await f.custody.operation('fixture-library:verify', () =>
          verifiedLibrary(f.config.runtime)
        );
        controller = await f.custody.acquire(
          'controller:attach',
          () => library.connectOverCDP(endpoint.url, { timeout: 5000 }),
          (value) => value.close()
        );
        const originalController = controller;
        const sessionOwner = await f.custody.acquire(
          'crash-session:attach',
          async () => {
            const native =
              mode === 'renderer'
                ? await originalController
                    .contexts()[0]!
                    .newCDPSession(originalController.contexts()[0]!.pages()[0]!)
                : await originalController.newBrowserCDPSession();
            return ownFixtureSession(native, originalController);
          },
          (value) => value.close(),
          5000,
          (value) =>
            !!value && typeof value === 'object' && 'observed' in value && value.observed === true
        );
        const session = sessionOwner.session;
        // A named native crash may reject its command response; retain that exact original settlement.
        void f.custody
          .operation('named-crash:command', () =>
            Promise.allSettled([session.send(mode === 'renderer' ? 'Page.crash' : 'Browser.crash')])
          )
          .catch(() => {});
      }
      const retired = await f.custody.operation(
        'crash:retirement',
        () => receiver.observation,
        6000
      );
      expect(retired.firstCause).toBe('engineFault');
      if (retired.terminal.cleanup !== 'observed') {
        if (retired.terminal.cleanup === 'failed') {
          expect(mode).toBe('browser');
          expect(retired.terminal.reason).toBe('closeFailed');
        } else expect(retired.terminal.cleanup).toBe('unverified');
        expect(retired.uncertainty.length).toBeGreaterThan(0);
        const crashGaps = new Set([
          'permitUnavailable',
          'targetChanged',
          'drainTimeout',
          'releaseTimeout',
          'custodyPending',
          'observationUnavailable',
          'drainFailed',
          'releaseFailed',
          'terminalCloseFailed',
        ]);
        expect(retired.uncertainty.every((gap) => crashGaps.has(gap))).toBe(true);
        f.expectedCrashReturns.set(`${receiver.browserId}:${receiver.browserGeneration}`, retired);
      }
      expect(receiver.isOrdinary()).toBe(false);
      const ownerPath = join(f.config.dataDir, 'reservations', profileId, 'owner.json');
      try {
        expect(JSON.parse(await readFile(ownerPath, 'utf8')).failure).toBe(mode);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        expect(retired.terminal.cleanup).toBe('observed');
      }
      await gone(
        f,
        snapshot.retainedIdentities
          .filter((value) => value.role !== 'manager')
          .map((value) => value.identity)
      );
      observed = true;
      await restart(f, opened, retired.terminal.cleanup === 'observed');
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      await finishFixture(f, mode, observed, failed, primary, controller);
    }
  },
  45000
);
