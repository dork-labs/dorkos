import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { expect, it, onTestFinished } from 'vitest';
import { verifiedFixtureRuntime } from './fixture-runtime.js';
import { createFixtureContextCustody } from './fixture-custody.js';
import { ownLifetimeHttps, ownLifetimeOperations } from './lifetime-fixture-custody.js';
import {
  LifetimeWorkerObservationSchema,
  lifetimeWorkerScripts,
  lifetimeIdentitySource,
  lifetimeSharedRequest,
  lifetimeServiceRequest,
} from './lifetime-worker-scripts.js';
import {
  NativeIdentitySchema,
  compareNativeIdentity,
  compareNativeRequest,
  type NativeIdentity,
} from '../native-observation.js';

// eslint-disable-next-line no-restricted-syntax -- Explicit private native fixture only.
const input = process.env.DORKOS_BROWSER_IDENTITY_RUNTIME;
it.skipIf(!input || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'observes original worker requests after initiator detach and fresh persistent reopening',
  async () => {
    const operations = ownLifetimeOperations(),
      contexts = createFixtureContextCustody();
    let directory: string | undefined, endpoint: ReturnType<typeof ownLifetimeHttps> | undefined;
    let failed = false,
      primary: unknown,
      baseline: NativeIdentity | null = null;
    const observations: unknown[] = [];
    const requests: Array<{
      path: string;
      headers: Record<string, string | undefined>;
      body?: unknown;
    }> = [];
    let cleanupOriginal:
      | Promise<{
          state: string;
          server: ReturnType<ReturnType<typeof ownLifetimeHttps>['snapshot']> | undefined;
          originals: PromiseSettledResult<unknown>[];
        }>
      | undefined;
    const cleanup = () =>
      (cleanupOriginal ??= (async () => {
        const operationsOriginal = operations.finish();
        const originals = await Promise.allSettled([
          contexts.cleanup(),
          endpoint?.close(),
          operationsOriginal,
        ]);
        const closed =
          originals[0].status === 'fulfilled' &&
          originals[0].value.state === 'closed' &&
          originals[1].status === 'fulfilled' &&
          originals[2].status === 'fulfilled' &&
          originals[2].value.state === 'closed';
        return { state: closed ? 'closed' : 'held', server: endpoint?.snapshot(), originals };
      })());
    onTestFinished(async () => {
      const result = await cleanup();
      if (result.state !== 'closed' || operations.snapshot().state !== 'closed') {
        if (failed) throw primary;
        throw new Error('LIFETIME_CLEANUP_HELD');
      }
    });
    try {
      const runtime = await operations.operation(() => verifiedFixtureRuntime(input!), 20000);
      directory = await operations.operation(async () => {
        const named = await mkdtemp(join(tmpdir(), 'native-worker-lifetimes-'));
        directory = named; // Retain the actual name before fallible canonicalization.
        return realpath(named);
      });
      const key = join(directory, 'key.pem'),
        cert = join(directory, 'cert.pem');
      execFileSync(
        '/usr/bin/openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '1',
          '-subj',
          '/CN=identity-workers.test',
          '-addext',
          'subjectAltName=DNS:identity-workers.test',
        ],
        { stdio: 'ignore', timeout: 5000 }
      );
      await operations.operation(() => chmod(key, 0o600));
      const [keyBytes, pem] = await operations.operation(() =>
        Promise.all([readFile(key), readFile(cert)])
      );
      const spki = createHash('sha256')
        .update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }))
        .digest('base64');
      operations.assertOpen();
      endpoint = ownLifetimeHttps({ key: keyBytes, cert: pem }, (request, response) => {
        if (
          requests.length >= 128 ||
          request.headers.host?.split(':')[0] !== 'identity-workers.test'
        ) {
          endpoint!.markUncertain();
          response.writeHead(403);
          response.end();
          return;
        }
        const row = {
          path: request.url!,
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          ),
          body: undefined as unknown,
        };
        requests.push(row);
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader(
          'Accept-CH',
          'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors'
        );
        const url = new URL(row.path, 'https://identity-workers.test');
        if (url.pathname === '/gate') {
          endpoint!.hold(
            url.searchParams.get('kind') + ':' + url.searchParams.get('instance'),
            response
          );
          return;
        }
        if (url.pathname === '/after-detach') {
          const chunks: Buffer[] = [];
          let bytes = 0,
            overflow = false;
          request.on('error', () => {
            overflow = true;
            endpoint!.markUncertain();
          });
          request.on('data', (chunk: Buffer) => {
            if ((bytes += chunk.length) > 4096) {
              overflow = true;
              endpoint!.markUncertain();
              request.destroy();
            } else chunks.push(chunk);
          });
          request.on('end', () => {
            if (overflow) {
              response.writeHead(413);
              response.end();
              return;
            }
            try {
              row.body = JSON.parse(Buffer.concat(chunks).toString());
              response.end('received');
            } catch {
              response.writeHead(400);
              response.end();
            }
          });
          return;
        }
        response.setHeader(
          'Content-Type',
          url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html'
        );
        if (url.pathname === '/shared.js') response.end(lifetimeWorkerScripts(1).shared);
        else if (url.pathname === '/service.js')
          response.end(
            lifetimeWorkerScripts(url.searchParams.get('version') === '2' ? 2 : 1).service
          );
        else
          response.end(
            `<title>Owned identity lifetime</title><script>${lifetimeIdentitySource}</script>`
          );
      });
      operations.adopt(endpoint, () => endpoint!.close());
      await operations.operation(
        () =>
          new Promise<void>((resolve, reject) => {
            endpoint!.server.once('error', reject);
            endpoint!.server.listen(0, '127.0.0.1', resolve);
          })
      );
      const address = endpoint.server.address();
      if (!address || typeof address === 'string') throw new Error('LIFETIME_LISTEN_UNAVAILABLE');
      const origin = `https://identity-workers.test:${address.port}`,
        profile = join(directory, 'persistent-profile');
      const launch = () =>
        operations.operation(
          () =>
            contexts.acquire(() =>
              chromium.launchPersistentContext(profile, {
                executablePath: runtime.executablePath,
                headless: true,
                chromiumSandbox: true,
                timeout: 10000,
                args: [
                  `--host-resolver-rules=MAP identity-workers.test 127.0.0.1`,
                  `--ignore-certificate-errors-spki-list=${spki}`,
                ],
              })
            ),
          15000
        );
      const first = await launch();
      expect(first.browser()!.version()).toBe(runtime.observedVersion);
      const initiator = first.pages()[0]!;
      await operations.operation(() => initiator.goto(origin + '/initiator'));
      baseline = NativeIdentitySchema.parse(
        await operations.operation(() => initiator.evaluate('readIdentity()'))
      );
      expect(baseline.secureContext).toBe(true);
      const observe = (
        phase: string,
        payload: unknown,
        request?: (typeof requests)[number],
        negotiated = true
      ) => {
        const worker = LifetimeWorkerObservationSchema.parse(payload);
        const identity = compareNativeIdentity(baseline!, worker.identity);
        expect(identity.status).not.toBe('fail');
        const headers = request
          ? compareNativeRequest(request.headers, baseline!, negotiated)
          : null;
        if (headers) expect(headers.status).not.toBe('fail');
        observations.push({ phase, worker, identity, request, headers });
        return worker;
      };
      const shared = observe(
        'initial-shared',
        await operations.operation(() =>
          initiator.evaluate(`(${lifetimeSharedRequest})('observe')`)
        )
      );
      await operations.operation(() =>
        initiator.evaluate(
          `navigator.serviceWorker.register('/service.js?version=1',{updateViaCache:'none'}).then(()=>navigator.serviceWorker.ready)`
        )
      );
      const service = observe(
        'installed-service',
        await operations.operation(() =>
          initiator.evaluate(`(${lifetimeServiceRequest})('observe')`)
        )
      );
      const keeper = await operations.operation(() => first.newPage());
      await operations.operation(() => keeper.goto(origin + '/keeper'));
      await operations.operation(() => keeper.bringToFront());
      const kept = observe(
        'keeper-shared',
        await operations.operation(() => keeper.evaluate(`(${lifetimeSharedRequest})('observe')`))
      );
      expect(kept.instance).toBe(shared.instance);
      for (const [kind, script] of [
        ['shared', lifetimeSharedRequest],
        ['service', lifetimeServiceRequest],
      ] as const) {
        const armed = (await operations.operation(() =>
          initiator.evaluate(`(${script})('arm')`)
        )) as { armed: boolean; instance: string };
        expect(armed).toEqual({
          armed: true,
          instance: kind === 'shared' ? shared.instance : service.instance,
        });
      }
      await operations.operation(async () => {
        await expect
          .poll(() => endpoint!.gateKeys(), { timeout: 3000 })
          .toEqual(
            expect.arrayContaining([`shared:${shared.instance}`, `service:${service.instance}`])
          );
      });
      await operations.operation(() => initiator.close());
      expect(initiator.isClosed()).toBe(true);
      expect(first.pages()).toEqual([keeper]);
      const cutoff = requests.length;
      operations.assertOpen();
      endpoint.release(`shared:${shared.instance}`);
      endpoint.release(`service:${service.instance}`);
      await operations.operation(async () => {
        await expect
          .poll(() => requests.filter((r) => r.body !== undefined).length, { timeout: 3000 })
          .toBe(2);
      });
      for (const kind of ['shared', 'service'] as const) {
        const row = requests
          .slice(cutoff)
          .find((r) => r.path.startsWith(`/after-detach?kind=${kind}&`));
        expect(row).toBeDefined();
        const worker = observe('post-initiator-detach', row!.body, row);
        expect(worker.instance).toBe(kind === 'shared' ? shared.instance : service.instance);
      }
      const reconnected = await operations.operation(() => first.newPage());
      await operations.operation(() => reconnected.goto(origin + '/reconnected'));
      await operations.operation(() => reconnected.bringToFront());
      const reattached = observe(
        'same-context-reconnected-shared',
        await operations.operation(() =>
          reconnected.evaluate(`(${lifetimeSharedRequest})('observe')`)
        )
      );
      expect(reattached.instance).toBe(shared.instance);
      await operations.operation(() =>
        reconnected.evaluate(
          `(async()=>{let timer;const changed=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('UPDATE_EXPIRED')),3000);navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve()},{once:true});});const observed=changed.then(()=>({ok:true}),error=>({ok:false,error}));try{await navigator.serviceWorker.register('/service.js?version=2',{updateViaCache:'none'});const outcome=await observed;if(!outcome.ok)throw outcome.error;}finally{clearTimeout(timer);}})()`
        )
      );
      const updated = observe(
        'updated-service',
        await operations.operation(() =>
          reconnected.evaluate(`(${lifetimeServiceRequest})('observe')`)
        )
      );
      expect(updated.version).toBe(2);
      const scriptRows = requests.filter((row) => row.path.startsWith('/service.js?version='));
      for (const version of [1, 2]) {
        const row = scriptRows.find((row) => row.path === `/service.js?version=${version}`);
        expect(row).toBeDefined();
        const comparison = compareNativeRequest(row!.headers, baseline, false);
        expect(comparison.status).not.toBe('fail');
        observations.push({ phase: 'service-first-script', version, row, comparison });
      }
      await operations.operation(() => contexts.close(first));
      const reopened = await launch(),
        page = reopened.pages()[0]!;
      await operations.operation(() => page.goto(origin + '/reopened'));
      await operations.operation(() => page.bringToFront());
      const freshShared = observe(
        'persistent-reopen-shared',
        await operations.operation(() => page.evaluate(`(${lifetimeSharedRequest})('observe')`))
      );
      expect(freshShared.instance).not.toBe(shared.instance);
      const retainedService = observe(
        'persistent-reopen-service',
        await operations.operation(() => page.evaluate(`(${lifetimeServiceRequest})('observe')`))
      );
      expect(retainedService.version).toBe(2);
    } catch (error) {
      failed = true;
      primary = error;
    }
    const closed = await cleanup();
    if (closed.state !== 'closed' && !failed) {
      failed = true;
      primary = new Error('LIFETIME_CLEANUP_HELD');
    }
    if (directory)
      try {
        await operations.evidence(() =>
          writeFile(
            join(directory!, 'worker-lifetime-observations.json'),
            JSON.stringify(
              {
                baseline,
                observations,
                requests,
                cleanup: closed,
                failed,
                aggregate: failed ? 'fail' : 'unverified',
                scope:
                  'Post-initiator-detach; keeper SharedWorker client remains. No override/pre-resume ACK or all-page-disappearance proof.',
              },
              null,
              2
            ),
            { mode: 0o600 }
          )
        );
      } catch (error) {
        if (!failed) {
          failed = true;
          primary = error;
        }
      }
    console.log('Native worker lifetime evidence retained:', directory);
    if (failed) throw primary;
  },
  60000
);
