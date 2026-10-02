import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processIdentity, strictProcessIdentity } from '../../profile-reservation.mjs';
import {
  ownedTree,
  distinctOwned,
  signalOwned,
  liveOwned,
  awaitGone,
} from '../../resources/resource-process.mjs';
import { bounded, delay } from '../../durability-helpers.mjs';

/** Acquire one attributable worker; register exact-identity cleanup before any browser launch message. */
export function startNativeWorker(onEvent) {
  const child = fork(fileURLToPath(new URL('./native-child.mjs', import.meta.url)), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [],
  });
  const identity = processIdentity(child.pid);
  if (!identity) {
    child.kill('SIGKILL');
    throw Error('WORKER_IDENTITY_UNAVAILABLE');
  }
  let inventory = [identity];
  const inbox = [];
  let pending;
  child.on('message', (message) => {
    if (message.type === 'browser-owned') inventory.push(message.root);
    if (message.type === 'browser-owned') {
      onEvent?.(message, child);
      return;
    }
    if (pending) {
      const waiter = pending;
      pending = null;
      waiter.resolve(message);
    } else inbox.push(message);
  });
  for (const event of ['error', 'exit'])
    child.on(event, () => pending?.reject(Error('OWNED_WORKER_STOPPED')));
  return {
    async request(message) {
      const reply = inbox.length
        ? Promise.resolve(inbox.shift())
        : new Promise((resolve, reject) => {
            pending = { resolve, reject };
          });
      child.send(message);
      const result = await bounded(reply, 20_000);
      if (result.type === 'error') throw Error(result.code);
      return result;
    },
    async stop() {
      let observationError;
      try {
        // Snapshot before parent termination even when browser acquisition itself failed.
        if (processIdentity(identity.pid)?.birth === identity.birth)
          inventory.push(...ownedTree(identity));
        for (const root of [...inventory]) {
          if (processIdentity(root.pid)?.birth === root.birth) inventory.push(...ownedTree(root));
        }
      } catch (error) {
        observationError = error;
      }
      inventory = distinctOwned(inventory);
      try {
        if (child.connected) await bounded(this.request({ type: 'close' }), 3000);
      } catch {
        /* Attempt exact recorded cleanup even when graceful IPC fails. */
      }
      if (observationError) {
        // Do not depend on the failed whole-table observer to stop known identities.
        // This cannot certify an unavailable descendant inventory, so retain the primary failure.
        try {
          const remaining = () =>
            inventory.filter((owned) => strictProcessIdentity(owned.pid)?.birth === owned.birth);
          for (const owned of remaining()) signalOwned(owned, 'SIGTERM');
          try {
            await bounded(
              (async () => {
                while (remaining().length) await delay(25);
              })(),
              3000
            );
          } catch {
            for (const owned of remaining()) signalOwned(owned, 'SIGKILL');
            await bounded(
              (async () => {
                while (remaining().length) await delay(25);
              })(),
              3000
            );
          }
        } catch (cleanupError) {
          observationError.cleanupError = cleanupError;
        }
        throw observationError;
      }
      for (const owned of liveOwned(inventory)) signalOwned(owned, 'SIGTERM');
      try {
        await awaitGone(inventory, 3000);
      } catch {
        for (const owned of liveOwned(inventory)) signalOwned(owned, 'SIGKILL');
        await awaitGone(inventory);
      }
      return { identities: inventory, allGone: liveOwned(inventory).length === 0 };
    },
  };
}
