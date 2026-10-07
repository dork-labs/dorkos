import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, lstat, type FileHandle } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { ProcessIdentity } from '../configuration.js';

const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(
    (value) => /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n
  );
const identity = z
  .object({
    pid: z.number().int().positive().max(2147483647),
    seconds: decimal,
    microseconds: decimal,
  })
  .strict();
const replySchema = z
  .object({
    version: z.literal(1),
    bootSeconds: decimal,
    bootMicroseconds: decimal,
    processes: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('present'),
              identity,
              parentPid: z.number().int().nonnegative().max(2147483647),
              zombie: z.boolean(),
            })
            .strict(),
          z
            .object({ kind: z.literal('absent'), pid: z.number().int().positive().max(2147483647) })
            .strict(),
          z
            .object({
              kind: z.literal('unknown'),
              pid: z.number().int().positive().max(2147483647),
              error: z.number().int(),
              uncertainty: z
                .enum([
                  'birth-changed',
                  'parent-changed',
                  'alive-to-zombie',
                  'zombie-to-alive',
                  'membership-disappeared',
                  'membership-appeared',
                  'membership-absent-with-present-reads',
                ])
                .optional(),
            })
            .strict(),
        ])
      )
      .max(512),
  })
  .strict();
export type DarwinProcessBatch = z.infer<typeof replySchema>;
/** Private, read-only native receiver; no process signal or profile-release method. */
export interface DarwinProcessObserver {
  inspect(pids: readonly number[]): Promise<DarwinProcessBatch>;
  children?(parent: ProcessIdentity): Promise<DarwinChildrenBatch>;
}
const childrenSchema = replySchema
  .extend({
    parentBefore: identity.nullable(),
    parentAfter: identity.nullable(),
    complete: z.boolean(),
  })
  .strict();
export type DarwinChildrenBatch = z.infer<typeof childrenSchema>;
/** Validate parent lifetime around bounded native enumeration; incomplete is retained as unknown. */
export function parseDarwinChildrenBatch(
  bytes: Uint8Array,
  parent: ProcessIdentity
): DarwinChildrenBatch {
  if (bytes.byteLength > 256 * 1024) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
  const batch = childrenSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  );
  if (BigInt(batch.bootMicroseconds) >= 1000000n)
    throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
  const pids = new Set<number>();
  for (const fact of batch.processes) {
    const pid = fact.kind === 'present' ? fact.identity.pid : fact.pid;
    if (pids.has(pid)) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
    pids.add(pid);
    if (fact.kind === 'present') darwinBirth(fact.identity);
  }
  if (
    batch.complete &&
    (!batch.parentBefore ||
      !batch.parentAfter ||
      darwinBirth(batch.parentBefore).birth !== parent.birth ||
      batch.parentBefore.pid !== parent.pid ||
      darwinBirth(batch.parentAfter).birth !== parent.birth ||
      batch.parentAfter.pid !== parent.pid ||
      batch.processes.some(
        (fact) =>
          fact.kind !== 'present' ||
          fact.parentPid !== parent.pid ||
          fact.identity.pid === parent.pid
      ))
  )
    throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
  return batch;
}
/** Convert exact integer microseconds without rounding through a JavaScript number. */
export function darwinBirth(value: z.infer<typeof identity>): ProcessIdentity {
  if (BigInt(value.microseconds) >= 1_000_000n) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
  return Object.freeze({
    pid: value.pid,
    birth: `darwin-bsd-start:${value.seconds}:${value.microseconds}`,
  });
}
/** Strict native reply parsing preserves unknown and zombie statuses. */
export function parseDarwinProcessBatch(
  bytes: Uint8Array,
  requested: readonly number[]
): DarwinProcessBatch {
  if (bytes.byteLength > 256 * 1024) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
  const batch = replySchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  );
  if (BigInt(batch.bootMicroseconds) >= 1_000_000n || batch.processes.length !== requested.length)
    throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
  const remaining = new Set(requested);
  for (const fact of batch.processes) {
    const pid = fact.kind === 'present' ? fact.identity.pid : fact.pid;
    if (!remaining.delete(pid)) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
    if (fact.kind === 'present') darwinBirth(fact.identity);
  }
  if (remaining.size) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
  return batch;
}
// Original read custody survives temporary observer instances and rejected calls.
// An ambiguous close blocks later admission; a new observer cannot erase that duty.
const heldReads = new Set<FileHandle>();
const heldChildren = new Set<ChildProcess>();
let readCustodyUncertain = false;
/** Create only from the trusted package's exact helper artifact, never an HTTP request path. */
export function createDarwinProcessObserver(
  artifact: Readonly<{ path: string; sha256: string }>
): DarwinProcessObserver {
  const descriptor = Object.freeze({ ...artifact });
  const invoke = async (command: string, pids: readonly number[]): Promise<Uint8Array> => {
    if (
      readCustodyUncertain ||
      process.platform !== 'darwin' ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
      pids.length < 1 ||
      pids.length > 512 ||
      new Set(pids).size !== pids.length ||
      pids.some((pid) => !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647)
    )
      throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
    if ((await realpath(descriptor.path)) !== descriptor.path)
      throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
    const file = await open(
      descriptor.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    heldReads.add(file);
    let primary: unknown,
      failed = false;
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > 4n * 1024n * 1024n || (before.mode & 0o111n) === 0n)
        throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
      const hash = createHash('sha256');
      const buffer = new Uint8Array(65536);
      let bytes = 0;
      for (;;) {
        const read = await file.read(
          buffer,
          0,
          Math.min(buffer.length, 4 * 1024 * 1024 + 1 - bytes),
          null
        );
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
        if (bytes > 4 * 1024 * 1024) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
        hash.update(buffer.subarray(0, read.bytesRead));
      }
      const after = await file.stat({ bigint: true });
      const named = await lstat(descriptor.path, { bigint: true });
      if (!named.isFile() || named.dev !== after.dev || named.ino !== after.ino)
        throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
      if (
        hash.digest('hex') !== descriptor.sha256 ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
    } catch (error) {
      primary = error;
      failed = true;
    }
    try {
      await file.close();
      heldReads.delete(file);
    } catch (error) {
      readCustodyUncertain = true;
      if (!failed) primary = error;
      failed = true;
    }
    if (failed) throw primary;
    if (readCustodyUncertain) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
    // Retain each real child/pipe until natural terminal; overflow refuses without replacing the child.
    const child = spawn(descriptor.path, [command, ...pids.map(String)], {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    heldChildren.add(child);
    let failedChild = false;
    const terminal = new Promise<number | null>((done) => {
      child.on('error', () => {
        failedChild = true;
      });
      child.once('close', (code) => done(code));
    });
    const pipeReturns = [
      { eof: false, closed: false },
      { eof: false, closed: false },
    ];
    const drain = async (
      stream: ChildProcess['stdout'],
      duty: (typeof pipeReturns)[number]
    ): Promise<Uint8Array> => {
      if (!stream) {
        failedChild = true;
        return new Uint8Array();
      }
      stream.once('end', () => {
        duty.eof = true;
      });
      stream.once('close', () => {
        duty.closed = true;
      });
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const value of stream) {
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes <= 256 * 1024) chunks.push(chunk);
        else failedChild = true;
      }
      if (!stream.readableEnded || !duty.eof) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
      return Buffer.concat(chunks);
    };
    const streams = await Promise.allSettled([
      drain(child.stdout, pipeReturns[0]),
      drain(child.stderr, pipeReturns[1]),
    ]);
    const code = await terminal;
    const pipesReturned =
      streams.every((stream) => stream.status === 'fulfilled') &&
      pipeReturns.every((duty) => duty.eof && duty.closed);
    if (pipesReturned) heldChildren.delete(child);
    else readCustodyUncertain = true;
    if (readCustodyUncertain || failedChild || code !== 0 || !pipesReturned)
      throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
    const stdout = streams[0];
    if (stdout.status !== 'fulfilled') throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
    return stdout.value;
  };
  return Object.freeze({
    async inspect(pids: readonly number[]) {
      return parseDarwinProcessBatch(await invoke('inspect', pids), pids);
    },
    async children(parent: ProcessIdentity) {
      return parseDarwinChildrenBatch(await invoke('children', [parent.pid]), parent);
    },
  });
}
