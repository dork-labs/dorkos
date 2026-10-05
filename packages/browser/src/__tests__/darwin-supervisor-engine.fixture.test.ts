import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createDarwinEngineProcesses } from '../runtime/darwin-engine-processes.js';
import { validateJournalSnapshot } from '../lifecycle/process-journal.js';
import { constructOwnedBrowserEngine, type PrivateBrowserRetirementReceiver } from '../engine.js';
// Explicit local Chromium fixture input; never enabled by the default suite.
// eslint-disable-next-line no-restricted-syntax
const fixtureJSON = process.env.DORKOS_DARWIN_SUPERVISOR_FIXTURE;
it.skipIf(!fixtureJSON || process.platform !== 'darwin')(
  'acquires and captures through the actual supervisor engine route, retaining durable identity through closure',
  async () => {
    const fixture = JSON.parse(await readFile(fixtureJSON!, 'utf8')) as {
      helper: string;
      worker: string;
      executable: string;
      executableSHA256: string;
    };
    const root = await realpath(await mkdtemp(join(tmpdir(), 'supervisor-engine-')));
    const artifact = {
      path: fixture.helper,
      sha256: createHash('sha256')
        .update(await readFile(fixture.helper))
        .digest('hex'),
    };
    const require = createRequire(import.meta.url);
    const server = createServer((_request, response) =>
      response.end('<title>Engine fixture</title><button>Owned page</button>')
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('FIXTURE_SERVER_UNAVAILABLE');
    let receiver: PrivateBrowserRetirementReceiver | undefined;
    const engine = constructOwnedBrowserEngine(
      {
        dataDir: root,
        runtime: {
          library: {
            package: 'playwright-core',
            version: '1.63.0',
            rootDir: await realpath(dirname(require.resolve('playwright-core/package.json'))),
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
    const requestId = randomBytes(16).toString('base64url');
    let returned = false;
    try {
      const opened = await engine.open({ kind: 'open', mode: 'ephemeral', requestId });
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
      const journalNames = await readdir(join(root, 'journals'));
      expect(journalNames).toHaveLength(1);
      const journalPath = join(root, 'journals', journalNames[0]!, 'snapshot.json');
      let snapshot = validateJournalSnapshot(JSON.parse(await readFile(journalPath, 'utf8')));
      await expect
        .poll(async () => {
          snapshot = validateJournalSnapshot(JSON.parse(await readFile(journalPath, 'utf8')));
          return snapshot.root.kind;
        })
        .toBe('attributed');
      const native = createDarwinEngineProcesses(artifact);
      const browserRoot = snapshot.retainedIdentities.find((value) => value.role === 'root')!;
      const supervisor = snapshot.retainedIdentities.find(
        (value) => value.identity.pid === browserRoot.parent!.pid
      )!;
      expect(supervisor.parent).toEqual(snapshot.binding.manager);
      expect(await native.identity(browserRoot.identity.pid)).toEqual(browserRoot.identity);
      expect(await native.identity(supervisor.identity.pid)).toEqual(supervisor.identity);
      expect(await native.attributeRoot(snapshot.binding.manager, supervisor.identity)).toBe(true);
      expect(await native.attributeRoot(supervisor.identity, browserRoot.identity)).toBe(true);
      const profiles = await readdir(join(root, 'ephemeral'));
      expect(profiles).toHaveLength(1);
      const profileDir = join(root, 'ephemeral', profiles[0]!);
      const capture = await engine.capture({ kind: 'capture', requestId, binding: opened.tab });
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
        JSON.parse(await readFile(journalPath, 'utf8'))
      );
      expect(finalSnapshot.phase).toBe('observation-ended');
      expect(
        finalSnapshot.retainedIdentities
          .filter((value) => value.role !== 'manager')
          .every((value) => value.lifecycle === 'dead' || value.lifecycle === 'replacement')
      ).toBe(true);
      expect(await native.identity(browserRoot.identity.pid)).toBeNull();
      expect(await native.identity(supervisor.identity.pid)).toBeNull();
      await writeFile(
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
      );
    } finally {
      const outcomes = await engine.shutdown();
      returned &&= outcomes.every((outcome) => outcome.cleanup === 'observed');
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (returned) await rm(root, { recursive: true, force: true });
      else console.error('quarantined engine fixture', root, outcomes);
    }
  },
  40000
);
