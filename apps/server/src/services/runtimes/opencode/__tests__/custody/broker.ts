/** Test-private broker state. Filesystem, scheduling and owned endpoints are adapters. */
import {
  decodeWorker,
  encodeMetadata,
  validConnection,
  validRunDescriptor,
  type ConnectionDescriptor,
  type RunDescriptor,
  type WorkerMetadata,
} from './metadata.js';

type Acquire = Extract<WorkerMetadata, { kind: 'acquire' }>;
type Refusal = 'expired' | 'busy' | 'unavailable';
type Closure = 'closed' | 'cleanup-uncertain';

interface Endpoint {
  /** Negotiation metadata only. The worker sends spawn input to another channel. */
  connection: ConnectionDescriptor;
  /** Settled by the separate, authenticated scope channel. */
  scopeEnded: Promise<void>;
  /** Resolves only once the worker has presented the current endpoint token. */
  scopeConnected: Promise<void>;
  /** Only the main-side owner may hold or close this writer. */
  closeMain(): void;
  join(deadline: number): Promise<Closure>;
}

interface BrokerIO {
  now(): number;
  at(deadline: number, callback: () => void): () => void;
  /** A rejection means no live writer remains in the factory. */
  open(request: Acquire, signal: AbortSignal): Promise<Endpoint>;
  /** Recheck the signal immediately before atomically publishing metadata. */
  publish(
    request: Acquire,
    reply: Uint8Array,
    signal: AbortSignal,
    expectedReady?: Uint8Array
  ): Promise<void>;
  withdraw(request: Acquire): Promise<void>;
}

interface Claim {
  request: Acquire;
  controller: AbortController;
  cancelExpiry: () => void;
  opening?: Promise<Endpoint>;
  endpoint?: Endpoint;
  closing?: Promise<Closure>;
  publishing?: Promise<void>;
  keepRefusal?: boolean;
  refusal?: Refusal;
}

function matches(a: WorkerMetadata, b: WorkerMetadata): boolean {
  return a.scopeId === b.scopeId && a.requestId === b.requestId;
}

function waitForConnection(endpoint: Endpoint, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (connected: boolean) => {
      signal.removeEventListener('abort', abort);
      resolve(connected);
    };
    const abort = () => finish(false);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    void endpoint.scopeEnded.then(
      () => finish(false),
      () => finish(false)
    );
    void endpoint.scopeConnected.then(
      () => finish(true),
      () => finish(false)
    );
  });
}

/**
 * Owns one broker generation. Its caller batches scans and supplies the real
 * file/endpoint adapters. Construction starts no timer, process or listener.
 */
export function createCustodyBroker(descriptor: RunDescriptor, io: BrokerIO, cleanupMs: number) {
  if (!validRunDescriptor(descriptor) || !Number.isSafeInteger(cleanupMs) || cleanupMs <= 0)
    throw new Error('Invalid custody broker configuration');
  const run = Object.freeze({ ...descriptor });
  const scopes = new Map<string, Claim>();
  const claims = new Map<string, Claim>();
  const refusals = new Set<Claim>();
  const consumed = new Map<string, string>();
  const queue = new Map<string, Claim>();
  let accepting = true;
  let teardown: Promise<Closure> | undefined;

  function current(claim: Claim): boolean {
    const { request } = claim;
    return (
      accepting &&
      !claim.controller.signal.aborted &&
      scopes.get(request.scopeId) === claim &&
      (request.deadline === null || io.now() < request.deadline)
    );
  }

  function retire(claim: Claim, deadline = io.now() + cleanupMs): Promise<Closure> {
    if (claim.closing) return claim.closing;
    let cancelLimit: (() => void) | undefined;
    const limit = new Promise<Closure>((resolve) => {
      cancelLimit = io.at(deadline, () => resolve('cleanup-uncertain'));
    });
    const finish = async (): Promise<Closure> => {
      let endpoint: Endpoint | undefined;
      let mainClosed = true;
      try {
        endpoint = claim.endpoint ?? (await claim.opening?.catch(() => undefined));
        if (endpoint && endpoint !== claim.endpoint) endpoint.closeMain();
      } catch {
        mainClosed = false;
      }
      const results = await Promise.allSettled([
        Promise.resolve().then(async () => {
          await claim.publishing?.catch(() => undefined);
          if (!claim.keepRefusal) await io.withdraw(claim.request);
        }),
        Promise.resolve().then(() => endpoint?.join(deadline) ?? 'closed'),
      ]);
      return mainClosed &&
        results.every(
          (result) =>
            result.status === 'fulfilled' &&
            (result.value === undefined || result.value === 'closed')
        )
        ? 'closed'
        : 'cleanup-uncertain';
    };
    // Memoize before abort dispatch, which may re-enter retirement synchronously.
    const joined = Promise.resolve().then(finish);
    let writerFailed = false;
    claim.closing = Promise.race([joined, limit]).then((status) => {
      cancelLimit?.();
      if (writerFailed) return 'cleanup-uncertain';
      if (status === 'closed') {
        claims.delete(claim.request.requestId);
        if (scopes.get(claim.request.scopeId) === claim) scopes.delete(claim.request.scopeId);
      }
      return status;
    });
    queue.delete(claim.request.requestId);
    claim.cancelExpiry();
    claim.controller.abort();
    try {
      claim.endpoint?.closeMain();
    } catch {
      writerFailed = true;
    }
    return claim.closing;
  }

  async function refuse(claim: Claim, reason: Refusal, expectedReady?: Uint8Array) {
    const { request, controller } = claim;
    if (!accepting || controller.signal.aborted) return;
    try {
      claim.publishing = io.publish(
        request,
        encodeMetadata(run, {
          kind: 'refused',
          requestId: request.requestId,
          scopeId: request.scopeId,
          reason,
        }),
        controller.signal,
        expectedReady
      );
      await claim.publishing;
      if (accepting && !controller.signal.aborted) {
        claim.keepRefusal = true;
        refusals.add(claim);
      }
    } catch {
      // An adapter write failure must not leak its details.
    }
  }

  async function serve(claim: Claim) {
    const { request, controller } = claim;
    let connected = false;
    try {
      if (claim.refusal) {
        await refuse(claim, claim.refusal);
        return;
      }
      if (!current(claim)) return;
      claim.opening = Promise.resolve().then(() => {
        if (!current(claim)) throw new Error('Custody request no longer current');
        return io.open(request, controller.signal);
      });
      const endpoint = await claim.opening;
      // Retirement already owns any late endpoint returned by opening.
      if (claim.closing) return;
      claim.endpoint = endpoint;
      if (!current(claim)) return;
      if (!validConnection(endpoint.connection)) {
        await refuse(claim, 'unavailable');
        return;
      }
      const connection = waitForConnection(endpoint, controller.signal);
      const ready = encodeMetadata(run, {
        kind: 'ready',
        requestId: request.requestId,
        scopeId: request.scopeId,
        connection: endpoint.connection,
      });
      claim.publishing = io.publish(request, ready, controller.signal);
      await claim.publishing;
      connected = current(claim) && (await connection) && current(claim);
      if (connected) {
        claim.cancelExpiry();
        void endpoint.scopeEnded.then(
          () => retire(claim),
          () => retire(claim)
        );
      } else if (current(claim)) {
        // The ready record may already be visible. Replace it atomically so
        // a worker that has not read it still gets a correlated terminal.
        await refuse(claim, 'unavailable', ready);
      }
    } catch {
      if (current(claim)) await refuse(claim, 'unavailable');
    } finally {
      if (!connected) await retire(claim);
    }
  }

  return {
    /** Offer an already bounded file. Invalid, stale and duplicate records have no effect. */
    offer(bytes: Uint8Array): boolean {
      if (!accepting) return false;
      const data = decodeWorker(run, bytes);
      if (!data) return false;
      const scope = scopes.get(data.scopeId);
      if (data.kind === 'cancel') {
        const owned = claims.get(data.requestId);
        if (owned && matches(owned.request, data)) {
          void retire(owned);
          return true;
        }
        if (consumed.has(data.requestId)) return false;
        consumed.set(data.requestId, data.scopeId);
        return true;
      }
      if (consumed.has(data.requestId)) return false;
      consumed.set(data.requestId, data.scopeId);
      const refusal =
        data.deadline !== null && data.deadline <= io.now()
          ? 'expired'
          : scope
            ? 'busy'
            : undefined;
      const claim: Claim = {
        request: data,
        controller: new AbortController(),
        cancelExpiry: () => undefined,
        refusal,
      };
      claims.set(data.requestId, claim);
      if (!refusal) scopes.set(data.scopeId, claim);
      queue.set(data.requestId, claim);
      if (!refusal && data.deadline !== null)
        claim.cancelExpiry = io.at(data.deadline, () => {
          void retire(claim);
        });
      return true;
    },

    /** FIFO within the generation, without waiting for a slow endpoint in the sweep. */
    sweep(limit: number): number {
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new RangeError('A positive custody sweep limit is required');
      let processed = 0;
      for (const [id, claim] of queue) {
        if (!accepting || processed === limit) break;
        queue.delete(id);
        processed++;
        void serve(claim);
      }
      return processed;
    },

    /** Stop admission and close owned writers synchronously before waiting for joins. */
    close(): Promise<Closure> {
      if (teardown) return teardown;
      accepting = false;
      const deadline = io.now() + cleanupMs;
      const outstanding = [...claims.values()];
      const priorReplies = [...refusals];
      teardown = Promise.resolve().then(async () => {
        let cancelLimit: (() => void) | undefined;
        const limit = new Promise<Closure>((resolve) => {
          cancelLimit = io.at(deadline, () => resolve('cleanup-uncertain'));
        });
        const joined = Promise.allSettled([
          ...outstanding.map((claim) => retire(claim, deadline)),
          ...priorReplies.map((claim) => Promise.resolve().then(() => io.withdraw(claim.request))),
        ]).then((facts): Closure =>
          facts.every(
            (fact) =>
              fact.status === 'fulfilled' && (fact.value === undefined || fact.value === 'closed')
          )
            ? 'closed'
            : 'cleanup-uncertain'
        );
        const result = await Promise.race([joined, limit]);
        cancelLimit?.();
        return result;
      });
      for (const claim of outstanding) void retire(claim, deadline);
      return teardown;
    },
  };
}
