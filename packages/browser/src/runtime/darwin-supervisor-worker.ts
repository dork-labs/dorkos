import { z } from 'zod';
import { launchDarwinSupervisorBrowser } from './darwin-supervisor-browser.js';
import {
  SupervisorSeedSchema as seedSchema,
  SupervisorCommandSchema as requestSchema,
  SupervisorReplySchema,
} from './darwin-supervisor-protocol.js';

/** Private bounded domain RPC. The supervisor retains actual context/child/proxy originals. */
export async function runDarwinSupervisorWorker(): Promise<void> {
  let owner: Awaited<ReturnType<typeof launchDarwinSupervisorBrowser>> | undefined;
  let launching: Promise<void> | undefined,
    stopping = false,
    accepted = false,
    lastSequence = 0;
  let seed: z.infer<typeof seedSchema>;
  let pending = 0,
    tail: Promise<void> = Promise.resolve(),
    closePromise: Promise<boolean> | undefined;
  let originalCloseSequence: number | undefined;
  const pages = new Map<number, import('playwright-core').Page>();
  let nextTab = 1;
  const sends = new Set<Promise<void>>();
  const send = async (value: unknown) => {
    if (!process.connected || !process.send) return;
    const parsed = SupervisorReplySchema.parse(value);
    if (Buffer.byteLength(JSON.stringify(value)) > 65536)
      throw new Error('SUPERVISOR_REPLY_EXCEEDED');
    const original = new Promise<void>((resolve, reject) =>
      process.send!(parsed, (error) => (error ? reject(error) : resolve()))
    );
    sends.add(original);
    void original.then(
      () => sends.delete(original),
      () => {}
    );
    await original;
  };
  const close = (): Promise<boolean> => {
    stopping = true;
    closePromise ??= (async () => {
      await launching?.catch(() => {});
      const [result] = await Promise.all([owner ? owner.close() : Promise.resolve(false), tail]);
      pages.clear();
      return result && sends.size === 0;
    })();
    return closePromise;
  };
  const disconnect = () => {
    void close().then(
      (returned) => {
        process.exitCode = returned ? 0 : 1;
        if (process.connected) process.disconnect();
      },
      () => {
        process.exitCode = 1;
        if (process.connected) process.disconnect();
      }
    );
  };
  process.once('disconnect', disconnect);
  process.on('message', (message) => {
    if (stopping) return;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(message));
    } catch {
      disconnect();
      return;
    }
    if (bytes > 65536) {
      disconnect();
      return;
    }
    if (!accepted) {
      accepted = true;
      const parsed = seedSchema.safeParse(message);
      if (!parsed.success) {
        disconnect();
        return;
      }
      seed = parsed.data;
      if (seed.manager.pid !== process.ppid) {
        disconnect();
        return;
      }
      const origin = new URL(seed.origin);
      if (
        !seed.ownedProxy &&
        (origin.protocol !== 'http:' ||
          !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
          origin.origin !== seed.origin ||
          !origin.port)
      ) {
        disconnect();
        return;
      }
      launching = (async () => {
        owner = await launchDarwinSupervisorBrowser(
          seed,
          (cause, root) => {
            void send(
              cause === 'browser' && root
                ? { kind: 'rootFailure', nonce: seed!.nonce, root }
                : { kind: 'custodyFault', nonce: seed!.nonce }
            ).catch(() => {});
            disconnect();
          },
          async (root) => {
            // This callback can enter only after the original Chromium child returned.
            // Disconnect-driven cleanup does not manufacture a command correlation.
            if (originalCloseSequence === undefined) return;
            await send({
              kind: 'rootReturned',
              nonce: seed.nonce,
              sequence: originalCloseSequence,
              root,
            });
          }
        );
        if (stopping) return;
        // Acquisition settles independently of the original IPC acknowledgement.
        void send({
          kind: 'ready',
          nonce: seed.nonce,
          browserId: seed.browserId,
          reservationNonce: seed.reservationNonce,
          generation: seed.generation,
          endpointURL: owner.endpointURL,
          root: owner.root,
          supervisor: owner.supervisor,
          proxyURL: owner.proxyURL,
        }).catch(() => disconnect());
      })();
      void launching.catch(() => disconnect());
      return;
    }
    const parsed = requestSchema.safeParse(message);
    if (
      !parsed.success ||
      parsed.data.nonce !== seed.nonce ||
      parsed.data.sequence !== lastSequence + 1 ||
      pending >= 8
    ) {
      disconnect();
      return;
    }
    const request = parsed.data;
    lastSequence = request.sequence;
    if (request.action.kind === 'close') {
      originalCloseSequence = request.sequence;
      void close()
        .then(async (returned) => {
          await send({ kind: 'closed', nonce: seed.nonce, sequence: request.sequence, returned });
          if (process.connected) process.disconnect();
          process.exitCode = returned ? 0 : 1;
        })
        .catch(disconnect);
      return;
    }
    pending++;
    const operation = tail.then(async () => {
      await launching;
      if (stopping || !owner) throw new Error('SUPERVISOR_STOPPED');
      let value: unknown;
      if (request.action.kind === 'list') {
        for (const page of owner.context.pages()) {
          if (![...pages.values()].includes(page)) {
            if (pages.size >= 128) throw new Error('SUPERVISOR_TAB_LIMIT');
            pages.set(nextTab++, page);
          }
        }
        value = [...pages]
          .filter(([, page]) => !page.isClosed())
          .map(([tab, page]) => ({ tab, url: page.url().slice(0, 4096) }));
      } else if (request.action.kind === 'navigate') {
        const page = pages.get(request.action.tab),
          url = new URL(request.action.url);
        if (
          !page ||
          page.isClosed() ||
          !['http:', 'https:'].includes(url.protocol) ||
          (!seed.ownedProxy && url.origin !== seed.origin) ||
          url.username ||
          url.password
        )
          throw new Error('SUPERVISOR_TARGET_REFUSED');
        await page.goto(url.href, { timeout: 5000 });
        value = { tab: request.action.tab };
      } else throw new Error('SUPERVISOR_ACTION_REFUSED');
      if (!stopping)
        await send({ kind: 'reply', nonce: seed.nonce, sequence: request.sequence, value });
    });
    tail = operation
      .catch(async (error: unknown) => {
        process.stderr.write(
          (error instanceof Error ? error.message.slice(0, 1024) : 'SUPERVISOR_ACTION_FAILED') +
            '\n'
        );
        if (!stopping)
          await send({ kind: 'refused', nonce: seed.nonce, sequence: request.sequence });
      })
      .then(() => {
        pending--;
      });
    void tail.catch(disconnect);
  });
}
if (process.argv[2] === '--private-darwin-browser-supervisor') void runDarwinSupervisorWorker();
