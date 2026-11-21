/** Main-side filesystem and clock composition for one Vitest generation. */
import { randomBytes } from 'node:crypto';
import { createCustodyBroker } from './broker.js';
import { createOwnedInbox } from './inbox.js';
import { decodeWorker, type RunDescriptor } from './metadata.js';

export type OpenCustodyEndpoint = Parameters<typeof createCustodyBroker>[1]['open'];
export interface GenerationEndpoint {
  open: OpenCustodyEndpoint;
  remove(deadline: number): Promise<'closed' | 'cleanup-uncertain'>;
}

export type ProvidedCustody =
  | { readonly kind: 'available'; readonly run: RunDescriptor; readonly inbox: string }
  | { readonly kind: 'unavailable'; readonly reason: 'windows-acl-unverified' };

const SWEEP_ENTRIES = 32;
const POLL_MS = 25;
const JOIN_MS = 5_000;

function at(deadline: number, callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(
      () => {
        if (Date.now() < deadline) arm();
        else callback();
      },
      Math.min(2_147_483_647, Math.max(0, deadline - Date.now()))
    );
  };
  arm();
  return () => clearTimeout(timer);
}

/** Open owner-private metadata and poll without allocating endpoint resources. */
export async function openCustodyGeneration(
  parent: string,
  runId: string,
  open: OpenCustodyEndpoint | GenerationEndpoint
) {
  const run: RunDescriptor = Object.freeze({
    version: 1,
    runId,
    generation: randomBytes(16).toString('hex'),
    capability: randomBytes(32).toString('hex'),
  });
  const inbox = await createOwnedInbox(parent);
  const broker = createCustodyBroker(
    run,
    {
      now: Date.now,
      at,
      open: typeof open === 'function' ? open : open.open,
      publish: async (request, bytes, signal, expectedReady) => {
        const published = expectedReady
          ? await inbox.replaceReadyReply(request.requestId, expectedReady, bytes, signal)
          : await inbox.write('reply', request.requestId, bytes, signal);
        if (!published) throw new Error('Custody reply publication was cancelled');
      },
      withdraw: (request) => inbox.removeReply(request.requestId),
    },
    JOIN_MS
  );
  let accepting = true;
  let failure = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeSweep: Promise<void> | undefined;
  let closing: Promise<'closed' | 'cleanup-uncertain'> | undefined;

  function stop() {
    if (closing) return closing;
    accepting = false;
    clearTimeout(timer);
    const joined = broker.close();
    let cancelDeadline: (() => void) | undefined;
    let expired = false;
    const deadline = Date.now() + JOIN_MS;
    const limit = new Promise<'cleanup-uncertain'>((resolve) => {
      cancelDeadline = at(deadline, () => {
        expired = true;
        resolve('cleanup-uncertain');
      });
    });
    const cleanup = Promise.all([joined, activeSweep]).then(async ([result]) => {
      if (result !== 'closed' || failure || expired) return 'cleanup-uncertain' as const;
      try {
        if (typeof open !== 'function' && (await open.remove(deadline)) !== 'closed')
          return 'cleanup-uncertain' as const;
        if (expired) return 'cleanup-uncertain' as const;
        await inbox.remove();
        return 'closed' as const;
      } catch {
        return 'cleanup-uncertain' as const;
      }
    });
    closing = Promise.race([cleanup, limit]).finally(() => cancelDeadline?.());
    return closing;
  }

  function schedule() {
    if (!accepting) return;
    timer = setTimeout(() => {
      activeSweep = inbox
        .take(SWEEP_ENTRIES, (kind, id, bytes) => {
          if (!accepting) return;
          const request = decodeWorker(run, bytes);
          if (
            request?.requestId !== id ||
            (kind === 'request' ? request.kind !== 'acquire' : request.kind !== 'cancel')
          )
            return;
          broker.offer(bytes);
        })
        .then(() => {
          if (accepting) broker.sweep(SWEEP_ENTRIES);
        })
        .catch(() => {
          failure = true;
          void stop();
        })
        .finally(() => {
          activeSweep = undefined;
          schedule();
        });
    }, POLL_MS);
    timer.unref();
  }

  schedule();
  const provided: ProvidedCustody = { kind: 'available', run, inbox: inbox.path };
  return { provided, stop };
}
