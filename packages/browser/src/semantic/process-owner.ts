import {
  NativeSemanticTargetSchema,
  NativeSemanticChangesSchema,
  NativeSemanticEditResultSchema,
} from './native-target.js';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import {
  SemanticSnapshotV1Schema,
  type SemanticAdmissionIdentityV1,
} from '@dorkos/shared/browser-semantic-schemas';
import { z } from 'zod';
import { createSemanticRelay } from './bounded-relay.js';
import { SemanticByteChannel, semanticRecord } from './byte-channel.js';
const response = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }).strict(),
  z
    .object({
      kind: z.literal('result'),
      sequence: z.number().int().positive(),
      result: z.union([
        SemanticSnapshotV1Schema,
        z.boolean(),
        NativeSemanticTargetSchema.nullable(),
        NativeSemanticChangesSchema,
        NativeSemanticEditResultSchema,
      ]),
    })
    .strict(),
  z.object({ kind: z.literal('closed'), ok: z.boolean() }).strict(),
]);
export const SEMANTIC_WORKER_FLAGS = Object.freeze([
  '--max-old-space-size=64',
  '--max-semi-space-size=4',
]);
/**
 * Constructor-private original endpoint/target process owner. Spawn occurs only
 * under the existing retained supervisor; the native journal attributes its actual
 * descendant birth. This enforces a V8 heap ceiling, not an OS total-RSS ceiling.
 */
export async function createSemanticProcess(
  endpoint: string,
  target: string,
  originalWorkerPath = process.argv[1]!
) {
  const relay = await createSemanticRelay(endpoint);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      process.execPath,
      [...SEMANTIC_WORKER_FLAGS, originalWorkerPath, '--private-semantic-worker'],
      {
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      }
    );
  } catch (reason) {
    try {
      await relay.close();
    } catch {}
    throw reason;
  }
  let first: { reason: unknown } | undefined,
    closed = false,
    reported = false,
    readyReported = false,
    sequence = 0,
    closing: Promise<void> | undefined;
  const sends = new Set<Promise<void>>();
  let pending:
    | {
        sequence: number;
        resolve: (value: unknown) => void;
        reject: (reason: unknown) => void;
      }
    | undefined;
  let readyAccept!: () => void, readyReject!: (reason: unknown) => void;
  const ready = new Promise<void>((a, b) => {
    readyAccept = a;
    readyReject = b;
  });
  void ready.catch(() => {});
  const terminal = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const pipe = child.stdio[3];
  const streams = [child.stdout, child.stderr, pipe];
  const returns = streams.map((stream) =>
    stream ? new Promise<void>((resolve) => stream.once('close', resolve)) : Promise.resolve()
  );
  const fail = (reason: unknown) => {
    first ??= { reason };
    closed = true;
    readyReject(first.reason);
    pending?.reject(first.reason);
    pending = undefined;
  };
  void relay.failure.catch((reason) => {
    fail(reason);
    void close().catch(() => {});
  });
  const close = (): Promise<void> => {
    closed = true;
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      if (pipe instanceof Duplex && !pipe.destroyed)
        try {
          await send({ kind: 'close' });
          // EOF closes only our command half; the original reply/child/drains stay joined.
          pipe.end();
        } catch (reason) {
          fail(reason);
        }
      await Promise.allSettled([terminal, ...returns, ...sends]);
      try {
        await relay.close();
      } catch (reason) {
        fail(reason);
      }
      if (!reported || child.exitCode !== 0) fail(new Error('SEMANTIC_ORIGINAL_TERMINAL_UNKNOWN'));
      if (first) throw first.reason;
    });
    return closing;
  };
  const send = (value: unknown): Promise<void> => {
    if (!(pipe instanceof Duplex)) return Promise.reject(new Error('SEMANTIC_PIPE_MISSING'));
    let accept!: () => void, reject!: (reason: unknown) => void;
    const original = new Promise<void>((a, b) => {
      accept = a;
      reject = b;
    });
    sends.add(original);
    try {
      pipe.write(semanticRecord(value), (error) => (error ? reject(error) : accept()));
    } catch (reason) {
      reject(reason);
    }
    void original.then(
      () => sends.delete(original),
      (reason) => {
        fail(reason);
        sends.delete(original);
      }
    );
    return original;
  };
  const decoder = new SemanticByteChannel();
  if (pipe instanceof Duplex) {
    pipe.on('data', (bytes: Buffer) => {
      try {
        decoder.receive(bytes, (value) => {
          const reply = response.parse(value);
          if (reply.kind === 'ready') {
            if (closed || sequence || readyReported) throw new Error('SEMANTIC_READY');
            readyReported = true;
            readyAccept();
            return;
          }
          if (reply.kind === 'closed') {
            if (!closing || reported || !readyReported) throw new Error('SEMANTIC_CLOSE_REPORT');
            reported = true;
            if (!reply.ok) fail(new Error('SEMANTIC_WORKER_FAILED'));
            return;
          }
          if (closed || !pending || reply.sequence !== pending.sequence)
            throw new Error('SEMANTIC_REPLY');
          const original = pending;
          pending = undefined;
          original.resolve(reply.result);
        });
      } catch (reason) {
        fail(reason);
        void close().catch(() => {});
      }
    });
    pipe.on('end', () => {
      try {
        decoder.finish();
      } catch (reason) {
        fail(reason);
      }
    });
    pipe.on('error', (reason) => {
      fail(reason);
      void close().catch(() => {});
    });
  }
  // Both output drains are original finite facts; no worker string is published.
  for (const stream of [child.stdout, child.stderr])
    if (stream) {
      let bytes = 0;
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 262144) {
          fail(new Error('SEMANTIC_DIAGNOSTIC_EXCEEDED'));
          void close().catch(() => {});
        }
      });
      stream.on('error', (reason) => {
        fail(reason);
        void close().catch(() => {});
      });
    }
  child.once('error', (reason) => {
    fail(reason);
    void close().catch(() => {});
  });
  child.once('exit', (code) => {
    if (code !== 0 || !readyReported) {
      fail(new Error('SEMANTIC_WORKER_TERMINAL'));
      void close().catch(() => {});
    }
    pending?.reject(new Error('SEMANTIC_UNAVAILABLE'));
    pending = undefined;
  });
  child.once('close', () => {
    if (!reported) {
      fail(new Error('SEMANTIC_WORKER_TERMINAL'));
      void close().catch(() => {});
    }
  });
  const invoke = async (action: object): Promise<unknown> => {
    if (first) throw first.reason;
    if (closed || pending || sequence === Number.MAX_SAFE_INTEGER) throw new Error('SEMANTIC_BUSY');
    const id = ++sequence;
    const original = new Promise<unknown>((resolve, reject) => {
      pending = { sequence: id, resolve, reject };
    });
    void original.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await send({ ...action, sequence: id });
      return await Promise.race([
        original,
        new Promise<never>((_a, b) => {
          timer = setTimeout(() => {
            const reason = new Error('SEMANTIC_DEADLINE');
            fail(reason);
            void close().catch(() => {});
            b(reason);
          }, 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    await send({ kind: 'initialize', endpoint: relay.endpoint, target });
    await ready;
  } catch (reason) {
    fail(reason);
    await close();
    throw reason;
  }
  return Object.freeze({
    async read(identity: SemanticAdmissionIdentityV1, actor: string, grant: string) {
      return SemanticSnapshotV1Schema.parse(await invoke({ kind: 'read', identity, actor, grant }));
    },
    async resolve(lease: string, node: string, actor: string, grant: string) {
      return z.boolean().parse(await invoke({ kind: 'resolve', lease, node, actor, grant }));
    },
    async target(lease: string, node: string, actor: string, grant: string) {
      return NativeSemanticTargetSchema.nullable().parse(
        await invoke({ kind: 'target', lease, node, actor, grant })
      );
    },
    async changes(actor: string, grant: string) {
      return NativeSemanticChangesSchema.parse(await invoke({ kind: 'changes', actor, grant }));
    },
    async beginEdit(requestId: string, lease: string, node: string, actor: string, grant: string) {
      return NativeSemanticTargetSchema.parse(
        await invoke({
          kind: 'beginEdit',
          requestId,
          lease,
          node,
          actor,
          grant,
        })
      );
    },
    async editPhase(
      requestId: string,
      actor: string,
      grant: string,
      phase: 'idle' | 'input' | 'selection'
    ) {
      z.literal(true).parse(await invoke({ kind: 'editPhase', requestId, actor, grant, phase }));
    },
    async finishEdit(requestId: string, actor: string, grant: string) {
      return NativeSemanticEditResultSchema.parse(
        await invoke({ kind: 'finishEdit', requestId, actor, grant })
      );
    },
    close,
  });
}
