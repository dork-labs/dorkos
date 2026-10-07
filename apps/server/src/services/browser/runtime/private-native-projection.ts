import { egressPolicyCodes } from '../egress/errors.js';
import type { OriginalConnectDenialObserver } from '../egress/broker/connect-denial.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { BrowserBindingSchema } from '@dorkos/shared/browser-schemas';
import type {
  PrivateBrowserResourceOwner,
  PrivateViewerSampleObserver,
  PrivateViewerCensus,
} from './private-native-acceptance.js';

const identity = z
  .object({
    pid: z.number().int().positive().max(2147483647),
    birth: z.string().regex(/^darwin-bsd-start:[0-9]+:[0-9]+$/u),
  })
  .strict();
const birth = z
  .object({
    browserId: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    browserGeneration: z.number().int().nonnegative().safe(),
    root: identity,
    supervisor: identity,
    manager: identity,
    identities: z.array(identity).max(512),
    complete: z.boolean(),
  })
  .strict();
const viewerSample = z
  .object({
    at: z.number().finite().nonnegative(),
    binding: BrowserBindingSchema,
    viewerId: z.string(),
    pendingFrames: z.number().int().min(0).max(1),
    pendingBytes: z
      .number()
      .int()
      .min(0)
      .max(2 * 1024 * 1024),
    encodingMs: z.number().finite().nonnegative().nullable(),
    droppedFrames: z.number().int().nonnegative(),
    closed: z.boolean(),
  })
  .strict();
export type OriginalViewerSample = Readonly<z.infer<typeof viewerSample>>;
const nonce = z.string().regex(/^[a-f0-9]{48}$/u);
const hello = z
  .object({
    type: z.literal('original-native-hello'),
    version: z.literal(1),
    nonce,
    pid: identity.shape.pid,
  })
  .strict();
const ready = z
  .object({ type: z.literal('original-native-ready'), version: z.literal(1), nonce })
  .strict();
const projected = z
  .object({
    type: z.literal('original-native-birth'),
    version: z.literal(1),
    nonce,
    sequence: z.number().int().positive().max(128),
    birth,
  })
  .strict();
const acknowledgment = z
  .object({
    type: z.literal('original-native-ack'),
    version: z.literal(1),
    nonce,
    sequence: projected.shape.sequence,
    browserId: birth.shape.browserId,
    browserGeneration: birth.shape.browserGeneration,
    accepted: z.boolean(),
  })
  .strict();
const sampled = z
  .object({
    type: z.literal('original-native-viewer'),
    version: z.literal(1),
    nonce,
    sequence: z.number().int().positive().max(8192),
    sample: viewerSample,
  })
  .strict();
const census = z
  .object({
    type: z.literal('original-native-viewer-census'),
    version: z.literal(1),
    nonce,
    sequence: z.number().int().positive().max(8192),
    browserId: birth.shape.browserId,
    browserGeneration: birth.shape.browserGeneration,
    at: z.number().int().nonnegative().safe(),
    subscriptions: z.number().int().min(0).max(16),
    closed: z.boolean(),
  })
  .strict();
const connectDenied = z
  .object({
    type: z.literal('original-native-connect-denied'),
    version: z.literal(1),
    nonce,
    sequence: z.number().int().positive().max(256),
    browserId: birth.shape.browserId,
    browserGeneration: birth.shape.browserGeneration,
    authority: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[a-z0-9.[\]:_-]+$/u),
    outcome: z.literal('denied'),
    beforeDial: z.literal(true),
    reason: z.enum(egressPolicyCodes),
  })
  .strict();
export type OriginalProjectedConnectDenial = Readonly<z.infer<typeof connectDenied>>;
export type OriginalViewerCensus = Readonly<z.infer<typeof census>>;
export type OriginalNativeBirth = Readonly<
  Omit<z.infer<typeof birth>, 'identities'> & {
    identities: readonly Readonly<z.infer<typeof identity>>[];
  }
>;
/** Only the original Node IPC channel constructors supply this port. No route/config accepts it. */
export interface OriginalNativeChannel {
  send(message: object, callback: (error: unknown) => void): unknown;
  disconnect(): void;
  on(event: 'message' | 'disconnect', callback: (...args: unknown[]) => void): void;
  off(event: 'message' | 'disconnect', callback: (...args: unknown[]) => void): void;
}
const immutable = (value: z.infer<typeof birth>): OriginalNativeBirth =>
  Object.freeze({
    ...value,
    root: Object.freeze({ ...value.root }),
    supervisor: Object.freeze({ ...value.supervisor }),
    manager: Object.freeze({ ...value.manager }),
    identities: Object.freeze(value.identities.map((row) => Object.freeze({ ...row }))),
  });
const same = (a: z.infer<typeof identity>, b: z.infer<typeof identity>) =>
  a.pid === b.pid && a.birth === b.birth;
function bank(channel: OriginalNativeChannel) {
  const send = channel.send.bind(channel),
    disconnect = channel.disconnect.bind(channel),
    on = channel.on.bind(channel),
    off = channel.off.bind(channel);
  const work = new Set<Promise<unknown>>();
  let first: Readonly<{ value: unknown }> | undefined,
    closed = false,
    disconnected = false;
  const fail = (value: unknown) => {
    first ??= { value };
  };
  const guard = () => {
    if (first) throw first.value;
    if (closed) throw new Error('ORIGINAL_NATIVE_CHANNEL_CLOSED');
  };
  const own = <T>(job: Promise<T>): Promise<T> => {
    work.add(job);
    void job.then(
      () => work.delete(job),
      (value) => {
        fail(value);
        work.delete(job);
      }
    );
    return job;
  };
  const emit = (message: object): Promise<void> => {
    // Retain the callback duty before invoking the original, even for synchronous throw/backpressure.
    let resolve!: () => void, reject!: (value: unknown) => void;
    const job = own(
      new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      })
    );
    try {
      send(message, (error) => {
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    } catch (value) {
      reject(value);
    }
    return job;
  };
  return {
    on,
    off,
    own,
    emit,
    fail,
    guard,
    assertFailure() {
      if (first) throw first.value;
    },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      try {
        disconnect();
      } catch (value) {
        fail(value);
      }
    },
    stop: () => {
      closed = true;
    },
    async join() {
      for (const result of await Promise.allSettled([...work]))
        if (result.status === 'rejected') fail(result.reason);
      if (first) throw first.value;
    },
  };
}

/** Original server-side producer. Birth ACK is joined before SDK initialization proceeds. */
export function createOriginalNativeProjectionSender(channel: OriginalNativeChannel, pid: number) {
  const original = bank(channel),
    key = randomBytes(24).toString('hex');
  let sequence = 0,
    started = false;
  let resolveReady!: () => void, rejectReady!: (value: unknown) => void;
  const readyJob = original.own(
    new Promise<void>((yes, no) => {
      resolveReady = yes;
      rejectReady = no;
    })
  );
  const pending = new Map<
    number,
    { birth: OriginalNativeBirth; resolve(): void; reject(value: unknown): void }
  >();
  const terminate = (value: unknown) => {
    original.fail(value);
    original.stop();
    rejectReady(value);
    for (const valuePending of pending.values()) valuePending.reject(value);
    original.disconnect();
  };
  const receive = (raw: unknown) => {
    try {
      original.guard();
      if (!started) {
        const value = ready.parse(raw);
        if (value.nonce !== key) throw new Error('ORIGINAL_NATIVE_READY_MISMATCH');
        started = true;
        resolveReady();
        return;
      }
      const value = acknowledgment.parse(raw),
        held = pending.get(value.sequence);
      if (
        value.nonce !== key ||
        !held ||
        value.browserId !== held.birth.browserId ||
        value.browserGeneration !== held.birth.browserGeneration
      )
        throw new Error('ORIGINAL_NATIVE_ACK_MISMATCH');
      if (!value.accepted) throw new Error('ORIGINAL_NATIVE_BIRTH_REFUSED');
      pending.delete(value.sequence);
      held.resolve();
    } catch (value) {
      terminate(value);
    }
  };
  const disconnected = () => terminate(new Error('ORIGINAL_NATIVE_CHANNEL_EOF'));
  original.on('message', receive);
  original.on('disconnect', disconnected);
  const initialSend = original.emit(
    hello.parse({ type: 'original-native-hello', version: 1, nonce: key, pid })
  );
  const resources: PrivateBrowserResourceOwner = Object.freeze({
    async onOriginalChild(
      receiver: Parameters<PrivateBrowserResourceOwner['onOriginalChild']>[0],
      value: Parameters<PrivateBrowserResourceOwner['onOriginalChild']>[1]
    ) {
      const captured = immutable(
        birth.parse({
          browserId: receiver.browserId,
          browserGeneration: receiver.browserGeneration,
          ...value,
        })
      );
      // Store the ACK before any send or admission callback can fail/reenter.
      const number = ++sequence;
      let resolve!: () => void, reject!: (value: unknown) => void;
      const ack = original.own(
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        })
      );
      pending.set(number, { birth: captured, resolve, reject });
      try {
        original.guard();
        if (number > 128 || captured.manager.pid !== pid || !receiver.isOrdinary())
          throw new Error('ORIGINAL_NATIVE_PRODUCER_REFUSED');
        await initialSend;
        await readyJob;
        original.guard();
        if (!receiver.isOrdinary()) throw new Error('ORIGINAL_NATIVE_PRODUCER_REVOKED');
        await original.emit(
          projected.parse({
            type: 'original-native-birth',
            version: 1,
            nonce: key,
            sequence: number,
            birth: captured,
          })
        );
        await ack;
        original.guard();
        if (!receiver.isOrdinary()) throw new Error('ORIGINAL_NATIVE_PRODUCER_REVOKED');
      } catch (value) {
        terminate(value);
        throw value;
      }
    },
  });
  let viewerSequence = 0;
  const viewerSamples: PrivateViewerSampleObserver = (value) => {
    original.guard();
    try {
      const sample = viewerSample.parse(value);
      const payload = sampled.parse({
        type: 'original-native-viewer',
        version: 1,
        nonce: key,
        sequence: ++viewerSequence,
        sample,
      });
      const job = original.own(
        Promise.resolve().then(async () => {
          await initialSend;
          await readyJob;
          original.guard();
          await original.emit(payload);
          original.guard();
        })
      );
      void job.catch(terminate);
    } catch (value) {
      terminate(value);
      throw value;
    }
  };
  let censusSequence = 0;
  viewerSamples.census = (scope) => {
    const browserId = birth.shape.browserId.parse(scope.browserId),
      browserGeneration = birth.shape.browserGeneration.parse(scope.browserGeneration);
    return (value: PrivateViewerCensus) => {
      original.guard();
      try {
        const payload = census.parse({
          type: 'original-native-viewer-census',
          version: 1,
          nonce: key,
          sequence: ++censusSequence,
          browserId,
          browserGeneration,
          ...value,
        });
        const job = original.own(
          Promise.resolve().then(async () => {
            await initialSend;
            await readyJob;
            original.guard();
            await original.emit(payload);
            original.guard();
          })
        );
        void job.catch(terminate);
      } catch (value) {
        terminate(value);
        throw value;
      }
    };
  };
  let connectSequence = 0;
  const connectDenials: OriginalConnectDenialObserver = (value) => {
    original.guard();
    try {
      const payload = connectDenied.parse({
        ...value,
        type: 'original-native-connect-denied',
        version: 1,
        nonce: key,
        sequence: ++connectSequence,
      });
      const job = original.own(
        Promise.resolve().then(async () => {
          await initialSend;
          await readyJob;
          original.guard();
          await original.emit(payload);
          original.guard();
        })
      );
      void job.catch(terminate);
    } catch (value) {
      terminate(value);
      throw value;
    }
  };
  const beginClose = () => {
    original.stop();
    const value = new Error('ORIGINAL_NATIVE_CHANNEL_CLOSED');
    rejectReady(value);
    for (const held of pending.values()) held.reject(value);
  };
  return Object.freeze({
    resources,
    viewerSamples,
    connectDenials,
    assertCurrent: original.guard,
    beginClose,
    async close() {
      beginClose();
      original.off('message', receive);
      original.off('disconnect', disconnected);
      try {
        await original.join();
      } finally {
        original.disconnect();
      }
      original.assertFailure();
    },
  });
}

const originalConnectBanks = new WeakMap<object, () => readonly OriginalProjectedConnectDenial[]>();
/** Private acceptance reads only the bank retained by the original receiver constructor. */
export function readOriginalConnectDenialBank(receiver: unknown) {
  const read =
    typeof receiver === 'object' && receiver !== null
      ? originalConnectBanks.get(receiver)
      : undefined;
  if (!read) throw new Error('ORIGINAL_NATIVE_CONNECT_BANK_REQUIRED');
  return read();
}

/** Parent constructor captures the actual CLI ChildProcess channel and its retained validator. */
export function createOriginalNativeProjectionReceiver(
  options: Readonly<{
    channel: OriginalNativeChannel;
    pid: number;
    retainBirth(value: OriginalNativeBirth): Promise<void>;
    retainViewerSample(value: OriginalViewerSample): Promise<void>;
    retainViewerCensus?(value: OriginalViewerCensus): Promise<void>;
    retainConnectDenial?(value: OriginalProjectedConnectDenial): Promise<void>;
  }>
) {
  const original = bank(options.channel),
    retainBirth = options.retainBirth.bind(options),
    retainViewerSample = options.retainViewerSample.bind(options),
    pid = options.pid;
  let key: string | undefined,
    sequence = 0,
    viewerSequence = 0,
    censusSequence = 0,
    connectSequence = 0;
  const retainViewerCensus = options.retainViewerCensus?.bind(options);
  const births = new Map<string, OriginalNativeBirth>();
  const acceptedGenerations = new Set<string>();
  const connectDenials: OriginalProjectedConnectDenial[] = [];
  const retainConnectDenial = options.retainConnectDenial?.bind(options);
  const disconnected = () => original.stop();
  const receive = (raw: unknown) => {
    const job = original.own(
      Promise.resolve().then(async () => {
        original.guard();
        if (key === undefined) {
          const value = hello.parse(raw);
          if (value.pid !== pid) throw new Error('ORIGINAL_NATIVE_MANAGER_MISMATCH');
          key = value.nonce;
          await original.emit(
            ready.parse({ type: 'original-native-ready', version: 1, nonce: key })
          );
          original.guard();
          return;
        }
        if (connectDenied.safeParse(raw).success) {
          const value = connectDenied.parse(raw);
          if (
            value.nonce !== key ||
            value.sequence !== connectSequence + 1 ||
            !acceptedGenerations.has(value.browserId + ':' + value.browserGeneration)
          )
            throw new Error('ORIGINAL_NATIVE_CONNECT_DENIAL_CORRELATION');
          connectSequence = value.sequence;
          const retained = Object.freeze(value);
          connectDenials.push(retained);
          await retainConnectDenial?.(retained);
          original.guard();
          return;
        }
        if (census.safeParse(raw).success) {
          const value = census.parse(raw);
          if (
            value.nonce !== key ||
            value.sequence !== censusSequence + 1 ||
            !births.has(value.browserId + ':' + value.browserGeneration)
          )
            throw new Error('ORIGINAL_NATIVE_VIEWER_CENSUS_CORRELATION');
          censusSequence = value.sequence;
          await retainViewerCensus?.(Object.freeze(value));
          original.guard();
          return;
        }
        if (sampled.safeParse(raw).success) {
          const value = sampled.parse(raw);
          if (value.nonce !== key || value.sequence !== viewerSequence + 1)
            throw new Error('ORIGINAL_NATIVE_VIEWER_CORRELATION');
          viewerSequence = value.sequence;
          await retainViewerSample(
            Object.freeze({ ...value.sample, binding: Object.freeze({ ...value.sample.binding }) })
          );
          original.guard();
          return;
        }
        const value = projected.parse(raw),
          captured = immutable(value.birth);
        if (value.nonce !== key || value.sequence !== sequence + 1 || captured.manager.pid !== pid)
          throw new Error('ORIGINAL_NATIVE_BIRTH_CORRELATION');
        sequence = value.sequence;
        const binding = captured.browserId + ':' + captured.browserGeneration;
        if (births.has(binding)) throw new Error('ORIGINAL_NATIVE_GENERATION_REPLACED');
        // Retain every correlated generation even if the original validator refuses or throws falsy.
        births.set(binding, captured);
        let failure: Readonly<{ value: unknown }> | undefined;
        try {
          await retainBirth(captured);
          original.guard();
          if (
            !captured.complete ||
            !captured.identities.some((row) => same(row, captured.root)) ||
            new Set(captured.identities.map((row) => row.pid)).size !== captured.identities.length
          )
            throw new Error('ORIGINAL_NATIVE_COMPLETE_BIRTH_REQUIRED');
          // Physical retention precedes validation; only validated generations can publish denial evidence.
          // Mark before the original ACK send, whose delivery can synchronously admit the child.
          acceptedGenerations.add(binding);
        } catch (value) {
          failure = { value };
          original.fail(value);
        }
        // An actual refusal is transmitted through the original send callback, never a fabricated success ACK.
        try {
          await original.emit(
            acknowledgment.parse({
              type: 'original-native-ack',
              version: 1,
              nonce: key,
              sequence: value.sequence,
              browserId: captured.browserId,
              browserGeneration: captured.browserGeneration,
              accepted: !failure,
            })
          );
        } catch (value) {
          failure ??= { value };
        }
        if (failure) throw failure.value;
        original.guard();
      })
    );
    void job.catch(() => {
      original.stop();
      original.disconnect();
    });
  };
  original.on('message', receive);
  original.on('disconnect', disconnected);
  const receiver = Object.freeze({
    births: () => Object.freeze([...births.values()]),
    connectDenials: () => Object.freeze([...connectDenials]),
    assertCurrent: original.guard,
    async close() {
      original.stop();
      original.off('message', receive);
      original.off('disconnect', disconnected);
      await original.join();
    },
  });
  originalConnectBanks.set(receiver, () => {
    original.assertFailure();
    return receiver.connectDenials();
  });
  return receiver;
}

// Private test arm intentionally has no public env schema or configuration field.
// eslint-disable-next-line no-restricted-syntax -- constructor-private fixture opt-in
const PRIVATE_NATIVE_ACCEPTANCE = process.env.DORKOS_BROWSER_PRIVATE_NATIVE_ACCEPTANCE === '1';
let processProjection: ReturnType<typeof createOriginalNativeProjectionSender> | undefined;
/** Called synchronously by the original startup constructor; a normal CLI has no IPC channel. */
export function readOriginalProcessNativeProjection(armed = PRIVATE_NATIVE_ACCEPTANCE) {
  if (!armed) return undefined;
  if (processProjection) return processProjection;
  if (!process.channel || !process.send) return undefined;
  return (processProjection ??= createOriginalNativeProjectionSender(
    {
      send: process.send.bind(process),
      disconnect: () => {
        if (process.connected) process.disconnect();
      },
      on: (event, callback) => {
        process.on(event, callback);
      },
      off: (event, callback) => {
        process.off(event, callback);
      },
    },
    process.pid
  ));
}
