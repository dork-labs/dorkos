import { json } from './server-response-data.js';
/** Loopback-only temporary consumer writer/build/note fixture, never production routing. */
import { createServer } from 'node:http';
import { once } from 'node:events';

import { tmpdir } from 'node:os';

import { createConsumerVault } from './writer.js';
import { openNativeConsumerStore, reopenNativeConsumerStore } from './channel-store.js';
import { dashboardHtml } from './dashboard.js';
import type { NativeEmissionIntegrityCase } from './native-emission-integrity-control.js';

import { startupAwait } from './server-startup-data.js';
/** Actual app/router/auth/host construction on the same owned FILE database.
 * Caller must supply the original startup admission owner; no fixture boolean or
 * callback manufactures it. This function neither fabricates a terminal lease
 * nor starts a model provider. Built shell/current app-source gates remain required.
 */
export async function startNativeConsumerFixture(
  admission: import('../../../server/src/services/core/lifecycle/main-request-admission.js').MainRequestAdmission,
  port = 0,
  temporaryParent = tmpdir(),
  target: 'session' | 'room' = 'session',
  integrityCase: NativeEmissionIntegrityCase = 'none',
  frameMode: 'routed' | 'log-only' = 'routed'
) {
  const vault = await startupAwait('vault-create', () =>
    createConsumerVault(() => Date.now(), temporaryParent)
  );
  let native: Awaited<ReturnType<typeof openNativeConsumerStore>> | undefined;
  let nativeConstructionStarted = false,
    nativeClosed = false;
  let replacementUnknown = false,
    restartStarted = false;
  let restartFailure: { cause: unknown } | undefined;
  let app:
    ReturnType<typeof import('../../../server/src/http/hono-api.js').composeFrontDoor> | undefined;
  let listener: import('node:http').RequestListener | undefined;
  let loseWriterResponse = false;
  // Separate temporary writer origin: the real preview listener authorizes its
  // own bootstrap/cookie before proxying, and never forwards operator cookies.
  // This upstream has no /api, actor/issuer or model-start endpoint. It accesses
  // only its own sanitary vault and confirms existing native receipts.
  const writerServer = createServer(async (request, response) => {
    try {
      if (retired) throw new Error('Owned writer retired');
      if (!native) {
        await json(response, 503, { error: 'Owned native store starting' });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (
        request.method === 'GET' &&
        (url.pathname === '/' || url.pathname === '/consumer/dashboard')
      ) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(dashboardHtml());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/snapshot') {
        await json(response, 200, await vault.snapshot());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/pending') {
        await json(response, 200, await vault.pending());
        return;
      }
      if (request.method !== 'POST') {
        await json(response, 404, { error: 'Not found' });
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16384) throw new Error('Owned writer request bound');
        chunks.push(chunk);
      }
      if (retired) throw new Error('Owned writer retired during request');
      const body = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      );
      let value: unknown;
      if (url.pathname === '/write') {
        value = await vault.write(body);
        if (loseWriterResponse) {
          loseWriterResponse = false;
          response.destroy();
          return;
        }
      } else if (url.pathname === '/handoff/begin')
        value = await vault.beginHandoff(body.operationId);
      else if (url.pathname === '/handoff/receipt') {
        const op = (await vault.snapshot()).ledger.operations[body.operationId];
        if (!op) throw new Error('Original writer operation unavailable');
        const receipt = await native.confirm(op);
        if (
          body.receipt?.receipt?.id !== receipt.receipt.id ||
          body.receipt.receipt.docSeq !== receipt.receipt.docSeq
        )
          throw new Error('Original native receipt mismatch');
        value = await vault.recordChannel(op.request.operationId, receipt);
      } else if (url.pathname === '/note.open') value = await vault.noteOpen();
      else if (url.pathname === '/build') value = { markdown: (await vault.snapshot()).markdown };
      else if (url.pathname === '/ack-audit') {
        await vault.auditAck(body);
        value = { auditMirrorOnly: true };
      } else {
        await json(response, 404, { error: 'Not found' });
        return;
      }
      await json(response, 200, value);
    } catch {
      if (!response.destroyed)
        await json(response, 409, { error: 'Original writer operation unconfirmed' });
    }
  });
  const server = createServer((request, response) => {
    if (!listener) {
      response.writeHead(503);
      response.end('Native fixture starting');
      return;
    }
    listener(request, response);
  });
  const apiSockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket) => {
    apiSockets.add(socket);
    socket.once('close', () => apiSockets.delete(socket));
  });
  // Observe only original upgrades on this owned API listener. The production
  // router still performs all credential/admission checks and opens the stream.
  const widgetSessionSockets = new Set<import('node:net').Socket>();
  server.on('upgrade', (request, socket) => {
    if (target !== 'session' || !native) return;
    const owned = [...apiSockets].find((candidate) => candidate === socket);
    if (!owned || request.url?.split('?', 1)[0] !== '/api/sessions/' + native.sessionId + '/events')
      return;
    widgetSessionSockets.add(owned);
    owned.once('close', () => widgetSessionSockets.delete(owned));
  });
  let widgetStreamDisconnected = false;
  const ownedSockets = new Set<import('node:net').Socket>();
  for (const listener of [server, writerServer])
    listener.on('connection', (socket) => {
      ownedSockets.add(socket);
      socket.once('close', () => ownedSockets.delete(socket));
    });
  let retired = false;
  let retirement: Promise<void> | undefined;
  const close = () => {
    if (retirement) return retirement;
    retired = true;
    retirement = Promise.resolve().then(async () => {
      let failed = false,
        first: unknown;
      const drain = async (run: () => unknown) => {
        try {
          await run();
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      };
      await drain(() => admission.close());
      // Exact sockets accepted by these two owned listeners, including upgraded
      // durable streams. Destroying them delivers original socket-close cleanup;
      // admission is already permanently closed. Never search/kill other sockets.
      for (const socket of ownedSockets) await drain(() => socket.destroy());
      await drain(() =>
        writerServer.listening
          ? new Promise<void>((resolve, reject) =>
              writerServer.close((cause) => (cause ? reject(cause) : resolve()))
            )
          : undefined
      );
      await drain(() =>
        server.listening
          ? new Promise<void>((resolve, reject) =>
              server.close((cause) => (cause ? reject(cause) : resolve()))
            )
          : undefined
      );
      await drain(async () => {
        if (native) {
          await native.close();
          if (!replacementUnknown) nativeClosed = true;
        }
      });
      if (restartFailure)
        await drain(() => {
          throw restartFailure!.cause;
        });
      else if (replacementUnknown)
        await drain(() => {
          throw new Error('Original replacement construction closure UNKNOWN');
        });
      if (!nativeConstructionStarted || nativeClosed) await drain(() => vault.close());
      if (failed) throw first;
    });
    return retirement;
  };
  try {
    server.listen(port, '127.0.0.1');
    await startupAwait('api-listen', () => once(server!, 'listening'));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Native fixture loopback unavailable');
    const origin = 'http://127.0.0.1:' + address.port;
    writerServer.listen(0, '127.0.0.1');
    await startupAwait('writer-listen', () => once(writerServer, 'listening'));
    const writerAddress = writerServer.address();
    if (!writerAddress || typeof writerAddress === 'string')
      throw new Error('Owned writer origin unavailable');
    const writerOrigin = 'http://127.0.0.1:' + writerAddress.port;
    // InstallationFileWrites captures the real boundary during native construction.
    const { initBoundary } = await startupAwait(
      'boundary-import',
      () => import('../../../server/src/lib/boundary.js')
    );
    await startupAwait('boundary-init', () => initBoundary(vault.root));
    nativeConstructionStarted = true;
    native = await startupAwait('native-store', () =>
      openNativeConsumerStore(
        vault,
        writerOrigin,
        true,
        target,
        integrityCase,
        undefined,
        frameMode
      )
    );
    const original = native;
    const { composeFrontDoor } = await startupAwait(
      'app-import',
      () => import('../../../server/src/http/hono-api.js')
    );
    const { frontDoorListener } = await startupAwait(
      'front-door-import',
      () => import('../../../server/src/http/front-door.js')
    );
    app = composeFrontDoor(admission, {
      docChannel: original.http,
      capabilities: original.managementRegistry,
      approvals: original.approvalRoutes,
      agents: {},
    }); // Same actual host/session/cookie/parser admission and native owners.
    listener = frontDoorListener(app);
    const { attachUpgradeRouter } = await startupAwait(
      'upgrade-import',
      () => import('../../../server/src/services/core/streams/upgrade-router.js')
    );
    const { durableStreamRoutes } = await startupAwait(
      'stream-routes-import',
      () => import('../../../server/src/routes/stream-sockets.js')
    );
    attachUpgradeRouter(server, durableStreamRoutes, admission); // Original credential/current-origin gate, no fixture classifier.
    return {
      origin,
      writerOrigin,
      vault,
      get native() {
        if (!native) throw new Error('Original native fixture unavailable');
        return native;
      },
      async disconnectBoundWidgetStream() {
        if (
          retired ||
          target !== 'session' ||
          integrityCase !== 'none' ||
          !native ||
          widgetStreamDisconnected
        )
          throw new Error('Original widget stream interruption unavailable');
        const sockets = [...widgetSessionSockets];
        if (sockets.length !== 1 || sockets[0].destroyed || !apiSockets.has(sockets[0]))
          throw new Error('Original widget session socket custody unavailable');
        // Consume the single fixture fault before any close callback can reenter.
        widgetStreamDisconnected = true;
        const socket = sockets[0];
        const closed = once(socket, 'close');
        socket.destroy();
        await closed;
        if (!socket.destroyed || apiSockets.has(socket) || widgetSessionSockets.has(socket))
          throw new Error('Original widget session socket closure UNKNOWN');
        return { socketCount: 1, closed: true };
      },
      async restartOriginalNativeRoom() {
        if (
          retired ||
          restartStarted ||
          target !== 'room' ||
          integrityCase !== 'none' ||
          !native ||
          !app
        )
          throw new Error('Original canonical native restart unavailable');
        const prior = native;
        const observed = prior.readCanonicalRecoveryData();
        if (!observed.closed) throw new Error('Original canonical producer closure UNKNOWN');
        restartStarted = true;
        try {
          // Refuse new API work while the old native boot is retiring. Keep both
          // real listeners and the preview upstream; the physical iframe stays mounted.
          app = undefined;
          listener = undefined;
          let socketFailed = false,
            socketCause: unknown;
          const rememberSocket = (cause: unknown) => {
            if (!socketFailed) {
              socketFailed = true;
              socketCause = cause;
            }
          };
          await Promise.allSettled(
            [...apiSockets].map((socket) =>
              Promise.resolve()
                .then(async () => {
                  const closed = once(socket, 'close');
                  socket.destroy();
                  await closed;
                })
                .catch(rememberSocket)
            )
          );
          if (socketFailed) throw socketCause;
          await prior.close();
          nativeClosed = true;
          nativeClosed = false;
          replacementUnknown = true;
          try {
            const successor = await reopenNativeConsumerStore(prior);
            native = successor;
            replacementUnknown = false;
            app = composeFrontDoor(admission, {
              docChannel: successor.http,
              capabilities: successor.managementRegistry,
              approvals: successor.approvalRoutes,
              agents: {},
            });
            listener = frontDoorListener(app);
            return { canonicalId: successor.sessionId, closed: true };
          } catch (cause) {
            restartFailure = { cause };
            throw cause;
          }
        } catch (cause) {
          if (!restartFailure) restartFailure = { cause };
          throw cause;
        }
      },
      app,
      loseNextWriterResponse: () => {
        if (retired) throw new Error('Owned writer retired');
        loseWriterResponse = true;
      },
      close,
    };
  } catch (cause) {
    try {
      await close();
    } catch {
      /* Preserve primary setup cause. */
    }
    throw cause;
  }
}
