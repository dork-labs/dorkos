import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { constants, writeSync } from 'node:fs';
import { lstat, open, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { expect, it, onTestFinished } from 'vitest';
import { authors, rooms, browserAttachments, createDb, runMigrations, type Db } from '@dorkos/db';
import type { InstallationConfiguration } from '@dorkos/browser/runtime-installation';
import type {
  BrowserLifecycleEngine,
  PrivateBrowserRetirementReceiver,
} from '@dorkos/browser/server-owner';
import { BrowserRegistry } from '../registry.js';
import { BrowserRegistryStore, type RegistryMode } from '../store.js';
import { ownRegistryFixtureCleanup } from './registry-fixture-cleanup.js';
import { emitRegistryFixtureReceipt } from './registry-fixture-receipt.js';

// Explicit fixture-owned installed files only. No ordinary-suite launch or implicit installation.
const supplied = process.env.DORKOS_BROWSER_REGISTRY_NATIVE_FIXTURE;
const heldNativeFixtures = new Set<object>();
const id = () => randomBytes(16).toString('base64url');

it.skipIf(!supplied || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'composes registry metadata with original native engine births, detach, stop and retained reopen',
  async () => {
    const cleanupCustody = ownRegistryFixtureCleanup();
    const pending = new Set<Promise<unknown>>();
    const readers = new Set<Awaited<ReturnType<typeof open>>>();
    const readerCloses = new Map<Awaited<ReturnType<typeof open>>, Promise<void>>();
    const engines: {
      engine: BrowserLifecycleEngine;
      receivers: PrivateBrowserRetirementReceiver[];
      shutdown?: Promise<readonly unknown[]>;
    }[] = [];
    const sockets = new Set<Socket>();
    const socketClosed = new Map<Socket, Promise<void>>();
    const socketCloses = new Map<Socket, Promise<void>>();
    const listeners = new Set<object>();
    let issued = 0,
      unknown = false,
      endpointClosed = false;
    let home: string | undefined, homeIdentity: { dev: bigint; ino: bigint } | undefined;
    const homeRemoval = {
      original: undefined as Promise<void> | undefined,
      state: 'notAttempted' as 'notAttempted' | 'observed' | 'unverified',
    };
    let db: Db | undefined,
      primaryFailed = false,
      primary: unknown;
    const reports: { prior: string | null; marker: string }[] = [];
    let requests = 0,
      seed = 'retained',
      births = 0;
    const owner = {
      cleanupCustody,
      database: () => db,
      pending,
      readers,
      readerCloses,
      engines,
      sockets,
      socketClosed,
      socketCloses,
      listeners,
      homeRemoval,
      home: () => home,
    };
    heldNativeFixtures.add(owner); // Custody before the first fallible acquisition.
    let finishPromise: Promise<void> | undefined,
      bodyCleanupEntered = false,
      receiptWritten = false;
    const receipts: { browserId: string; generation: number; mode: string; cleanup: string }[] = [];
    onTestFinished(async () => {
      if (!bodyCleanupEntered) unknown = true; // Runner deadline does not cancel the producer.
      await finish();
    });
    async function call<T>(
      start: () => Promise<T>,
      milliseconds = 2000,
      cleanup = false
    ): Promise<T> {
      if (!cleanup && cleanupCustody.isStopping()) throw new Error('REGISTRY_FIXTURE_FINALIZING');
      if (++issued > 160 || pending.size >= 16) {
        unknown = true;
        throw new Error('REGISTRY_FIXTURE_CALL_CAP');
      }
      // Register the genuine promise before entering its SDK/filesystem operation.
      const original = Promise.resolve().then(() => {
        if (!cleanup && cleanupCustody.isStopping()) throw new Error('REGISTRY_FIXTURE_FINALIZING');
        return start();
      });
      pending.add(original);
      void original.then(
        () => pending.delete(original),
        () => pending.delete(original)
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          original,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              unknown = true;
              reject(new Error('REGISTRY_FIXTURE_OPERATION_HELD'));
            }, milliseconds);
          }),
        ]);
        if (!cleanup && cleanupCustody.isStopping()) throw new Error('REGISTRY_FIXTURE_FINALIZING');
        return result;
      } finally {
        clearTimeout(timer);
      }
    }
    async function smallFile(file: string, cap: number): Promise<Buffer> {
      const named = await call(() => lstat(file, { bigint: true }));
      if (!named.isFile() || named.size > BigInt(cap))
        throw new Error('REGISTRY_FIXTURE_FILE_REFUSED');
      const reader = await call(async () => {
        const actual = await open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        readers.add(actual);
        cleanupCustody.adopt(actual, () => closeReader(actual));
        return actual;
      });
      let failed = false,
        first: unknown,
        result: Buffer | undefined;
      try {
        const before = await call(() => reader.stat({ bigint: true }));
        if (before.dev !== named.dev || before.ino !== named.ino || before.size !== named.size)
          throw new Error('REGISTRY_FIXTURE_FILE_CHANGED');
        const bytes = Buffer.alloc(cap + 1);
        let count = 0;
        while (count < bytes.length) {
          const read = await call(() => reader.read(bytes, count, bytes.length - count, count));
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        const after = await call(() => reader.stat({ bigint: true }));
        if (
          count > cap ||
          BigInt(count) !== before.size ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw new Error('REGISTRY_FIXTURE_FILE_CHANGED');
        result = bytes.subarray(0, count);
      } catch (error) {
        failed = true;
        first = error;
      }
      try {
        await closeReader(reader);
      } catch (error) {
        if (!failed) first = error;
        failed = true;
      }
      if (failed) throw first;
      return result!;
    }
    async function closeReader(reader: Awaited<ReturnType<typeof open>>): Promise<void> {
      let original = readerCloses.get(reader);
      if (!original) {
        original = Promise.resolve().then(async () => {
          await reader.close();
          readers.delete(reader);
        });
        readerCloses.set(reader, original);
      }
      await call(() => original!, 2000, true);
    }
    const origin = createServer((request, response) => {
      requests++;
      if (requests > 64 || unknown) {
        unknown = true;
        response.writeHead(503).end();
        return;
      }
      response.setHeader('connection', 'close');
      response.setHeader('cache-control', 'no-store');
      const url = new URL(request.url ?? '/', 'http://fixture.invalid');
      if (url.pathname === '/report') {
        const encoded = url.searchParams.get('value');
        if (!encoded || encoded.length > 256 || reports.length >= 8) {
          unknown = true;
          response.writeHead(400).end();
          return;
        }
        try {
          const value = JSON.parse(encoded) as { prior: unknown; marker: unknown };
          if (
            (value.prior !== null && !['retained', 'clean'].includes(String(value.prior))) ||
            !['retained', 'clean'].includes(String(value.marker))
          )
            throw new Error('REPORT_REFUSED');
          reports.push({ prior: value.prior as string | null, marker: value.marker as string });
          response.end('observed');
        } catch {
          unknown = true;
          response.writeHead(400).end();
        }
        return;
      }
      response.end(`<title>Registry fixture</title><link rel="icon" href="data:,"><input value="fixture"><script>
        const prior=localStorage.getItem('registry-fixture');
        localStorage.setItem('registry-fixture',${JSON.stringify(seed)});
        fetch('/report?value='+encodeURIComponent(JSON.stringify({prior,marker:localStorage.getItem('registry-fixture')})),{cache:'no-store'}).then(response=>response.text());
      </script>`);
    });
    const endpoint = { original: origin, close: undefined as Promise<void> | undefined };
    listeners.add(endpoint);
    cleanupCustody.adopt(endpoint, async () => {
      endpoint.close ??= Promise.resolve().then(
        () =>
          new Promise<void>((resolve, reject) =>
            origin.close((error) => (error ? reject(error) : resolve()))
          )
      );
      await call(
        async () => {
          await endpoint.close!;
          await Promise.all(socketClosed.values());
          endpointClosed = true;
          listeners.delete(endpoint);
        },
        2000,
        true
      );
    });
    origin.on('error', () => {
      unknown = true;
    });
    origin.on('connection', (socket) => {
      const closed = new Promise<void>((resolve) =>
        socket.once('close', () => {
          sockets.delete(socket);
          resolve();
        })
      );
      sockets.add(socket);
      socketClosed.set(socket, closed);
      cleanupCustody.adopt(socket, async () => {
        let original = socketCloses.get(socket);
        if (!original) {
          original = Promise.resolve().then(async () => {
            socket.destroy();
            await closed;
          });
          socketCloses.set(socket, original);
        }
        await call(() => original!, 2000, true);
      });
      socket.on('error', () => {
        unknown = true;
      });
      if (socketClosed.size > 16) {
        unknown = true;
        socket.destroy();
      }
    });
    try {
      const input = JSON.parse((await smallFile(supplied!, 16384)).toString('utf8')) as {
        installation: InstallationConfiguration;
      };
      const { createRuntimeInstallation } = await call(
        () => import('@dorkos/browser/runtime-installation')
      );
      const installation = createRuntimeInstallation(input.installation);
      const installed = await call(() => installation.inspectExisting(), 20000);
      if (
        installed.state !== 'installed-files' ||
        installed.lastFreshVerifiedVersion !== '153.0.8010.12'
      )
        throw new Error('REGISTRY_OWN_INSTALLED_FILES_REQUIRED');
      const require = createRequire(import.meta.url);
      const packageRoot = await call(() =>
        realpath(dirname(dirname(require.resolve('@dorkos/browser'))))
      );
      const browserRequire = createRequire(join(packageRoot, 'package.json'));
      const libraryRoot = await call(() =>
        realpath(dirname(browserRequire.resolve('playwright-core/package.json')))
      );
      if (libraryRoot !== (await call(() => realpath(input.installation.libraryRoot))))
        throw new Error('REGISTRY_OWN_LIBRARY_REQUIRED');
      const helper = join(packageRoot, 'dist/runtime/native/darwin-process-observer');
      const helperSHA256 = createHash('sha256')
        .update(await smallFile(helper, 4 * 1024 * 1024))
        .digest('hex');
      const executable = join(
        input.installation.cacheRoot,
        'candidates',
        installed.installationId,
        'payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      );
      await call(async () => {
        home = await mkdtemp(join(tmpdir(), 'browser-registry-native-'));
      });
      homeIdentity = await call(() => lstat(home!, { bigint: true }));
      const canonical = await call(() => realpath(home!));
      const canonicalIdentity = await call(() => lstat(canonical, { bigint: true }));
      if (canonicalIdentity.dev !== homeIdentity.dev || canonicalIdentity.ino !== homeIdentity.ino)
        throw new Error('REGISTRY_HOME_IDENTITY_REQUIRED');
      home = canonical;
      const listen = new Promise<void>((resolve, reject) => {
        origin.once('listening', resolve);
        origin.once('error', reject);
      });
      await call(async () => {
        origin.listen(0, '127.0.0.1');
        await listen;
      });
      const address = origin.address();
      if (!address || typeof address === 'string') throw new Error('REGISTRY_ORIGIN_REQUIRED');
      db = createDb(join(home, 'metadata.sqlite'));
      runMigrations(db);
      db.insert(authors)
        .values(
          ['alice', 'bob'].map((author) => ({
            id: author,
            kind: 'human' as const,
            naturalKey: `native-fixture:${author}`,
            displayName: author,
            createdAt: new Date().toISOString(),
          }))
        )
        .run();
      const roomId = id();
      db.insert(rooms)
        .values({
          id: roomId,
          kind: 'channel',
          slug: 'registry-fixture',
          title: 'Fixture',
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
        })
        .run();
      let store = new BrowserRegistryStore(db, id());
      let registry = new BrowserRegistry(
        store,
        (author, target) =>
          author === 'alice' && (target.kind === 'session' || target.roomId === roomId)
      );
      const profile = store.createProfile('alice', 'Native fixture');
      const { constructOwnedBrowserEngine } = await call(
        () => import('@dorkos/browser/server-owner')
      );
      const configuration = {
        dataDir: join(home, 'browser'),
        runtime: {
          library: {
            package: 'playwright-core',
            version: '1.63.0',
            rootDir: libraryRoot,
            assets: { manifest: 'browsers.json', cli: 'cli.js' },
          },
          executable: {
            path: executable,
            sha256: installed.executableSHA256,
            revision: '1243',
            version: '153.0.8010.12',
            platform: 'darwin',
            arch: 'arm64',
          },
          identity: { mode: 'native', policyRevision: 1 },
        },
        network: { kind: 'fixture', origin: `http://127.0.0.1:${address.port}` },
        clock: { monotonicNow: () => performance.now(), wallNow: () => Date.now() },
        processes: {
          observe: async () => ({ status: 'unknown' }),
          descendants: async () => ({ status: 'unknown', identities: [] }),
        },
        policy: {
          authorizeAction: async () => 'allowed',
          verifyBrokerLease: async () => 'unknown',
        },
        nativeJournal: {
          workerPath: join(packageRoot, 'dist/runtime/darwin-journal-worker.js'),
          browserWorkerPath: join(packageRoot, 'dist/runtime/darwin-supervisor-worker.js'),
          artifact: { path: helper, sha256: helperSHA256 },
          duration: 30000,
          maxGap: 5000,
        },
      };
      const cohort = (mode: RegistryMode) => {
        if (cleanupCustody.isStopping()) throw new Error('REGISTRY_FIXTURE_FINALIZING');
        const receivers: PrivateBrowserRetirementReceiver[] = [];
        const birthOwner = registry.birthOwner('alice', mode);
        const engine = constructOwnedBrowserEngine(configuration, {
          registerBirth(receiver) {
            receivers.push(receiver);
            births++;
            birthOwner.registerBirth(receiver);
            expect(
              registry.instance('alice', receiver.browserId, receiver.browserGeneration).status
            ).toBe('opening');
            expect(receiver.isAuthorityCurrent()).toBe(false);
          },
          refuseBirth(receiver) {
            birthOwner.refuseBirth(receiver);
          },
        });
        const member = {
          engine,
          receivers,
          shutdown: undefined as Promise<readonly unknown[]> | undefined,
        };
        engines.push(member); // Exact original engine owned before its first open.
        cleanupCustody.adopt(member, async () => {
          member.shutdown ??= Promise.resolve().then(() => member.engine.shutdown());
          await call(
            async () => {
              const result = (await member.shutdown!) as readonly {
                browserId?: string;
                browserGeneration?: number;
                cleanup?: string;
              }[];
              if (
                result.length !== member.receivers.length ||
                member.receivers.some(
                  (receiver) =>
                    !result.some(
                      (row) =>
                        row.browserId === receiver.browserId &&
                        row.browserGeneration === receiver.browserGeneration &&
                        row.cleanup === 'observed'
                    )
                )
              )
                throw new Error('REGISTRY_NATIVE_CLEANUP_UNOBSERVED');
              const observations = await Promise.all(
                member.receivers.map((receiver) => receiver.observation)
              );
              if (
                observations.some(
                  (value) =>
                    value.terminal.cleanup !== 'observed' ||
                    value.cleanup.state !== 'settled' ||
                    value.cleanup.coverage !== 'closed' ||
                    value.cleanup.pending ||
                    value.uncertainty.length > 0
                )
              )
                throw new Error('REGISTRY_RETIREMENT_CLEANUP_UNOBSERVED');
            },
            5000,
            true
          );
        });
        return member;
      };
      const stop = async (
        member: ReturnType<typeof cohort>,
        opened: Awaited<ReturnType<BrowserLifecycleEngine['open']>>
      ) => {
        const receiver = member.receivers.find(
          (value) =>
            value.browserId === opened.browserId &&
            value.browserGeneration === opened.browserGeneration
        )!;
        registry.stop('alice', opened.browserId, opened.browserGeneration);
        const observation = await call(() => receiver.observation, 5000);
        expect(observation.terminal.cleanup).toBe('observed');
        expect(observation.cleanup).toEqual({
          state: 'settled',
          coverage: 'closed',
          pending: false,
          uncertainty: [],
        });
        expect(observation.uncertainty).toEqual([]);
        expect(registry.instance('alice', opened.browserId, opened.browserGeneration).status).toBe(
          'stopped'
        );
        expect(() => member.engine.listTabs(opened.browserId, opened.browserGeneration)).toThrow();
        receipts.push({
          browserId: opened.browserId,
          generation: opened.browserGeneration,
          mode: opened.mode,
          cleanup: observation.terminal.cleanup,
        });
      };
      const capture = async (
        member: ReturnType<typeof cohort>,
        opened: Awaited<ReturnType<BrowserLifecycleEngine['open']>>
      ) => {
        expect(member.receivers[0]!.isAuthorityCurrent()).toBe(true);
        expect(registry.instance('alice', opened.browserId, opened.browserGeneration).status).toBe(
          'running'
        );
        const image = await call(
          () => member.engine.capture({ kind: 'capture', requestId: id(), binding: opened.tab }),
          5000
        );
        expect(image.receipt.binding).toEqual(opened.tab);
        expect(image.bytes.length).toBeGreaterThan(0);
      };
      const retained = cohort({ mode: 'persistent', profileId: profile.profileId });
      const first = await call(
        () =>
          retained.engine.open({
            kind: 'open',
            requestId: id(),
            mode: 'persistent',
            profileId: profile.profileId,
          }),
        15000
      );
      await expect.poll(() => reports.length, { timeout: 3000 }).toBe(1);
      expect(reports[0]).toEqual({ prior: null, marker: 'retained' });
      await capture(retained, first);
      expect(store.profiles('alice')[0]!.status).toBe('inUse');
      expect(() => registry.instance('bob', first.browserId, first.browserGeneration)).toThrow(
        'inaccessible'
      );
      const attachment = registry.attach('alice', first.browserId, first.browserGeneration, {
        kind: 'session',
        sessionId: id(),
      });
      expect(() => registry.detach('bob', attachment)).toThrow('inaccessible');
      registry.detach('alice', attachment);
      expect(db.select().from(browserAttachments).get()?.detachedAt).not.toBeNull();
      expect(retained.receivers[0]!.isAuthorityCurrent()).toBe(true);
      await capture(retained, first); // Detach did not stop or replace the original Page.
      await stop(retained, first);
      expect(store.profiles('alice')[0]!.status).toBe('available');
      seed = 'clean';
      const beforeClean = store.profiles('alice');
      const clean = cohort({ mode: 'ephemeral' });
      const second = await call(
        () => clean.engine.open({ kind: 'open', requestId: id(), mode: 'ephemeral' }),
        15000
      );
      await expect.poll(() => reports.length, { timeout: 3000 }).toBe(2);
      expect(reports[1]).toEqual({ prior: null, marker: 'clean' });
      await capture(clean, second);
      expect(store.profiles('alice')).toEqual(beforeClean);
      const roomAttachment = registry.attach('alice', second.browserId, second.browserGeneration, {
        kind: 'room',
        roomId,
      });
      registry.detach('alice', roomAttachment);
      await stop(clean, second);
      db.$client.close();
      db = createDb(join(home, 'metadata.sqlite'));
      runMigrations(db);
      store = new BrowserRegistryStore(db, id());
      registry = new BrowserRegistry(store, (author) => author === 'alice');
      expect(registry.instance('alice', first.browserId, first.browserGeneration).status).toBe(
        'stopped'
      );
      expect(registry.instance('alice', second.browserId, second.browserGeneration).status).toBe(
        'stopped'
      );
      seed = 'retained';
      const reopened = cohort({ mode: 'persistent', profileId: profile.profileId });
      const third = await call(
        () =>
          reopened.engine.open({
            kind: 'open',
            requestId: id(),
            mode: 'persistent',
            profileId: profile.profileId,
          }),
        15000
      );
      await expect.poll(() => reports.length, { timeout: 3000 }).toBe(3);
      expect(reports[2]).toEqual({ prior: 'retained', marker: 'retained' });
      await capture(reopened, third);
      expect(new Set([first.browserId, second.browserId, third.browserId]).size).toBe(3);
      expect(new Set([first.tab.tabId, second.tab.tabId, third.tab.tabId]).size).toBe(3);
      await stop(reopened, third);
      expect(store.profiles('alice')[0]!.status).toBe('available');
      expect(births).toBe(3);
    } catch (error) {
      primaryFailed = true;
      primary = error;
    }
    bodyCleanupEntered = true;
    await finish();
    function finish(): Promise<void> {
      if (finishPromise) return finishPromise;
      const originalCleanup = cleanupCustody.finish(5000); // Fence producer admission synchronously.
      finishPromise = Promise.resolve().then(async () => {
        const closed = await originalCleanup;
        if (closed.held || cleanupCustody.snapshot().held) unknown = true;
        if (closed.failed && !primaryFailed) {
          primaryFailed = true;
          primary = closed.first;
        }
        // Do not close the DB while an original producer/retirement may still write through it.
        if (pending.size === 0 && cleanupCustody.snapshot().pending === 0) {
          try {
            if (db?.$client.open) db.$client.close();
          } catch (error) {
            unknown = true;
            if (!primaryFailed) {
              primaryFailed = true;
              primary = error;
            }
          }
        }
        const healthy =
          !unknown &&
          pending.size === 0 &&
          readers.size === 0 &&
          sockets.size === 0 &&
          endpointClosed;
        if (healthy && !primaryFailed && home && homeIdentity) {
          try {
            const actual = await call(() => lstat(home!, { bigint: true }), 2000, true);
            if (actual.dev !== homeIdentity.dev || actual.ino !== homeIdentity.ino)
              throw new Error('REGISTRY_HOME_CHANGED');
            homeRemoval.state = 'unverified';
            homeRemoval.original ??= Promise.resolve().then(() =>
              rm(home!, { recursive: true, force: true })
            );
            await call(() => homeRemoval.original!, 2000, true);
            homeRemoval.state = 'observed';
          } catch (error) {
            unknown = true;
            if (!primaryFailed) {
              primaryFailed = true;
              primary = error;
            }
          }
        }
        if (
          !unknown &&
          pending.size === 0 &&
          readers.size === 0 &&
          sockets.size === 0 &&
          endpointClosed
        )
          heldNativeFixtures.delete(owner);
        if (!receiptWritten) {
          receiptWritten = true;
          const result = emitRegistryFixtureReceipt(
            { failed: primaryFailed, first: primary },
            () =>
              JSON.stringify({
                fixture: 'REGISTRY_NATIVE_ACCEPTANCE',
                births,
                reports: reports.length,
                requests,
                retainedBrowserId: receipts[0]?.browserId ?? null,
                retainedGeneration: receipts[0]?.generation ?? null,
                cleanBrowserId: receipts[1]?.browserId ?? null,
                cleanGeneration: receipts[1]?.generation ?? null,
                reopenedBrowserId: receipts[2]?.browserId ?? null,
                reopenedGeneration: receipts[2]?.generation ?? null,
                observations: receipts.length,
                cleanupObserved: !unknown && heldNativeFixtures.size === 0,
                pending: pending.size,
                heldReaders: readers.size,
                heldSockets: sockets.size,
                heldFixtures: heldNativeFixtures.size,
                homeRemoval: homeRemoval.state,
                home: home ?? null,
              }) + '\n',
            (line) => writeSync(1, line)
          );
          primaryFailed = result.failed;
          primary = result.first;
        }
      });
      return finishPromise;
    }
    if (primaryFailed) throw primary;
    expect(heldNativeFixtures.size).toBe(0);
    expect(receipts).toHaveLength(3);
    expect(requests).toBeGreaterThan(0);
  },
  90000
);
