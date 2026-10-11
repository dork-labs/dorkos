import { json } from './server-response-data.js';
import { runOriginalNativeConsumerWorker } from './server-worker.js';
/** Loopback-only temporary consumer writer/build/note fixture, never production routing. */
import { createServer } from 'node:http';
import { once } from 'node:events';

import { createConsumerVault, type FaultStage } from './writer.js';
import { openNativeConsumerStore, ConsumerChannelStore } from './channel-store.js';
import { dashboardHtml } from './dashboard.js';

export { startIsolatedConsumerHost } from './server-host.js';
export { startNativeConsumerFixture } from './server-native-fixture.js';
/** Start the owned loopback consumer host and its genuine native document store. */
export async function startConsumerFixture() {
  const vault = await createConsumerVault();
  let channel: ConsumerChannelStore | undefined;
  let store!: ConsumerChannelStore;
  let channelStarted = false;
  let server: ReturnType<typeof createServer> | undefined;
  let loseResponse = false;
  let crashAt: FaultStage | undefined;
  let builds = 0;
  let retired = false;
  const counters = { legacyNotifier: 0, ackWatcherResends: 0 }; // Migrated fixture has NO dispatch/resend implementation.
  async function dispose() {
    retired = true;
    let failed = false;
    let first: unknown;
    try {
      if (server?.listening)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve()))
        );
    } catch (cause) {
      failed = true;
      first = cause;
    }
    try {
      await channel?.close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    try {
      if (channelStarted && (!channel || failed))
        throw new Error('Original native channel closure UNKNOWN; vault retained');
      await vault.close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    if (failed) throw first;
  }
  try {
    server = createServer(async (request, response) => {
      try {
        if (retired || !store) throw new Error('Fixture retired or native owner not ready');
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method === 'GET' && url.pathname === '/dashboard') {
          const html = dashboardHtml();
          response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
          response.end(html);
          return;
        }
        if (request.method === 'GET' && url.pathname === '/snapshot') {
          await json(response, 200, {
            ...(await vault.snapshot()),
            documentId: store.documentId,
            counters,
            builds,
          });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/pending') {
          await json(response, 200, await vault.pending());
          return;
        }
        let raw = '',
          bytes = 0;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for await (const block of request) {
          bytes += block.length;
          if (bytes > 16384) throw new Error('Request size refused');
          raw += decoder.decode(block, { stream: true });
        }
        raw += decoder.decode();
        const body = raw ? JSON.parse(raw) : {};
        if (request.method !== 'POST') {
          await json(response, 404, { error: 'Not found' });
          return;
        }
        let result: unknown;
        if (url.pathname === '/write') {
          result = await vault.write(body, (stage) => {
            if (stage === crashAt) {
              crashAt = undefined;
              throw new Error('Injected crash:' + stage);
            }
          });
          if (loseResponse) {
            loseResponse = false;
            response.destroy();
            return;
          }
        } else if (url.pathname === '/handoff/begin')
          result = await vault.beginHandoff(body.operationId);
        else if (url.pathname === '/handoff/receipt') {
          const op = (await vault.snapshot()).ledger.operations[body.operationId];
          if (!op) throw new Error('Writer operation unavailable');
          const receipt = await store.confirm(op);
          if (
            body.receipt?.receipt?.id !== receipt.receipt.id ||
            body.receipt.receipt.docSeq !== receipt.receipt.docSeq
          )
            throw new Error('Offered receipt does not match actual store');
          result = await vault.recordChannel(body.operationId, receipt);
        } else if (url.pathname === '/note.open') result = await vault.noteOpen();
        else if (url.pathname === '/build') {
          builds++;
          result = { builds, markdown: (await vault.snapshot()).markdown };
        } else if (url.pathname === '/ack-audit') {
          await vault.auditAck(body);
          result = { auditMirrorOnly: true };
        } else {
          await json(response, 404, { error: 'Not found' });
          return;
        }
        await json(response, 200, result);
      } catch (cause) {
        if (!response.destroyed)
          await json(response, 409, {
            error: cause instanceof Error ? cause.message : 'Writer failed',
          });
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Loopback fixture address unavailable');
    const origin = 'http://127.0.0.1:' + address.port;
    channelStarted = true;
    channel = await ConsumerChannelStore.open(vault, origin + '/dashboard');
    store = channel;
    return {
      origin,
      vault,
      channel: store,
      loseNextWriterResponse() {
        loseResponse = true;
      },
      crashNextWrite(stage: FaultStage) {
        crashAt = stage;
      },
      async recover() {
        return vault.reopen();
      },
      /** Store proof-only adapter, not a browser SDK or authority issuer. Flush only pre-admission. */
      async flushStore() {
        const accepted = [];
        for (const op of await vault.pending()) {
          await vault.beginHandoff(op.request.operationId);
          await store.emit(op.event);
          const receipt = await store.confirm(op);
          await vault.recordChannel(op.request.operationId, receipt);
          accepted.push(receipt);
        }
        return accepted;
      },
      /** Query genuine persisted receipt after unknown channel response; never re-emit admitted work. */
      async reconcileHandoff(id: string) {
        const op = (await vault.snapshot()).ledger.operations[id];
        if (!op) throw new Error('Writer operation unavailable');
        const receipt = await store.confirm(op);
        return vault.recordChannel(id, receipt);
      },
      close: dispose,
    };
  } catch (cause) {
    try {
      await dispose();
    } catch {}
    throw cause;
  }
}
export type ConsumerFixture = Awaited<ReturnType<typeof startConsumerFixture>>;
export type NativeRoomScenarioData = Awaited<
  ReturnType<Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalRoomScenarioData']>
>;

/** Reserve a prospective port without claiming its later availability. A raced
 * bind is a setup failure, never a fallback to an unbound origin/auth policy. */
const originalWorkerEntries = new WeakSet<object>();
const originalEntryHas = WeakSet.prototype.has;
const originalEntryAdd = WeakSet.prototype.add;
const originalEntryApply = Reflect.apply;
/** No caller can register or obtain the original child-entry key. */
export function requireOriginalWorkerEntry(key: object): void {
  if (!originalEntryApply(originalEntryHas, originalWorkerEntries, [key]))
    throw new Error('Original consumer worker entry required');
}
// Ordinary test imports cannot start an app, provider, child or native turn.
if (process.argv[2] === '--consumer-native-worker' && process.send) {
  const entryKey = Object.freeze({});
  originalEntryApply(originalEntryAdd, originalWorkerEntries, [entryKey]);
  void runOriginalNativeConsumerWorker(entryKey);
}
