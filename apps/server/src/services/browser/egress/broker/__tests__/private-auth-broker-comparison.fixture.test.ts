import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, request, type Server, type ClientRequest } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { expect, it } from 'vitest';
import {
  resolveInstalledRuntimeConfiguration,
  createRuntimeInstallation,
  verifyInstalledNativeJournal,
} from '@dorkos/browser/runtime-installation';
import { startDarwinSupervisorClient } from '../../../../../../../../packages/browser/src/runtime/darwin-supervisor-client.js';
import { createDarwinEngineProcesses } from '../../../../../../../../packages/browser/src/runtime/darwin-engine-processes.js';
import { verifiedLibrary } from '../../../../../../../../packages/browser/src/runtime/public-library.js';
import { createControllerProxyAuthentication } from '../../../../../../../../packages/browser/src/runtime/identity/controller-proxy-authentication.js';
import { readControllerOriginalCatalog } from '../../../../../../../../packages/browser/src/runtime/identity/controller-original-catalog.js';
import { createSupervisorProtocolWire } from '../../../../../../../../packages/browser/src/runtime/identity/supervisor-protocol-wire.js';
import { RuntimeDescriptorSchema } from '../../../../../../../../packages/browser/src/runtime-descriptor.js';
import { createBrokerIssuer } from '../issuer.js';
import { createPreparedPrivateBroker } from '../broker.js';
import { createNodeBrokerTransport } from '../node/node-transport.js';
import type { OwnedSocket } from '../transport.js';
import {
  boundedOriginalFile,
  readPublicNativeInput,
} from '../../../runtime/__tests__/public-native-input.js';
// Native execution requires the original Parent window and this explicit private fixture input.
// eslint-disable-next-line no-restricted-syntax
const fixturePath = process.env.DORKOS_PRIVATE_PROXY_COMPARISON_FIXTURE;
const configSchema = z
  .object({ input: z.string().startsWith('/'), artifacts: z.string().startsWith('/') })
  .strict();
const cases = [
  'handwritten-no-route',
  'handwritten-route',
  'production-no-route',
  'production-route',
] as const;
it.skipIf(!fixturePath || process.platform !== 'darwin').each(cases)(
  'compares original native proxy authentication: %s',
  async (subject) => {
    const config = configSchema.parse(
      JSON.parse((await boundedOriginalFile(fixturePath!, 16384)).toString('utf8'))
    );
    if (!(await lstat(config.artifacts)).isDirectory())
      throw new Error('ORIGINAL_ARTIFACT_DIRECTORY_REQUIRED');
    const input = await readPublicNativeInput(config.input);
    const installed = await resolveInstalledRuntimeConfiguration(
      pathToFileURL(input.cliEntry),
      input.home
    );
    const status = await createRuntimeInstallation(installed).inspectExisting();
    if (status.state !== 'installed-files') throw new Error('ORIGINAL_INSTALLATION_REQUIRED');
    const nativeJournal = await verifyInstalledNativeJournal(installed);
    const runtime = RuntimeDescriptorSchema.parse({
      library: {
        package: 'playwright-core',
        version: '1.63.0',
        rootDir: installed.libraryRoot,
        assets: { manifest: 'browsers.json', cli: 'cli.js' },
      },
      executable: {
        path: join(
          installed.cacheRoot,
          'candidates',
          status.installationId,
          'payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
        ),
        sha256: status.executableSHA256,
        revision: '1243',
        version: '153.0.8010.12',
        platform: 'darwin',
        arch: 'arm64',
      },
      identity: { mode: 'native', policyRevision: 1 },
    });
    const native = createDarwinEngineProcesses(nativeJournal.journal.artifact);
    const manager = await native.identity(process.pid);
    if (!manager) throw new Error('ORIGINAL_MANAGER_UNKNOWN');
    const profile = await realpath(await mkdtemp(join(tmpdir(), 'proxy-comparison-')));
    const counts = {
      receiver: 0,
      serverAuthChallenges: 0,
      credentialLeaks: 0,
      unauthenticated: 0,
      credentialBearing: 0,
      challengeWrites: 0,
      ends: 0,
    };
    const origin = createServer((incoming, response) => {
      counts.receiver++;
      if (incoming.headers.authorization || incoming.headers['proxy-authorization'])
        counts.credentialLeaks++;
      if (incoming.url === '/server-auth') {
        counts.serverAuthChallenges++;
        response.writeHead(401, { 'www-authenticate': 'Basic realm="original-origin"' }).end();
        return;
      }
      response.end('<title>Original proxy comparison</title>');
    });
    const sockets = new Set<import('node:net').Socket>();
    const socketReturns: Promise<void>[] = [];
    const retainSocket = (socket: import('node:net').Socket) => {
      sockets.add(socket);
      socketReturns.push(
        new Promise<void>((resolve) =>
          socket.once('close', () => {
            sockets.delete(socket);
            resolve();
          })
        )
      );
    };
    origin.on('connection', retainSocket);
    const outgoing = new Map<ClientRequest, Promise<void>>();
    let nodeProxy: Server | undefined;
    let production: ReturnType<typeof createPreparedPrivateBroker> | undefined;
    let client: Awaited<ReturnType<typeof startDarwinSupervisorClient>> | undefined;
    let controller:
      | Awaited<ReturnType<Awaited<ReturnType<typeof verifiedLibrary>>['connectOverCDP']>>
      | undefined;
    const known = new Map<string, { pid: number; birth: string }>();
    const retain = (identity: { pid: number; birth: string }) =>
      known.set(`${identity.pid}:${identity.birth}`, identity);
    let first: { value: unknown } | undefined;
    let wire: ReturnType<typeof createSupervisorProtocolWire> | undefined;
    let authentication: ReturnType<typeof createControllerProxyAuthentication> | undefined;
    let nativeReturn: unknown;
    const observations: { pid: number; birth: string; status: string }[] = [];
    let diagnostics = '';
    let serverAuthOutcome:
      | { kind: 'response'; status: number }
      | { kind: 'cancelled'; code: 'ERR_HTTP_RESPONSE_CODE_FAILURE' }
      | undefined;
    let originalServerRefusal: { value: unknown } | undefined;
    try {
      origin.listen(0, '127.0.0.1');
      await once(origin, 'listening');
      const address = origin.address();
      if (!address || typeof address === 'string') throw new Error('ORIGINAL_RECEIVER_UNKNOWN');
      const target = `http://127.0.0.1:${address.port}/`;
      let peer: { url: string; credentials: { username: string; password: string } };
      if (subject.startsWith('handwritten')) {
        const credentials = { username: 'dorkos', password: randomBytes(32).toString('base64url') };
        const expected = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
        nodeProxy = createServer((incoming, response) => {
          if (incoming.headers['proxy-authorization'] !== expected) {
            counts.unauthenticated++;
            counts.challengeWrites++;
            response.writeHead(407, { 'proxy-authenticate': 'Basic realm="owned-proxy"' }).end();
            return;
          }
          counts.credentialBearing++;
          const url = new URL(incoming.url!);
          if (url.origin !== new URL(target).origin) {
            response.writeHead(403).end();
            return;
          }
          const headers = { ...incoming.headers };
          delete headers['proxy-authorization'];
          const original = request(
            url,
            { method: incoming.method, headers, agent: false },
            (upstream) => {
              response.writeHead(upstream.statusCode!, upstream.headers);
              upstream.pipe(response);
            }
          );
          outgoing.set(original, new Promise<void>((resolve) => original.once('close', resolve)));
          original.once('error', () => response.destroy());
          incoming.pipe(original);
        });
        nodeProxy.on('connection', retainSocket);
        nodeProxy.listen(0, '127.0.0.1');
        await once(nodeProxy, 'listening');
        const endpoint = nodeProxy.address();
        if (!endpoint || typeof endpoint === 'string') throw new Error('ORIGINAL_PROXY_UNKNOWN');
        peer = { url: `http://127.0.0.1:${endpoint.port}`, credentials };
      } else {
        const now = () => Math.floor(performance.now());
        const binding = {
          ownerId: 'comparison-owner',
          workspaceId: 'comparison-workspace',
          browserId: subject,
          browserGeneration: 1,
        };
        const receiver = Object.freeze({
          browserId: subject,
          browserGeneration: 1,
          isAuthorityCurrent: () => true,
        });
        const observation = () => ({
          binding,
          ownerExists: true as const,
          retainedRun: true as const,
          grantsCurrent: true as const,
          custodyKnown: true as const,
          runtimePolicyKnown: true as const,
          runtimeIdentity: 'original-comparison-runtime',
          authorizationEpoch: 1,
          policyRevision: 1,
          inventoryRevision: 1,
          monotonicNow: now(),
          utcNow: Date.now(),
          utcExpiresAt: Date.now() + 60000,
        });
        const issuer = createBrokerIssuer({
          now,
          ports: {
            readCurrent: observation,
            readAuthority: async () => observation(),
            readInventory: () => ({
              revision: 1,
              publicAuthoritiesKnown: true,
              localCoverageComplete: true,
              validUntil: now() + 60000,
              protectedEndpoints: [],
              declaredInstances: ['comparison'],
              coveredInstances: ['comparison'],
            }),
          },
        });
        const run = issuer.prepareRun(binding, {
          runtimeIdentity: 'original-comparison-runtime',
          authorizationEpoch: 1,
          policyRevision: 1,
          inventoryRevision: 1,
          receiver,
        });
        const originalTransport = createNodeBrokerTransport();
        const wrappers = new WeakMap<OwnedSocket, OwnedSocket>();
        const wrap = (socket: OwnedSocket) => {
          let captured = wrappers.get(socket);
          if (captured) return captured;
          const write = socket.write.bind(socket),
            end = socket.end.bind(socket);
          const onClose = socket.onClose.bind(socket),
            onError = socket.onError.bind(socket),
            onData = socket.onData.bind(socket),
            onDrain = socket.onDrain.bind(socket);
          const pause = socket.pause.bind(socket),
            resume = socket.resume.bind(socket),
            destroy = socket.destroy.bind(socket);
          const custody = socket.isCustodyKnown?.bind(socket);
          captured = Object.freeze({
            identity: socket.identity,
            get peer() {
              return socket.peer;
            },
            get observedClosed() {
              return socket.observedClosed;
            },
            get writableBytes() {
              return socket.writableBytes;
            },
            ...(custody ? { isCustodyKnown: custody } : {}),
            onClose,
            onError,
            onData,
            onDrain,
            pause,
            resume,
            destroy,
            write(bytes: Uint8Array) {
              const result = write(bytes);
              if (Buffer.from(bytes).toString('ascii').startsWith('HTTP/1.1 407 '))
                counts.challengeWrites++;
              return result;
            },
            end() {
              end();
              counts.ends++;
            },
          });
          wrappers.set(socket, captured);
          return captured;
        };
        production = createPreparedPrivateBroker({
          issuer,
          run,
          receiver,
          policy: {
            revision: 1,
            adminAuthorities: [],
            hostInterfaces: [],
            privateAdminEndpoints: [],
            resolver: async () => ({ a: [], aaaa: [], cname: [] }),
          },
          transport: {
            ...originalTransport,
            listen: (options) =>
              originalTransport.listen({
                ...options,
                onSocket: (slot, socket) => options.onSocket(slot, wrap(socket)),
                onRequest: (request) => {
                  if (
                    request.raw.rawHeaders.some(
                      (name, index) =>
                        index % 2 === 0 && name.toLowerCase() === 'proxy-authorization'
                    )
                  )
                    counts.credentialBearing++;
                  else counts.unauthenticated++;
                  options.onRequest({ ...request, client: wrap(request.client) });
                },
              }),
          },
        });
        const descriptor = await production.start();
        await production.activate(receiver);
        production.grantLocal(target, 'http', 10000);
        peer = { url: descriptor.server, credentials: descriptor.credentials };
      }
      client = await startDarwinSupervisorClient(
        {
          workerPath: nativeJournal.journal.browserWorkerPath!,
          browserId: subject,
          generation: 1,
          reservationNonce: randomUUID(),
          manager,
          artifact: nativeJournal.journal.artifact,
          profileDir: profile,
          origin: 'about:blank',
          ownedProxy: peer,
          runtime,
        },
        undefined,
        undefined,
        async (original) => {
          original.identities.forEach(retain);
          retain(original.root);
          retain(original.supervisor);
          if (!original.complete) throw new Error('ORIGINAL_CHILD_INCOMPLETE');
        }
      );
      wire = createSupervisorProtocolWire(client.reportedEndpointURL);
      await wire.open();
      const originalCatalog = await readControllerOriginalCatalog(wire.transport);
      authentication = createControllerProxyAuthentication(
        wire.transport,
        peer,
        () => !first,
        (value) => {
          first ??= { value };
        },
        originalCatalog
      );
      controller = await (
        await verifiedLibrary(runtime)
      ).connectOverCDP(authentication.transport, { noDefaults: true });
      const page = controller.contexts()[0]!.pages()[0]!;
      if (!subject.endsWith('-no-route')) await page.route('**/*', (route) => route.fallback());
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 10000 });
      expect(await page.title()).toBe('Original proxy comparison');
      expect(counts.unauthenticated).toBeGreaterThan(0);
      expect(counts.challengeWrites).toBeGreaterThan(0);
      expect(counts.receiver).toBeGreaterThan(0);
      expect(counts.credentialBearing).toBeGreaterThan(0);
      expect(counts.credentialLeaks).toBe(0);
      const serverAuthURL = new URL('/server-auth', target).href;
      try {
        const upstream = await page.goto(serverAuthURL, {
          waitUntil: 'domcontentloaded',
          timeout: 10000,
        });
        expect(upstream?.status()).toBe(401);
        serverAuthOutcome = { kind: 'response', status: 401 };
      } catch (value) {
        originalServerRefusal = { value };
        let expectedServerRefusal = false;
        try {
          const message =
            value instanceof Error ? Object.getOwnPropertyDescriptor(value, 'message') : undefined;
          expectedServerRefusal =
            !!message &&
            Object.prototype.hasOwnProperty.call(message, 'value') &&
            typeof message.value === 'string' &&
            message.value.split('\n')[0] ===
              `page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at ${serverAuthURL}` &&
            counts.serverAuthChallenges > 0 &&
            counts.credentialLeaks === 0 &&
            authentication.isKnown() &&
            first === undefined;
        } catch {
          /* A failed inspection cannot replace the original navigation refusal. */
        }
        if (!expectedServerRefusal) throw originalServerRefusal.value;
        serverAuthOutcome = { kind: 'cancelled', code: 'ERR_HTTP_RESPONSE_CODE_FAILURE' };
      }
      expect(authentication.isKnown()).toBe(true);
      expect(first).toBeUndefined();
      expect(counts.serverAuthChallenges).toBeGreaterThan(0);
      expect(counts.credentialLeaks).toBe(0);
    } catch (value) {
      first ??= { value };
    } finally {
      if (client) {
        try {
          const tree = await native.processes.descendants(
            client.reportedRoot,
            new AbortController().signal
          );
          tree.identities.forEach(retain);
          if (tree.status !== 'complete')
            first ??= { value: new Error('ORIGINAL_FINAL_COHORT_UNKNOWN') };
        } catch (value) {
          first ??= { value };
        }
      }
      try {
        await authentication?.prepareClose();
      } catch (value) {
        first ??= { value };
      }
      const originalControllerCloses = [
        async () => {
          await controller?.close();
        },
        async () => {
          await authentication?.close();
        },
        async () => {
          await wire?.close();
        },
        async () => {
          if (client) {
            nativeReturn = await client.close();
            diagnostics = client
              .diagnostics()
              .split('\n')
              .filter((line) =>
                /^(SUPERVISOR_CLOSE|SUPERVISOR_CHILD_RETURN|SUPERVISOR_UNCERTAIN): [A-Z_]+$/.test(
                  line
                )
              )
              .slice(0, 16)
              .join('\n');
            expect(nativeReturn).toEqual({ pending: false, uncertain: false });
          }
        },
      ];
      const originalCloseJobs = originalControllerCloses.map((close) => {
        const job = close();
        void job.catch((value) => {
          first ??= { value };
        });
        return job;
      });
      const originalCloseReturns = await Promise.allSettled(originalCloseJobs);
      for (const returned of originalCloseReturns)
        if (returned.status === 'rejected') first ??= { value: returned.reason };
      const closes = [
        async () => {
          if (production) expect(await production.close()).toBe(true);
        },
        async () => {
          for (const original of outgoing.keys()) {
            try {
              original.destroy();
            } catch (value) {
              first ??= { value };
            }
          }
          const returns = await Promise.allSettled(outgoing.values());
          for (const returned of returns)
            if (returned.status === 'rejected') first ??= { value: returned.reason };
        },
        async () => {
          for (const socket of sockets) {
            try {
              socket.destroy();
            } catch (value) {
              first ??= { value };
            }
          }
          const returns = await Promise.allSettled([
            ...socketReturns,
            ...[origin, ...(nodeProxy ? [nodeProxy] : [])].map(
              (server) =>
                new Promise<void>((resolve, reject) =>
                  server.close((value) => (value ? reject(value) : resolve()))
                )
            ),
          ]);
          for (const returned of returns)
            if (returned.status === 'rejected') first ??= { value: returned.reason };
        },
      ];
      // Enter/join every independent original duty even if a previous close refuses.
      for (const close of closes) {
        try {
          await close();
        } catch (value) {
          first ??= { value };
        }
      }
      for (const identity of known.values()) {
        try {
          const observed = await native.observeTerminated(identity, new AbortController().signal);
          observations.push({ ...identity, status: observed.status });
          if (observed.status !== 'dead')
            first ??= { value: new Error('ORIGINAL_NATIVE_RETURN_UNKNOWN') };
        } catch (value) {
          first ??= { value };
        }
      }
      try {
        await writeFile(
          join(config.artifacts, `${subject}.json`),
          JSON.stringify(
            {
              subject,
              returned: first ? 'FAIL' : 'PASS',
              counts,
              serverAuthOutcome,
              nativeReturn,
              manager,
              known: [...known.values()],
              observations,
              diagnostics,
            },
            null,
            2
          ),
          { flag: 'wx', mode: 0o600 }
        );
      } catch (value) {
        first ??= { value };
      }
      if (!first) {
        try {
          await rm(profile, { recursive: true, force: true });
        } catch (value) {
          first ??= { value };
        }
      }
    }
    if (first) throw first.value;
  },
  30000
);
