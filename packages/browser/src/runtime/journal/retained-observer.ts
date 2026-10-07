import type { ProcessIdentity } from '../../configuration.js';
import {
  parseDarwinChildrenBatch,
  parseDarwinProcessBatch,
  verifyOriginalDarwinObserverArtifact,
  type DarwinProcessObserver,
} from '../darwin-process-observer.js';
import {
  acceptsDarwinOwnedChildReturn,
  createDarwinOwnedChildLauncher,
  type DarwinOwnedChild,
} from '../darwin-owned-child.js';

// Closed print_reply framing (including newline) is <=512 bytes; every fact plus
// its comma is <=160 bytes: signed32 pid/error, uint64 timestamps, fixed enums.
// No request id or arbitrary strings are emitted. Each C request may emit512 facts.
const maximumReply = (command: 'I' | 'C', count: number) =>
  512 + 160 * (command === 'C' ? 512 : count);
const childCap = 256 * 1024;
interface Peer {
  original: DarwinOwnedChild;
  bytes: number;
  buffer: Buffer;
  retiring: boolean;
  reply?: { maximum: number; resolve(bytes: Uint8Array): void; reject(value: unknown): void };
  close?: Promise<void>;
}
/** Journal-only receiver. Rotation is between requests; no fact or file proof is cached. */
export async function openRetainedDarwinObserver(
  options: Readonly<{
    artifact: Readonly<{ path: string; sha256: string }>;
    manager: ProcessIdentity;
  }>
): Promise<Readonly<{ observer: DarwinProcessObserver; close(): Promise<void> }>> {
  const artifact = Object.freeze({ ...options.artifact });
  const manager = Object.freeze({ ...options.manager });
  let first: { value: unknown } | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let peer: Peer | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const jobs = new Set<Promise<unknown>>();
  const fail = (value: unknown) => {
    first ??= { value };
    peer?.reply?.reject(first.value);
  };
  const checkOriginal = () => {
    if (first) throw first.value;
  };
  const check = () => {
    checkOriginal();
    if (closed) throw new Error('PROCESS_OBSERVER_CLOSED');
  };
  const closePeer = (original: Peer): Promise<void> => {
    if (original.close) return original.close;
    let resolve!: () => void, reject!: (value: unknown) => void;
    original.close = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void original.close.catch(() => {});
    original.retiring = true;
    void (async () => {
      const stdin = original.original.child.stdin;
      let stopEntered = false;
      const stopOriginal = () => {
        if (stopEntered) return;
        stopEntered = true;
        try {
          if (!original.original.child.kill('SIGTERM'))
            fail(new Error('PROCESS_OBSERVATION_UNAVAILABLE'));
        } catch (value) {
          fail(value);
        }
      };
      const ended = new Promise<void>((yes, no) => {
        try {
          if (!stdin) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
          stdin.end((error?: Error | null) => {
            if (error) {
              fail(error);
              no(error);
              stopOriginal();
            } else yes();
          });
        } catch (value) {
          fail(value);
          no(value);
          // Only the exact retained child is stopped when its original EOF duty fails.
          stopOriginal();
        }
      });
      void ended.catch(fail);
      const results = await Promise.allSettled([
        ended,
        original.original.completion(),
        original.original.returned(),
      ]);
      for (const result of results) if (result.status === 'rejected') fail(result.reason);
      const returned = results[2];
      if (
        returned.status !== 'fulfilled' ||
        !acceptsDarwinOwnedChildReturn(original.original, returned.value)
      )
        fail(new Error('PROCESS_OBSERVATION_UNAVAILABLE'));
      if (first) throw first.value;
    })().then(resolve, reject);
    return original.close;
  };
  const start = async (): Promise<Peer> => {
    checkOriginal();
    const original = await createDarwinOwnedChildLauncher({ artifact, manager }).launch({
      executable: artifact.path,
      argv: ['observe-requests'],
      cwd: process.cwd(),
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdin: 'pipe',
    });
    const state: Peer = { original, bytes: 0, buffer: Buffer.alloc(0), retiring: false };
    peer = state; // Retain before any callback can attempt retirement/reentry.
    const stdout = original.child.stdout;
    if (!stdout || !original.child.stdin) fail(new Error('PROCESS_OBSERVATION_UNAVAILABLE'));
    stdout?.on('data', (chunk: Buffer) => {
      try {
        state.bytes += chunk.length;
        if (state.bytes > childCap) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
        state.buffer = Buffer.concat([state.buffer, chunk]);
        const end = state.buffer.indexOf(10);
        if (end < 0) {
          if (state.buffer.length > (state.reply?.maximum ?? 0))
            throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
          return;
        }
        if (
          end + 1 > (state.reply?.maximum ?? 0) ||
          end + 1 !== state.buffer.length ||
          !state.reply
        )
          throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
        const reply = state.reply;
        state.reply = undefined;
        const bytes = state.buffer;
        state.buffer = Buffer.alloc(0);
        reply.resolve(bytes);
      } catch (value) {
        fail(value);
      }
    });
    original.child.stderr?.on('data', () => fail(new Error('PROCESS_OBSERVATION_UNAVAILABLE')));
    stdout?.once('end', () => {
      if (!state.retiring || state.buffer.length || state.reply)
        fail(new Error('PROCESS_OBSERVATION_UNAVAILABLE'));
    });
    original.child.stdin?.once('error', fail);
    void original.completion().then((result) => {
      if (!state.retiring || result.firstCause !== null)
        fail(new Error('PROCESS_OBSERVATION_UNAVAILABLE'));
    }, fail);
    await original.identity();
    checkOriginal();
    return state;
  };
  const request = <T>(
    command: 'I' | 'C',
    pids: readonly number[],
    parse: (bytes: Uint8Array) => T
  ): Promise<T> => {
    check();
    const captured = Object.freeze([...pids]);
    if (
      !captured.length ||
      captured.length > 512 ||
      new Set(captured).size !== captured.length ||
      captured.some((pid) => !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) ||
      jobs.size >= 16
    )
      throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
    const job = tail.then(async () => {
      checkOriginal();
      // Same fresh original descriptor verification before each command, even on a reused child.
      await verifyOriginalDarwinObserverArtifact(artifact);
      checkOriginal();
      const reserve = maximumReply(command, captured.length);
      if (peer && peer.bytes > childCap - reserve) {
        await closePeer(peer);
        peer = undefined;
        checkOriginal();
      }
      const original = peer ?? (await start());
      checkOriginal();
      const response = new Promise<Uint8Array>((resolve, reject) => {
        if (original.reply) {
          reject(new Error('PROCESS_OBSERVATION_UNAVAILABLE'));
          return;
        }
        original.reply = { maximum: reserve, resolve, reject };
      });
      void response.catch(() => {});
      const writing = new Promise<void>((resolve, reject) => {
        try {
          const stdin = original.original.child.stdin;
          if (!stdin) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
          stdin.write(`${command} ${captured.join(' ')}\n`, (error) =>
            error ? reject(error) : resolve()
          );
        } catch (value) {
          reject(value);
        }
      });
      void writing.catch(fail);
      const settled = await Promise.allSettled([writing, response]);
      for (const result of settled) if (result.status === 'rejected') fail(result.reason);
      if (first) throw first.value;
      const returned = settled[1];
      if (returned.status !== 'fulfilled') throw returned.reason;
      return parse(returned.value);
    });
    jobs.add(job);
    tail = job.then(
      () => undefined,
      () => undefined
    );
    void job.then(
      () => jobs.delete(job),
      (value) => {
        fail(value);
        jobs.delete(job);
      }
    );
    return job;
  };
  const owner = Object.freeze({
    observer: Object.freeze({
      inspect(pids: readonly number[]) {
        const captured = Object.freeze([...pids]);
        return request('I', captured, (bytes) => parseDarwinProcessBatch(bytes, captured));
      },
      children(parent: ProcessIdentity) {
        const captured = Object.freeze({ ...parent });
        return request('C', [captured.pid], (bytes) => parseDarwinChildrenBatch(bytes, captured));
      },
    }),
    close(): Promise<void> {
      if (closing) return closing;
      let resolve!: () => void, reject!: (value: unknown) => void;
      closing = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void closing.catch(() => {});
      closed = true;
      void (async () => {
        // Already-entered requests remain owned; never close the producer before they return.
        await Promise.allSettled([...jobs]);
        if (peer) await closePeer(peer);
        if (first) throw first.value;
      })().then(resolve, reject);
      return closing;
    },
  });
  try {
    await start();
    return owner;
  } catch (value) {
    fail(value);
    await Promise.allSettled([owner.close()]);
    throw value;
  }
}
