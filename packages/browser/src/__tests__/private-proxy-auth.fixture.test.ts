import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { startDarwinSupervisorClient } from '../runtime/darwin-supervisor-client.js';
import { createDarwinEngineProcesses } from '../runtime/darwin-engine-processes.js';
import { verifiedLibrary } from '../runtime/public-library.js';
// eslint-disable-next-line no-restricted-syntax
const fixtureJSON = process.env.DORKOS_DARWIN_SUPERVISOR_FIXTURE;
it.skipIf(!fixtureJSON || process.platform !== 'darwin')(
  'real private proxy auth refuses upstream credentials and owns service worker targets',
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
    const profileDir = await realpath(await mkdtemp(join(tmpdir(), 'private-proxy-auth-')));
    const credentials = { username: 'dorkos', password: randomUUID() };
    let upstreamAuthorization = 0;
    let leaked = 0,
      authenticated = 0,
      challenged = 0,
      workerFetched = 0;
    const origin = createServer((incoming, response) => {
      if (incoming.headers['proxy-authorization'] || incoming.headers.authorization) leaked++;
      if (incoming.url === '/upstream-auth') {
        response.writeHead(401, { 'www-authenticate': 'Basic realm="upstream"' }).end('refused');
        return;
      }
      if (incoming.url === '/sw.js') {
        response.setHeader('content-type', 'application/javascript');
        response.end(
          "self.addEventListener('install',e=>e.waitUntil(fetch('/worker-fetch')));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));"
        );
        return;
      }
      if (incoming.url === '/worker-fetch') workerFetched++;
      response.end('<title>Private authentication fixture</title>');
    });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const originAddress = origin.address();
    if (!originAddress || typeof originAddress === 'string')
      throw new Error('FIXTURE_ORIGIN_UNAVAILABLE');
    const originURL = `http://127.0.0.1:${originAddress.port}`;
    const expected = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
    const broker = createServer((incoming, response) => {
      if (incoming.headers.authorization !== undefined) upstreamAuthorization++;
      if (incoming.headers['proxy-authorization'] !== expected) {
        challenged++;
        response.writeHead(407, { 'proxy-authenticate': 'Basic realm="owned-proxy"' }).end();
        return;
      }
      authenticated++;
      const target = new URL(incoming.url!);
      if (target.origin !== originURL) {
        response.writeHead(403).end();
        return;
      }
      const headers = { ...incoming.headers };
      delete headers['proxy-authorization'];

      const outgoing = request(
        target,
        { method: incoming.method, headers, agent: false },
        (upstream) => {
          response.writeHead(upstream.statusCode!, upstream.headers);
          upstream.pipe(response);
        }
      );
      outgoing.once('error', () => response.destroy());
      incoming.pipe(outgoing);
    });
    broker.listen(0, '127.0.0.1');
    await once(broker, 'listening');
    const address = broker.address();
    if (!address || typeof address === 'string') throw new Error('FIXTURE_BROKER_UNAVAILABLE');
    const require = createRequire(import.meta.url);
    const runtime = {
      library: {
        package: 'playwright-core' as const,
        version: '1.63.0' as const,
        rootDir: await realpath(dirname(require.resolve('playwright-core/package.json'))),
        assets: { manifest: 'browsers.json' as const, cli: 'cli.js' as const },
      },
      executable: {
        path: fixture.executable,
        sha256: fixture.executableSHA256,
        revision: '1243',
        version: '153.0.8010.12',
        platform: 'darwin' as const,
        arch: 'arm64' as const,
      },
      identity: { mode: 'native' as const, policyRevision: 1 },
    };
    let client: Awaited<ReturnType<typeof startDarwinSupervisorClient>> | undefined;
    let controller: import('playwright-core').Browser | undefined;
    try {
      client = await startDarwinSupervisorClient({
        workerPath: fixture.worker,
        browserId: 'auth_fixture',
        generation: 0,
        reservationNonce: randomUUID(),
        manager,
        artifact,
        profileDir,
        origin: 'about:blank',
        ownedProxy: { url: `http://127.0.0.1:${address.port}`, credentials },
        runtime,
      });
      expect(await native.identity(client.reportedRoot.pid)).toEqual(client.reportedRoot);
      controller = await (
        await verifiedLibrary(runtime)
      ).connectOverCDP(client.reportedEndpointURL);
      const page = controller.contexts()[0]!.pages()[0]!;
      await page.goto(originURL);
      expect(await page.title()).toBe('Private authentication fixture');
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
      });
      expect(workerFetched).toBeGreaterThan(0);
      const upstream = await page.goto(`${originURL}/upstream-auth`);
      expect(upstream!.status()).toBe(401);
      expect(leaked).toBe(0);
      expect(upstreamAuthorization).toBe(0);
      expect(challenged).toBeGreaterThan(0);
      expect(authenticated).toBeGreaterThan(0);
      await controller.close();
      controller = undefined;
      expect(await client.close()).toEqual({ pending: false, uncertain: false });
      expect(await native.identity(client.reportedRoot.pid)).toBeNull();
      await writeFile(
        join(import.meta.dirname, '../../.temp/private-auth-native-receipt.json'),
        JSON.stringify(
          {
            node: process.version,
            executable: fixture.executable,
            executableSHA256: fixture.executableSHA256,
            helperSHA256: artifact.sha256,
            manager,
            supervisor: client.reportedSupervisor,
            root: client.reportedRoot,
            challenged,
            authenticated,
            workerFetched,
            originCredentialLeaks: leaked,
            brokerUpstreamAuthorization: upstreamAuthorization,
            originalCleanup: { pending: false, uncertain: false },
            production: 'off',
            composedAuthorityAcceptance: false,
          },
          null,
          2
        )
      );
    } finally {
      await controller?.close();
      const custody = client ? await client.close() : { pending: true, uncertain: true };
      origin.closeAllConnections();
      broker.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => origin.close(() => resolve())),
        new Promise<void>((resolve) => broker.close(() => resolve())),
      ]);
      if (!custody.pending && !custody.uncertain)
        await rm(profileDir, { recursive: true, force: true });
    }
  },
  30000
);
