import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, onTestFinished } from 'vitest';
import { createDarwinEngineProcesses } from '../runtime/darwin-engine-processes.js';
import { validateJournalSnapshot } from '../lifecycle/process-journal.js';
import { constructOwnedBrowserEngine, type PrivateBrowserRetirementReceiver } from '../engine.js';
// Explicit local Chromium fixture input; never enabled by the default suite.
// eslint-disable-next-line no-restricted-syntax
const fixtureJSON = process.env.DORKOS_DARWIN_SUPERVISOR_FIXTURE;
async function originalEngineCampaign(continuous: boolean) {
  const originals: {
    home?: Promise<string>;
    shutdown?: ReturnType<typeof constructOwnedBrowserEngine>['shutdown'];
    closeListener?: () => Promise<void>;
  } = {};
  let root: string | undefined;
  let returned = false;
  let finalizedAdmission = false;
  const pendingReads = new Set<Promise<unknown>>();
  const retainRead = <T>(original: Promise<T>): Promise<T> => {
    pendingReads.add(original);
    void original.then(
      () => pendingReads.delete(original),
      (reason) => {
        failed(reason);
        pendingReads.delete(original);
      }
    );
    return original;
  };
  const admit = () => {
    if (finalizedAdmission) throw new Error('FIXTURE_FINALIZED');
  };
  const originalRead = <T>(produce: () => Promise<T>): Promise<T> => {
    admit();
    return retainRead(produce());
  };
  let firstFailure: { reason: unknown } | undefined;
  const failed = (reason: unknown) => {
    firstFailure ??= { reason };
  };
  let finalized: Promise<void> | undefined;
  const finalize = (): Promise<void> => {
    if (finalized) return finalized;
    finalizedAdmission = true;
    let resolve!: () => void, reject!: (reason: unknown) => void;
    finalized = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const duties: Promise<unknown>[] = [];
    try {
      if (originals.shutdown)
        duties.push(
          originals.shutdown().then((outcomes) => {
            returned &&= outcomes.every((outcome) => outcome.cleanup === 'observed');
          })
        );
    } catch (reason) {
      returned = false;
      failed(reason);
    }
    try {
      if (originals.closeListener) duties.push(originals.closeListener());
    } catch (reason) {
      returned = false;
      failed(reason);
    }
    if (originals.home)
      duties.push(
        originals.home.then((actual) => {
          root = actual;
        })
      );
    void Promise.allSettled(duties).then(async (results) => {
      while (pendingReads.size) {
        const reads = await Promise.allSettled([...pendingReads]);
        for (const read of reads)
          if (read.status === 'rejected') {
            returned = false;
            failed(read.reason);
          }
      }
      for (const result of results)
        if (result.status === 'rejected') {
          returned = false;
          failed(result.reason);
        }
      try {
        if (root && returned && !firstFailure) await rm(root, { recursive: true, force: true });
        else if (root) console.error('quarantined engine fixture', root);
      } catch (reason) {
        failed(reason);
      }
      if (firstFailure) reject(firstFailure.reason);
      else resolve();
    });
    return finalized;
  };
  // Registered before any home/listener/engine acquisition, including constructor and timeout paths.
  onTestFinished(finalize);
  const fixture = JSON.parse(await originalRead(() => readFile(fixtureJSON!, 'utf8'))) as {
    helper: string;
    worker: string;
    executable: string;
    executableSHA256: string;
  };
  admit();
  const homeOriginal = (originals.home = mkdtemp(join(tmpdir(), 'supervisor-engine-')).then(
    (created) => realpath(created)
  ));
  const campaignHome = await homeOriginal;
  root = campaignHome;
  admit();
  const artifactBytes = await originalRead(() => readFile(fixture.helper));
  admit();
  const artifact = {
    path: fixture.helper,
    sha256: createHash('sha256').update(artifactBytes).digest('hex'),
  };
  const require = createRequire(import.meta.url);
  admit();
  const server = createServer((_request, response) =>
    response.end('<title>Engine fixture</title><button>Owned page</button>')
  );
  const originalClose = server.close.bind(server);
  const listening = once(server, 'listening');
  let listenEntered = false;
  originals.closeListener = async () => {
    if (!listenEntered) return;
    if (!server.listening) await listening;
    await new Promise<void>((resolve, reject) =>
      originalClose((reason) => (reason ? reject(reason) : resolve()))
    );
  };
  listenEntered = true;
  server.listen(0, '127.0.0.1');
  await listening;
  admit();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_SERVER_UNAVAILABLE');
  const libraryRoot = await originalRead(() =>
    realpath(dirname(require.resolve('playwright-core/package.json')))
  );
  admit();
  let receiver: PrivateBrowserRetirementReceiver | undefined;
  const engine = constructOwnedBrowserEngine(
    {
      dataDir: campaignHome,
      runtime: {
        library: {
          package: 'playwright-core',
          version: '1.63.0',
          rootDir: libraryRoot,
          assets: { manifest: 'browsers.json', cli: 'cli.js' },
        },
        executable: {
          path: fixture.executable,
          sha256: fixture.executableSHA256,
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
        workerPath: new URL('../../dist/runtime/darwin-journal-worker.js', import.meta.url)
          .pathname,
        browserWorkerPath: fixture.worker,
        artifact,
        duration: 30000,
        ...(continuous ? { continuous: true } : {}),
        maxGap: 5000,
      },
    },
    {
      registerBirth(value) {
        receiver = value;
      },
      refuseBirth() {},
    }
  );
  originals.shutdown = engine.shutdown.bind(engine);
  const requestId = randomBytes(16).toString('base64url');
  try {
    admit();
    const opened = await engine.open({ kind: 'open', mode: 'ephemeral', requestId });
    admit();
    expect(engine.listTabs(opened.browserId, opened.browserGeneration)).toEqual([opened.tab]);
    expect(receiver!.isAuthorityCurrent()).toBe(true);
    expect(
      await engine.input({
        kind: 'input',
        requestId,
        binding: opened.tab,
        steps: [{ kind: 'keyDown', key: 'Shift' }],
      })
    ).toMatchObject({ outcome: 'completed' });
    expect(receiver!.isAuthorityCurrent()).toBe(true);
    const journalNames = await originalRead(() => readdir(join(campaignHome, 'journals')));
    expect(journalNames).toHaveLength(1);
    const journalPath = join(campaignHome, 'journals', journalNames[0]!, 'snapshot.json');
    let snapshot = validateJournalSnapshot(
      JSON.parse(await originalRead(() => readFile(journalPath, 'utf8')))
    );
    await expect
      .poll(async () => {
        snapshot = validateJournalSnapshot(
          JSON.parse(await originalRead(() => readFile(journalPath, 'utf8')))
        );
        return snapshot.root.kind;
      })
      .toBe('attributed');
    const native = createDarwinEngineProcesses(artifact);
    const browserRoot = snapshot.retainedIdentities.find((value) => value.role === 'root')!;
    const supervisor = snapshot.retainedIdentities.find(
      (value) => value.identity.pid === browserRoot.parent!.pid
    )!;
    expect(supervisor.parent).toEqual(snapshot.binding.manager);
    expect(await originalRead(() => native.identity(browserRoot.identity.pid))).toEqual(
      browserRoot.identity
    );
    expect(await originalRead(() => native.identity(supervisor.identity.pid))).toEqual(
      supervisor.identity
    );
    expect(
      await originalRead(() => native.attributeRoot(snapshot.binding.manager, supervisor.identity))
    ).toBe(true);
    expect(
      await originalRead(() => native.attributeRoot(supervisor.identity, browserRoot.identity))
    ).toBe(true);
    const profiles = await originalRead(() => readdir(join(campaignHome, 'ephemeral')));
    expect(profiles).toHaveLength(1);
    const profileDir = join(campaignHome, 'ephemeral', profiles[0]!);
    admit();
    const capture = await engine.capture({ kind: 'capture', requestId, binding: opened.tab });
    if (continuous) {
      const originalWindow = snapshot.observationWindow.endMonotonic;
      const originalRoot = { ...browserRoot.identity };
      // Actual native elapsed-time qualification, not an advanced fake clock or synthetic ACK.
      // The exact original engine/journal/campaign remains held until real source closure below.
      await new Promise<void>((resolve) => setTimeout(resolve, 31000));
      admit();
      expect(receiver!.isAuthorityCurrent()).toBe(true);
      const after = validateJournalSnapshot(
        JSON.parse(await originalRead(() => readFile(journalPath, 'utf8')))
      );
      expect(after.binding).toEqual(snapshot.binding);
      expect(after.writer).toEqual(snapshot.writer);
      expect(after.gaps).toEqual([]);
      expect(after.observationWindow.endMonotonic - originalWindow).toBeGreaterThan(30000);
      expect(after.retainedIdentities.find((value) => value.role === 'root')!.identity).toEqual(
        originalRoot
      );
      expect(await originalRead(() => native.identity(originalRoot.pid))).toEqual(originalRoot);
      admit();
      const laterCapture = await engine.capture({
        kind: 'capture',
        requestId: randomBytes(16).toString('base64url'),
        binding: opened.tab,
      });
      expect(laterCapture.receipt.binding).toEqual(opened.tab);
      expect(laterCapture.receipt.captureSequence).toBeGreaterThan(capture.receipt.captureSequence);
      expect(laterCapture.bytes.byteLength).toBe(laterCapture.receipt.byteLength);
      expect(receiver!.isAuthorityCurrent()).toBe(true);
    }
    expect(capture.receipt).toMatchObject({
      width: 1280,
      height: 720,
      format: 'jpeg',
      binding: opened.tab,
    });
    expect(Array.from(capture.bytes.subarray(0, 2))).toEqual([255, 216]);
    const outcome = await engine.close({
      kind: 'close',
      requestId,
      browserId: opened.browserId,
      browserGeneration: opened.browserGeneration,
    });
    if (outcome.cleanup !== 'observed') console.error('retirement', await receiver!.observation);
    expect(outcome).toMatchObject({ cleanup: 'observed' });
    expect(receiver!.isAuthorityCurrent()).toBe(false);
    returned = outcome.cleanup === 'observed';
    const finalSnapshot = validateJournalSnapshot(
      JSON.parse(await originalRead(() => readFile(journalPath, 'utf8')))
    );
    expect(finalSnapshot.phase).toBe('observation-ended');
    expect(
      finalSnapshot.retainedIdentities
        .filter((value) => value.role !== 'manager')
        .every((value) => value.lifecycle === 'dead' || value.lifecycle === 'replacement')
    ).toBe(true);
    expect(await originalRead(() => native.identity(browserRoot.identity.pid))).toBeNull();
    expect(await originalRead(() => native.identity(supervisor.identity.pid))).toBeNull();
    await originalRead(() =>
      writeFile(
        new URL('../../.temp/supervisor-engine-receipt.json', import.meta.url),
        JSON.stringify(
          {
            node: process.version,
            artifact,
            profileDir,
            executable: { path: fixture.executable, sha256: fixture.executableSHA256 },
            manager: snapshot.binding.manager,
            supervisor: supervisor.identity,
            root: browserRoot.identity,
            captureSHA256: createHash('sha256').update(capture.bytes).digest('hex'),
            cleanup: outcome.cleanup,
            recordedGaps: finalSnapshot.gaps,
            production: 'off',
            recoveryAuthority: false,
            ordinaryHeldInputCustody: 'known',
            retiredAuthorityCurrent: receiver!.isAuthorityCurrent(),
          },
          null,
          2
        ) + '\n'
      )
    );
  } catch (reason) {
    failed(reason);
  } finally {
    await finalize();
  }
  if (firstFailure) throw firstFailure.reason;
}
it.skipIf(!fixtureJSON || process.platform !== 'darwin')(
  'acquires and captures through the actual supervisor engine route, retaining durable identity through closure',
  () => originalEngineCampaign(false),
  40000
);
it.skipIf(!fixtureJSON || process.platform !== 'darwin')(
  'retains the same actual native campaign beyond 30 seconds and captures before original closure',
  () => originalEngineCampaign(true),
  // New 31-second native hold plus the original open/close budget; finite control stays 40s.
  90000
);
