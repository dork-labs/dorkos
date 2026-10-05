import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import {
  mkdtemp,
  readFile,
  writeFile,
  chmod,
  realpath,
  open,
  lstat,
  type FileHandle,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type BrowserContext } from 'playwright-core';
import { expect, it, onTestFinished } from 'vitest';
import { createFixtureContextCustody } from './fixture-custody.js';
import { z } from 'zod';
import {
  NativeIdentitySchema,
  compareNativeIdentity,
  compareNativeRequest,
} from '../native-observation.js';

// Explicit private-fixture input only. This never activates an identity mode.
// eslint-disable-next-line no-restricted-syntax -- This private fixture has no app env dependency.
const runtimeInput = process.env.DORKOS_BROWSER_IDENTITY_RUNTIME;
const retainedExecutableReads = new Set<FileHandle>();
const retainedServers = new Set<https.Server>();
const retainedServerCloses = new Map<https.Server, Promise<void>>();
let executableCloseUncertain = false;
async function hashExecutable(path: string): Promise<string> {
  if (executableCloseUncertain) throw new Error('EXECUTABLE_READ_CLOSE_UNCERTAIN');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  retainedExecutableReads.add(file);
  let failed = false,
    primary: unknown,
    digest = '';
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > 2147483648n)
      throw new Error('EXECUTABLE_READ_UNAVAILABLE');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const result = await file.read(buffer, 0, Math.min(buffer.length, 2147483649 - total), total);
      if (!result.bytesRead) break;
      total += result.bytesRead;
      if (total > 2147483648) throw new Error('EXECUTABLE_READ_OVERFLOW');
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await file.stat({ bigint: true }),
      named = await lstat(path, { bigint: true });
    if (
      BigInt(total) !== before.size ||
      !named.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      named.size !== after.size ||
      named.mtimeNs !== after.mtimeNs ||
      named.ctimeNs !== after.ctimeNs
    )
      throw new Error('EXECUTABLE_READ_CHANGED');
    digest = hash.digest('hex');
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await file.close();
    retainedExecutableReads.delete(file);
  } catch (error) {
    executableCloseUncertain = true;
    if (!failed) primary = error;
    failed = true;
  }
  if (failed) throw primary;
  return digest;
}

const runtimeSchema = z
  .object({
    executablePath: z.string(),
    executableSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    observedVersion: z.literal('153.0.8010.12'),
  })
  .strict();
const identitySource = `async function readIdentity() {
 const data = navigator.userAgentData;
 const metadata = data ? {...data.toJSON(), ...await data.getHighEntropyValues([
 'architecture','bitness','fullVersionList','model','platformVersion','uaFullVersion','wow64','formFactors'])} : null;
 return {userAgent:navigator.userAgent,appVersion:navigator.appVersion,platform:navigator.platform,
 secureContext:self.isSecureContext,metadata};
}`;

it.skipIf(!runtimeInput || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'observes unchanged native identity across persistent reopen and real service-worker update',
  async () => {
    const runtime = runtimeSchema.parse(JSON.parse(await readFile(runtimeInput!, 'utf8')));
    expect(await realpath(runtime.executablePath)).toBe(runtime.executablePath);
    expect(await hashExecutable(runtime.executablePath)).toBe(runtime.executableSHA256);
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'native-identity-lifetimes-')));
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
        '/CN=identity-lifetimes.test',
        '-addext',
        'subjectAltName=DNS:identity-lifetimes.test',
      ],
      { stdio: 'ignore', timeout: 5000 }
    );
    await chmod(key, 0o600);
    const pem = await readFile(cert);
    const spki = createHash('sha256')
      .update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
    let version = 1;
    const requests: { path: string; headers: Record<string, string | undefined> }[] = [];
    const server = https.createServer(
      { key: await readFile(key), cert: pem },
      (request, response) => {
        if (
          request.headers.host?.split(':')[0] !== 'identity-lifetimes.test' ||
          requests.length >= 256
        ) {
          response.writeHead(403);
          response.end();
          return;
        }
        requests.push({
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
        if (request.url?.startsWith('/worker.js')) {
          response.setHeader('Content-Type', 'text/javascript');
          response.end(`${identitySource}\nconst version=${version};
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>event.waitUntil((async()=>{
 await fetch('/worker-fetch?version='+version+'&phase='+event.data);
 event.ports[0].postMessage({version,identity:await readIdentity()});
})()));`);
        } else {
          response.setHeader('Content-Type', 'text/html');
          response.end(`<script>${identitySource}</script>`);
        }
      }
    );
    retainedServers.add(server);
    const custody = createFixtureContextCustody();
    let serverClose: Promise<void> | undefined;
    const closeServer = () => {
      if (serverClose) return serverClose;
      serverClose = new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else {
            retainedServers.delete(server);
            retainedServerCloses.delete(server);
            resolve();
          }
        });
      });
      retainedServerCloses.set(server, serverClose);
      return serverClose;
    };
    // Registered before HTTPS listen and the first browser launch; also runs when
    // Vitest times out a still-pending body, without losing the original launch.
    onTestFinished(async () => {
      const results = await Promise.allSettled([custody.cleanup(), closeServer()]);
      if (
        results.some((result) => result.status === 'rejected') ||
        results[0].status !== 'fulfilled' ||
        results[0].value.state !== 'closed'
      )
        throw new Error('FIXTURE_CLEANUP_HELD');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture unavailable');
    const origin = `https://identity-lifetimes.test:${address.port}`;
    const profile = join(directory, 'persistent-profile');
    let context: BrowserContext | undefined;
    const observations: unknown[] = [];
    let retainedBaseline: unknown = null,
      firstFailure: string | null = null,
      operationFailed = false,
      operationError: unknown;
    const launch = async () => {
      context = await custody.acquire(() =>
        chromium.launchPersistentContext(profile, {
          executablePath: runtime.executablePath,
          headless: true,
          chromiumSandbox: true,
          timeout: 10000,
          args: [
            `--host-resolver-rules=MAP identity-lifetimes.test 127.0.0.1`,
            `--ignore-certificate-errors-spki-list=${spki}`,
          ],
        })
      );
      expect(context.browser()!.version()).toBe(runtime.observedVersion);
      return context;
    };
    const requestWorker = `(phase)=>new Promise((resolve,reject)=>{
 const channel=new MessageChannel();channel.port1.onmessage=e=>resolve(e.data);
 navigator.serviceWorker.ready.then(r=>r.active.postMessage(phase,[channel.port2]),reject);
})`;
    try {
      const first = await launch(),
        page = first.pages()[0]!;
      await page.goto(origin + '/initial');
      const baseline = NativeIdentitySchema.parse(await page.evaluate('readIdentity()'));
      retainedBaseline = baseline;
      expect(baseline.secureContext).toBe(true);
      const initialRequest = requests.find((value) => value.path === '/initial')!;
      const initialComparison = compareNativeRequest(initialRequest.headers, baseline, false);
      expect(initialComparison.status).not.toBe('fail');
      observations.push({
        phase: 'initial-page',
        identity: baseline,
        request: initialRequest,
        comparison: initialComparison,
      });
      await page.evaluate(
        `navigator.serviceWorker.register('/worker.js',{updateViaCache:'none'}).then(()=>navigator.serviceWorker.ready)`
      );
      const readWorker = async (phase: string, expectedVersion: number) => {
        const result = z
          .object({ version: z.number(), identity: NativeIdentitySchema })
          .strict()
          .parse(await page.evaluate(`(${requestWorker})(${JSON.stringify(phase)})`));
        expect(result.version).toBe(expectedVersion);
        const identityComparison = compareNativeIdentity(baseline, result.identity);
        expect(identityComparison.status).not.toBe('fail');
        const request = requests.find(
          (value) => value.path === `/worker-fetch?version=${expectedVersion}&phase=${phase}`
        );
        expect(request).toBeDefined();
        const comparison = compareNativeRequest(request!.headers, baseline, true);
        expect(comparison.status).not.toBe('fail');
        observations.push({ phase, worker: result, identityComparison, request, comparison });
      };
      console.info('Identity phase: installed worker');
      await readWorker('installed', 1);
      console.info('Identity phase: update worker');
      version = 2;
      await page.evaluate(`(async()=>{
 const registration=await navigator.serviceWorker.ready;
 const changed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WORKER_UPDATE_ACTIVATION_TIMEOUT')),5000);
 navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve()},{once:true});});
 await registration.update();
 await changed;
})()`);
      await readWorker('updated', 2);
      console.info('Identity phase: persistent close');
      await custody.close(first);
      context = undefined;
      console.info('Identity phase: persistent reopen');
      const reopened = await launch(),
        reopenedPage = reopened.pages()[0]!;
      await reopenedPage.goto(origin + '/reopened');
      const identity = NativeIdentitySchema.parse(await reopenedPage.evaluate('readIdentity()'));
      const identityComparison = compareNativeIdentity(baseline, identity);
      expect(identityComparison.status).not.toBe('fail');
      const pageRequest = requests.find((value) => value.path === '/reopened')!;
      const pageComparison = compareNativeRequest(pageRequest.headers, baseline, true);
      expect(pageComparison.status).not.toBe('fail');
      observations.push({
        phase: 'reopened-page',
        identityComparison,
        identity,
        request: pageRequest,
        comparison: pageComparison,
      });
      const worker = z
        .object({ version: z.number(), identity: NativeIdentitySchema })
        .strict()
        .parse(await reopenedPage.evaluate(`(${requestWorker})("restarted")`));
      expect(worker.version).toBe(2);
      const workerIdentityComparison = compareNativeIdentity(baseline, worker.identity);
      expect(workerIdentityComparison.status).not.toBe('fail');
      const request = requests.find(
        (value) => value.path === '/worker-fetch?version=2&phase=restarted'
      );
      expect(request).toBeDefined();
      const restartedComparison = compareNativeRequest(request!.headers, baseline, true);
      expect(restartedComparison.status).not.toBe('fail');
      observations.push({
        phase: 'restarted',
        workerIdentityComparison,
        page: identity,
        worker,
        request,
        comparison: restartedComparison,
      });
      for (const request of requests.filter((value) => value.path.startsWith('/worker.js'))) {
        const comparison = compareNativeRequest(request.headers, baseline, false);
        expect(comparison.status).not.toBe('fail');
        observations.push({ phase: 'worker-script-request', request, comparison });
      }
    } catch (error) {
      firstFailure = error instanceof Error ? error.message.slice(0, 4096) : 'fixture failure';
      operationFailed = true;
      operationError = error;
    } finally {
      const cleanup = await Promise.allSettled([custody.cleanup(), closeServer()]);
      const returned =
        cleanup[0].status === 'fulfilled' &&
        cleanup[0].value.state === 'closed' &&
        cleanup[1].status === 'fulfilled';
      // Keep the operation's first failure; cleanup uncertainty is recorded separately.
      const cleanupState = returned ? 'closed' : 'held';
      // Preserve actual failures/omissions; a passing harness never grants readiness.
      try {
        await writeFile(
          join(directory, 'identity-observations.json'),
          JSON.stringify(
            {
              runtime,
              baseline: retainedBaseline,
              observations,
              firstFailure,
              cleanupState,
              aggregate: firstFailure !== null || !returned ? 'fail' : 'unverified',
              remaining: 'full target/platform/network/native matrix',
              requests,
            },
            null,
            2
          )
        );
      } catch (error) {
        if (!operationFailed) {
          operationFailed = true;
          operationError = error;
        }
        console.error('Identity evidence write failed; original operation failure retained.');
      }
      console.info('Retained native identity fixture:', directory);
      if (!returned && !operationFailed) {
        operationFailed = true;
        operationError = new Error('FIXTURE_CLEANUP_HELD');
      }
      // Retain private profile and observations for review; never touch personal profiles.
    }
    if (operationFailed) throw operationError;
  },
  60000
);
