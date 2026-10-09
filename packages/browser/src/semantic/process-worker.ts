import {
  NativeSemanticTargetSchema,
  NativeSemanticChangesSchema,
  NativeSemanticEditResultSchema,
} from './native-target.js';
import { settleSemanticOriginals, SemanticNativeWork } from './original-close.js';
import { TargetMetadataOwner } from '../runtime/target-metadata.js';
import { Socket } from 'node:net';
import { getHeapStatistics } from 'node:v8';
import { chromium, type Browser } from 'playwright-core';
import { z } from 'zod';
import { SemanticAdmissionIdentityV1Schema } from '@dorkos/shared/browser-semantic-schemas';
import { SupervisedSemanticReader } from './native-reader.js';
import { SemanticByteChannel, semanticRecord } from './byte-channel.js';
const reference = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
const request = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('initialize'),
      endpoint: z.string().max(2048),
      target: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal('read'),
      sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      identity: SemanticAdmissionIdentityV1Schema,
      actor: reference,
      grant: reference,
    })
    .strict(),
  z
    .object({
      kind: z.literal('resolve'),
      sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      lease: reference,
      node: reference,
      actor: reference,
      grant: reference,
    })
    .strict(),
  z
    .object({
      kind: z.literal('target'),
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      lease: reference,
      node: reference,
      actor: reference,
      grant: reference,
    })
    .strict(),
  z
    .object({
      kind: z.literal('changes'),
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      actor: reference,
      grant: reference,
    })
    .strict(),
  z
    .object({
      kind: z.literal('beginEdit'),
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      requestId: reference,
      lease: reference,
      node: reference,
      actor: reference,
      grant: reference,
    })
    .strict(),
  z
    .object({
      kind: z.literal('editPhase'),
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      requestId: reference,
      actor: reference,
      grant: reference,
      phase: z.enum(['idle', 'input', 'selection']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('finishEdit'),
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      requestId: reference,
      actor: reference,
      grant: reference,
    })
    .strict(),
  z.object({ kind: z.literal('close') }).strict(),
]);
/** Private original process entry; browser authority/input keep their separate original SDK connection. */
export async function runSemanticProcess(): Promise<void> {
  if (
    process.execArgv.join(' ') !== '--max-old-space-size=64 --max-semi-space-size=4' ||
    getHeapStatistics().heap_size_limit > 96 * 1024 * 1024
  )
    throw new Error('SEMANTIC_HEAP_BOUND_MISSING');
  const pipe = new Socket({
    fd: 3,
    readable: true,
    writable: true,
    allowHalfOpen: true,
  });
  const decoder = new SemanticByteChannel();
  const metadata = new TargetMetadataOwner();
  let browser: Browser | undefined,
    reader: SupervisedSemanticReader | undefined,
    started = false,
    closed = false;
  let first: { reason: unknown } | undefined,
    closing: Promise<void> | undefined,
    sequence = 0,
    busy = false;
  let connectionClose: (() => Promise<void>) | undefined, disconnecting: Promise<void> | undefined;
  const disconnect = (): Promise<void> => {
    if (!connectionClose) return Promise.resolve();
    return (disconnecting ??= Promise.resolve()
      .then(connectionClose)
      .catch((reason) => {
        first ??= { reason };
        throw reason;
      }));
  };
  const originals = new Set<Promise<unknown>>();
  const native = new SemanticNativeWork();
  let tail: Promise<void> = Promise.resolve();
  const own = <T>(producer: () => Promise<T>): Promise<T> => {
    let accept!: (value: T) => void, reject!: (reason: unknown) => void;
    const original = new Promise<T>((a, b) => {
      accept = a;
      reject = b;
    });
    originals.add(original);
    try {
      Promise.resolve(producer()).then(accept, reject);
    } catch (reason) {
      reject(reason);
    }
    void original.then(
      () => originals.delete(original),
      (reason) => {
        first ??= { reason };
        originals.delete(original);
      }
    );
    return original;
  };
  const send = (value: unknown) =>
    own(
      () =>
        new Promise<void>((resolve, reject) =>
          pipe.write(semanticRecord(value), (error) => (error ? reject(error) : resolve()))
        )
    );
  const close = (): Promise<void> => {
    closed = true;
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      const results = await settleSemanticOriginals(
        native.pending(),
        tail,
        [...originals],
        () => metadata.close(),
        () => reader?.close() ?? Promise.resolve(),
        disconnect
      );
      for (const result of results)
        if (result.status === 'rejected') first ??= { reason: result.reason };
      await send({ kind: 'closed', ok: !first });
      pipe.end();
      if (first) throw first.reason;
    });
    return closing;
  };
  const enter = async (value: unknown) => {
    const action = request.parse(value);
    if (closed) throw new Error('SEMANTIC_CLOSED');
    if (action.kind === 'initialize') {
      if (started) throw new Error('SEMANTIC_INITIALIZED');
      started = true;
      const endpoint = new URL(action.endpoint);
      if (
        endpoint.protocol !== 'ws:' ||
        endpoint.hostname !== '127.0.0.1' ||
        !/^\/semantic\/[A-Za-z0-9_-]{22}$/.test(endpoint.pathname) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw new Error('SEMANTIC_ENDPOINT');
      browser = await own(() =>
        native.run(() =>
          chromium.connectOverCDP(action.endpoint, {
            noDefaults: true,
            timeout: 1000,
          })
        )
      );
      connectionClose = browser.close.bind(browser);
      if (closed) {
        await disconnect();
        throw new Error('SEMANTIC_CLOSED');
      }
      const candidates = metadata.pages(() =>
        browser!.contexts().flatMap((context) => context.pages())
      );
      for (const page of candidates) {
        if (closed) throw new Error('SEMANTIC_CLOSED');
        const target = await own(() => native.run(() => metadata.read(page, () => !closed)));
        const exact = target.targetId === action.target;
        if (closed) throw new Error('SEMANTIC_CLOSED');
        if (exact) {
          if (reader) throw new Error('SEMANTIC_TARGET_DUPLICATE');
          reader = new SupervisedSemanticReader(page);
        }
      }
      if (!reader) throw new Error('SEMANTIC_TARGET_MISSING');
      await send({ kind: 'ready' });
      return;
    }
    if (action.kind === 'close') {
      void close().catch(() => {
        process.exitCode = 1;
        pipe.destroy();
      });
      return;
    }
    if (!reader || action.sequence <= sequence) throw new Error('SEMANTIC_SEQUENCE');
    sequence = action.sequence;
    const result =
      action.kind === 'read'
        ? await own(() =>
            native.run(() => reader!.read(action.identity, action.actor, action.grant))
          )
        : action.kind === 'resolve'
          ? await own(() =>
              native.run(() =>
                reader!.resolve(action.lease, action.node, action.actor, action.grant)
              )
            )
          : action.kind === 'target'
            ? NativeSemanticTargetSchema.nullable().parse(
                await own(() =>
                  native.run(() =>
                    reader!.target(action.lease, action.node, action.actor, action.grant)
                  )
                )
              )
            : action.kind === 'beginEdit'
              ? NativeSemanticTargetSchema.parse(
                  await own(() =>
                    native.run(() =>
                      reader!.beginEdit(
                        action.requestId,
                        action.lease,
                        action.node,
                        action.actor,
                        action.grant
                      )
                    )
                  )
                )
              : action.kind === 'editPhase'
                ? await own(() =>
                    native.run(async () => {
                      await reader!.editPhase(
                        action.requestId,
                        action.actor,
                        action.grant,
                        action.phase
                      );
                      return true;
                    })
                  )
                : action.kind === 'finishEdit'
                  ? NativeSemanticEditResultSchema.parse(
                      await own(() =>
                        native.run(() =>
                          reader!.finishEdit(action.requestId, action.actor, action.grant)
                        )
                      )
                    )
                  : NativeSemanticChangesSchema.parse(reader.changes(action.actor, action.grant));
    if (closed) throw new Error('SEMANTIC_CLOSED');
    await send({ kind: 'result', sequence, result });
  };
  pipe.on('data', (bytes: Buffer) => {
    try {
      decoder.receive(bytes, (value) => {
        const parsed = request.parse(value);
        if (parsed.kind === 'close') {
          void close().catch(() => {
            process.exitCode = 1;
            pipe.destroy();
          });
          return;
        }
        if (closed || busy) throw new Error('SEMANTIC_PENDING');
        busy = true;
        // Each original request owns the serialized work; no unbounded async message queue.
        const operation = tail.then(() => enter(parsed));
        tail = operation.then(
          () => {
            busy = false;
          },
          (reason) => {
            busy = false;
            first ??= { reason };
            void close().catch(() => {
              process.exitCode = 1;
              pipe.destroy();
            });
          }
        );
      });
    } catch (reason) {
      first ??= { reason };
      void close().catch(() => {
        process.exitCode = 1;
        pipe.destroy();
      });
    }
  });
  pipe.on('end', () => {
    try {
      decoder.finish();
    } catch (reason) {
      first ??= { reason };
    }
    void close().catch(() => {
      process.exitCode = 1;
      pipe.destroy();
    });
  });
  pipe.on('error', (reason) => {
    first ??= { reason };
    void close().catch(() => {
      process.exitCode = 1;
      pipe.destroy();
    });
  });
  await new Promise<void>((resolve) => pipe.once('close', resolve));
  await closing;
}
