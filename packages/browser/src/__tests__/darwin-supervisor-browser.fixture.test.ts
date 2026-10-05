import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import type { ProcessIdentity } from '../configuration.js';
import { expect, it } from 'vitest';
import { startDarwinSupervisorClient } from '../runtime/darwin-supervisor-client.js';
import { createDarwinEngineProcesses } from '../runtime/darwin-engine-processes.js';
// Explicit private fixture input; no browser download, accounts, paid inference or default test effects.
// eslint-disable-next-line no-restricted-syntax
const fixtureJSON = process.env.DORKOS_DARWIN_SUPERVISOR_FIXTURE;
it.skipIf(!fixtureJSON || process.platform !== 'darwin')(
  'real owned Chromium endpoint, page RPC and original closure',
  async () => {
    const fixture = JSON.parse(await readFile(fixtureJSON!, 'utf8')) as {
      helper: string;
      worker: string;
      executable: string;
      executableSHA256: string;
    };
    const artifact = {
      path: fixture.helper,
      sha256: createHash('sha256')
        .update(await readFile(fixture.helper))
        .digest('hex'),
    };
    const native = createDarwinEngineProcesses(artifact),
      manager = await native.identity(process.pid);
    if (!manager) throw new Error('FIXTURE_MANAGER_UNAVAILABLE');
    const profileDir = await realpath(await mkdtemp(join(tmpdir(), 'supervised-chromium-')));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end('<title>Owned fixture</title>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('FIXTURE_SERVER_UNAVAILABLE');
    let client: Awaited<ReturnType<typeof startDarwinSupervisorClient>> | undefined;
    try {
      const require = createRequire(import.meta.url);
      client = await startDarwinSupervisorClient({
        workerPath: fixture.worker,
        browserId: 'fixture_chromium',
        generation: 0,
        reservationNonce: randomUUID(),
        manager,
        artifact,
        profileDir,
        origin: `http://127.0.0.1:${address.port}`,
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
      });
      expect(await native.identity(client.reportedRoot.pid)).toEqual(client.reportedRoot);
      const tabs = (await client.list()) as { tab: number; url: string }[];
      expect(tabs.length).toBeGreaterThan(0);
      await client.navigate(tabs[0]!.tab, `http://127.0.0.1:${address.port}/`);
      expect(await client.close()).toEqual({ pending: false, uncertain: false });
      expect(await native.identity(client.reportedRoot.pid)).toBeNull();
    } catch (error) {
      console.error({ requests, diagnostics: client?.diagnostics() });
      throw error;
    } finally {
      const custody = client ? await client.close() : { pending: true, uncertain: true };
      if (custody.pending || custody.uncertain)
        console.error({ custody, diagnostics: client?.diagnostics() });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!custody.pending && !custody.uncertain)
        await rm(profileDir, { recursive: true, force: true });
    }
  },
  30000
);

it.skipIf(!fixtureJSON || process.platform !== 'darwin')(
  'controller death closes supervisor-owned real context, proxy and original Chromium',
  async () => {
    const fixture = JSON.parse(await readFile(fixtureJSON!, 'utf8')) as {
      helper: string;
      worker: string;
      executable: string;
      executableSHA256: string;
    };
    const artifact = {
      path: fixture.helper,
      sha256: createHash('sha256')
        .update(await readFile(fixture.helper))
        .digest('hex'),
    };
    const native = createDarwinEngineProcesses(artifact);
    const profileDir = await realpath(await mkdtemp(join(tmpdir(), 'supervised-crash-')));
    const require = createRequire(import.meta.url);
    const seed = {
      workerPath: fixture.worker,
      browserId: 'fixture_death',
      generation: 0,
      reservationNonce: randomUUID(),
      artifact,
      profileDir,
      origin: 'http://127.0.0.1:1234',
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
    };
    const seedPath = join(profileDir, 'fixture-seed.json'),
      controllerPath = join(profileDir, 'controller.cjs');
    await writeFile(seedPath, JSON.stringify(seed), { mode: 0o600 });
    const clientModule = new URL('../../dist/runtime/darwin-supervisor-client.js', import.meta.url)
      .href;
    const nativeModule = new URL('../../dist/runtime/darwin-engine-processes.js', import.meta.url)
      .href;
    await writeFile(
      controllerPath,
      `(async()=>{
    const fs=require('node:fs/promises'); const seed=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
    const {createDarwinEngineProcesses}=await import(${JSON.stringify(nativeModule)});
    const {startDarwinSupervisorClient}=await import(${JSON.stringify(clientModule)});
    seed.manager=await createDarwinEngineProcesses(seed.artifact).identity(process.pid);
    const client=await startDarwinSupervisorClient(seed);
    process.on('message',async()=>{await client.close(); if(process.connected)process.disconnect();});
    process.send({root:client.reportedRoot,supervisor:client.reportedSupervisor,proxy:client.reportedProxyURL});
  })().catch(error=>{console.error(error);process.exitCode=1;if(process.connected)process.disconnect();});`,
      { mode: 0o600 }
    );
    const controller = spawn(process.execPath, [controllerPath, seedPath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const terminal = once(controller, 'close'),
      ready = once(controller, 'message');
    const drains = Promise.all(
      [controller.stdout!, controller.stderr!].map(async (stream) => {
        let bytes = 0;
        for await (const chunk of stream) {
          bytes += Buffer.byteLength(chunk);
          expect(bytes).toBeLessThan(65536);
        }
      })
    );
    let killed = false,
      returned = false;
    try {
      await once(controller, 'spawn');
      const [message] = await ready;
      const facts = message as {
        root: ProcessIdentity;
        supervisor: ProcessIdentity;
        proxy: string;
      };
      expect(await native.identity(facts.root.pid)).toEqual(facts.root);
      expect(await native.identity(facts.supervisor.pid)).toEqual(facts.supervisor);
      const tree = await native.processes.descendants(facts.root, new AbortController().signal);
      expect(tree.status).toBe('complete');
      const proxy = new URL(facts.proxy);
      await new Promise<void>((resolve, reject) => {
        const socket = connect(Number(proxy.port), '127.0.0.1');
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
      });
      expect(controller.kill('SIGKILL')).toBe(true);
      killed = true;
      await terminal;
      await drains;
      const end = performance.now() + 10000;
      do {
        const statuses = await Promise.all(
          [...tree.identities, facts.supervisor].map((identity) =>
            native.processes.observe(identity, new AbortController().signal)
          )
        );
        if (statuses.every((value) => value.status === 'dead')) {
          returned = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (performance.now() < end);
      expect(returned).toBe(true);
      await new Promise<void>((resolve, reject) => {
        const socket = connect(Number(proxy.port), '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          reject(new Error('proxy survived controller death'));
        });
        socket.once('error', (error: NodeJS.ErrnoException) =>
          error.code === 'ECONNREFUSED' ? resolve() : reject(error)
        );
      });
    } finally {
      if (!killed && controller.connected) controller.send({ kind: 'close' });
      await terminal;
      await drains;
      if (returned) await rm(profileDir, { recursive: true, force: true });
    }
  },
  30000
);
