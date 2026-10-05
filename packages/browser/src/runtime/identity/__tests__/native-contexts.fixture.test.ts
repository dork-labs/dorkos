import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { mkdtemp, realpath, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { expect, it, onTestFinished } from 'vitest';
import { createFixtureContextCustody } from './fixture-custody.js';
import {
  fixtureWorkerScripts,
  readSharedFixture,
  parseFixtureWorkerResult,
  readFixtureWorker,
} from './fixture-workers.js';
import { createFixtureServerCustody } from './fixture-server.js';
import { verifiedFixtureRuntime } from './fixture-runtime.js';
import {
  NativeIdentitySchema,
  compareNativeIdentity,
  compareNativeRequest,
  type NativeIdentity,
} from '../native-observation.js';

// Explicit existing owned runtime, never a production identity or availability switch.
// eslint-disable-next-line no-restricted-syntax -- Private fixture only.
const runtimeInput = process.env.DORKOS_BROWSER_IDENTITY_RUNTIME;
const identitySource = `async function readIdentity(){
 const data=navigator.userAgentData;
 const metadata=data?{...data.toJSON(),...await data.getHighEntropyValues([
 'architecture','bitness','fullVersionList','model','platformVersion','uaFullVersion','wow64','formFactors'])}:null;
 return {userAgent:navigator.userAgent,appVersion:navigator.appVersion,platform:navigator.platform,
 secureContext:self.isSecureContext,metadata};
}`;

it.skipIf(!runtimeInput || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'observes initial popup, OOPIF and worker identities without inheriting page hint proof',
  async () => {
    const runtime = await verifiedFixtureRuntime(runtimeInput!);
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'native-identity-contexts-')));
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
        '/CN=identity-alpha.test',
        '-addext',
        'subjectAltName=DNS:identity-alpha.test,DNS:identity-beta.test',
      ],
      { stdio: 'ignore', timeout: 5000 }
    );
    await chmod(key, 0o600);
    const pem = await readFile(cert);
    const spki = createHash('sha256')
      .update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
    const scripts = fixtureWorkerScripts(identitySource);
    const workerStages: { script: string; stage: string }[] = [];
    // SDK/network event observations locate a stall; they confer no native lifetime authority.
    const workerDiagnostics: { event: string; detail: string }[] = [];
    const diagnose = (event: string, detail: string) => {
      if (workerDiagnostics.length < 64)
        workerDiagnostics.push({ event, detail: detail.slice(0, 2048) });
    };
    const requests: { host: string; path: string; headers: Record<string, string | undefined> }[] =
      [];
    const server = https.createServer(
      { key: await readFile(key), cert: pem },
      (request, response) => {
        const host = request.headers.host?.split(':')[0];
        if (
          !host ||
          !['identity-alpha.test', 'identity-beta.test'].includes(host) ||
          requests.length >= 256
        ) {
          response.writeHead(403);
          response.end();
          return;
        }
        requests.push({
          host,
          path: request.url!,
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          ),
        });
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader(
          'Accept-CH',
          'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors'
        );
        if (request.url?.startsWith('/dedicated.js')) {
          response.setHeader('Content-Type', 'text/javascript');
          response.end(scripts.dedicated);
        } else if (request.url?.startsWith('/nested-parent.js')) {
          response.setHeader('Content-Type', 'text/javascript');
          response.end(scripts.nested);
        } else if (request.url?.startsWith('/nested-child.js')) {
          response.setHeader('Content-Type', 'text/javascript');
          response.end(scripts.child);
        } else if (request.url?.startsWith('/shared.js')) {
          response.setHeader('Content-Type', 'text/javascript');
          response.end(scripts.shared);
        } else {
          response.setHeader('Content-Type', 'text/html');
          response.end(`<script>${identitySource}</script>`);
        }
      }
    );
    const serverCustody = createFixtureServerCustody(server);
    const custody = createFixtureContextCustody();
    const closeServer = () => serverCustody.close();
    onTestFinished(async () => {
      const originals = await Promise.allSettled([custody.cleanup(), closeServer()]);
      if (
        originals[0].status !== 'fulfilled' ||
        originals[0].value.state !== 'closed' ||
        originals[1].status !== 'fulfilled'
      )
        throw new Error('FIXTURE_CLEANUP_HELD');
    });
    const observations: unknown[] = [];
    let baseline: NativeIdentity | null = null,
      failed = false,
      primary: unknown,
      firstFailure: string | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('FIXTURE_LISTEN_UNAVAILABLE');
      const alpha = `https://identity-alpha.test:${address.port}`,
        beta = `https://identity-beta.test:${address.port}`;
      const context = await custody.acquire(() =>
        chromium.launchPersistentContext(join(directory, 'clean-profile'), {
          executablePath: runtime.executablePath,
          headless: true,
          chromiumSandbox: true,
          timeout: 10000,
          args: [
            `--host-resolver-rules=MAP identity-alpha.test 127.0.0.1, MAP identity-beta.test 127.0.0.1`,
            `--ignore-certificate-errors-spki-list=${spki}`,
            '--site-per-process',
          ],
        })
      );
      expect(context.browser()!.version()).toBe(runtime.observedVersion);
      const page = context.pages()[0]!;
      page.on('worker', (worker) => {
        diagnose('worker-created', worker.url());
        worker.on('close', () => diagnose('worker-close', worker.url()));
      });
      page.on('pageerror', (error) => diagnose('page-error', error.message));
      page.on('requestfinished', (request) => {
        if (request.resourceType() === 'script' || request.resourceType() === 'other')
          diagnose('request-finished', request.url());
      });
      page.on('requestfailed', (request) =>
        diagnose('request-failed', `${request.url()}:${request.failure()?.errorText}`)
      );
      await page.goto(alpha + '/initial');
      baseline = NativeIdentitySchema.parse(await page.evaluate('readIdentity()'));
      expect(baseline.secureContext).toBe(true);
      const observeRequest = (host: string, path: string, negotiated: boolean) => {
        const request = requests.find((value) => value.host === host && value.path === path);
        expect(request).toBeDefined();
        const comparison = compareNativeRequest(request!.headers, baseline!, negotiated);
        expect(comparison.status).not.toBe('fail');
        observations.push({ subject: path, host, negotiated, request, comparison });
      };
      const observeIdentity = (subject: string, input: unknown) => {
        const identity = NativeIdentitySchema.parse(input),
          comparison = compareNativeIdentity(baseline!, identity);
        expect(comparison.status).not.toBe('fail');
        observations.push({ subject, identity, comparison });
      };
      observeRequest('identity-alpha.test', '/initial', false);
      await page.evaluate("fetch('/page-negotiated')");
      observeRequest('identity-alpha.test', '/page-negotiated', true);
      const popupReady = page.waitForEvent('popup');
      await page.evaluate((url) => window.open(url, 'native-popup'), beta + '/popup-first');
      const popup = await popupReady;
      await popup.waitForLoadState();
      observeRequest('identity-beta.test', '/popup-first', false);
      observeIdentity('popup-js', await popup.evaluate('readIdentity()'));
      await popup.evaluate("fetch('/popup-negotiated')");
      observeRequest('identity-beta.test', '/popup-negotiated', true);
      await popup.close();
      await page.evaluate((url) => {
        const iframe = document.createElement('iframe');
        iframe.src = url;
        document.body.append(iframe);
      }, beta + '/oopif');
      const frame = await (async () => {
        for (let n = 0; n < 50; n++) {
          const found = page.frames().find((value) => value.url() === beta + '/oopif');
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('OOPIF_FRAME_UNAVAILABLE');
      })();
      await frame.waitForLoadState();
      observeIdentity('cross-site-frame-js', await frame.evaluate('readIdentity()'));
      observeRequest('identity-beta.test', '/oopif', true);
      const session = await context.newCDPSession(page);
      let sessionFailed = false,
        sessionPrimary: unknown;
      try {
        const targets = await session.send('Target.getTargets');
        const target = targets.targetInfos.find(
          (value) => value.type === 'iframe' && value.url === beta + '/oopif'
        );
        expect(target).toBeDefined();
        observations.push({
          subject: 'oopif-target',
          type: target!.type,
          url: target!.url,
          targetId: target!.targetId,
        });
      } catch (error) {
        sessionFailed = true;
        sessionPrimary = error;
      }
      try {
        await session.detach();
      } catch (error) {
        if (!sessionFailed) {
          sessionFailed = true;
          sessionPrimary = error;
        }
      }
      if (sessionFailed) throw sessionPrimary;
      await frame.evaluate("fetch('/oopif-negotiated')");
      observeRequest('identity-beta.test', '/oopif-negotiated', true);
      // Explicit foreground ownership keeps ordinary dedicated/nested subjects
      // separate from the later background-worker scope.
      await page.bringToFront();
      const workerOwnerVisibility = await page.evaluate(() => document.visibilityState);
      expect(workerOwnerVisibility).toBe('visible');
      observations.push({ subject: 'worker-owner-document', visibility: workerOwnerVisibility });
      for (const [subject, script] of [
        ['dedicated', '/dedicated.js'],
        ['nested-parent', '/nested-parent.js'],
      ] as const) {
        const returned = (await page.evaluate(
          `(${readFixtureWorker})(${JSON.stringify(script)})`
        )) as { result: unknown; stages: string[] };
        for (const stage of returned.stages) workerStages.push({ script, stage });
        const result = parseFixtureWorkerResult(subject, returned.result);
        observeIdentity(subject + '-js', result.identity);
        observeRequest('identity-alpha.test', script, true);
        observeRequest('identity-alpha.test', '/worker-fetch?subject=' + subject, true);
        if (subject === 'nested-parent') {
          observeIdentity('nested-child-js', result.nested);
          observeRequest('identity-alpha.test', '/nested-child.js', true);
          observeRequest('identity-alpha.test', '/worker-fetch?subject=nested-child', true);
        }
      }
      const sharedRead = readSharedFixture;
      const firstShared = parseFixtureWorkerResult(
        'shared',
        await page.evaluate(`(${sharedRead})('initial')`)
      );
      observeIdentity('shared-initial-js', firstShared.identity);
      observeRequest('identity-alpha.test', '/shared.js', true);
      observeRequest('identity-alpha.test', '/worker-fetch?subject=shared&phase=initial', true);
      const keeper = await context.newPage();
      await keeper.goto(alpha + '/shared-keeper');
      const retainedShared = parseFixtureWorkerResult(
        'shared',
        await keeper.evaluate(`(${sharedRead})('second-client')`)
      );
      observeIdentity('shared-second-client-js', retainedShared.identity);
      observeRequest(
        'identity-alpha.test',
        '/worker-fetch?subject=shared&phase=second-client',
        true
      );
      await page.evaluate('globalThis.nativeShared.port.close()');
      await page.close();
      const detachedShared = parseFixtureWorkerResult(
        'shared',
        await keeper.evaluate(`(${sharedRead})('original-page-detached')`)
      );
      observeIdentity('shared-after-original-detach-js', detachedShared.identity);
      observeRequest(
        'identity-alpha.test',
        '/worker-fetch?subject=shared&phase=original-page-detached',
        true
      );
      await keeper.evaluate('globalThis.nativeShared.port.close()');
      observations.push({
        subject: 'shared-background-scope',
        originalPageClosed: page.isClosed(),
        remainingClientCount: 1,
        qualification:
          'original client detached; retained second connection remains, not all clients gone',
      });
      await keeper.close();
    } catch (error) {
      failed = true;
      primary = error;
      firstFailure = error instanceof Error ? error.message.slice(0, 4096) : 'fixture failure';
    }
    const cleanup = await Promise.allSettled([custody.cleanup(), closeServer()]);
    const closed =
      cleanup[0].status === 'fulfilled' &&
      cleanup[0].value.state === 'closed' &&
      cleanup[1].status === 'fulfilled';
    try {
      await writeFile(
        join(directory, 'identity-context-observations.json'),
        JSON.stringify(
          {
            runtime,
            baseline,
            observations,
            requests,
            workerStages,
            workerDiagnostics,
            firstFailure,
            cleanupState: closed ? 'closed' : 'held',
            aggregate: firstFailure !== null || !closed ? 'fail' : 'unverified',
            remaining:
              'full native/platform/network/distribution matrix; all-clients-detached worker lifetimes',
          },
          null,
          2
        )
      );
    } catch (error) {
      if (!failed) {
        failed = true;
        primary = error;
      }
    }
    console.info('Retained native context fixture:', directory);
    if (!closed && !failed) {
      failed = true;
      primary = new Error('FIXTURE_CLEANUP_HELD');
    }
    if (failed) throw primary;
  },
  60000
);
