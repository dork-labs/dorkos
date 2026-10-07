import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z.string().min(1).max(4096).refine(isAbsolute);
const version = z.string().regex(/^\d+\.\d+\.\d+$/u);
export const DesktopQualificationRuntimeClassSchema = z
  .strictObject({
    kind: z.literal('electron'),
    nodeVersion: version,
    v8Version: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9.+_-]+$/u),
    opensslVersion: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9.+_-]+$/u),
    uvVersion: version,
    modulesABI: z
      .string()
      .regex(/^[1-9]\d*$/u)
      .max(8),
    electronVersion: version.nullable(),
    platform: z.literal('darwin'),
    arch: z.literal('arm64'),
    featureContract: z.literal('browser-owner-runtime-v1'),
    surface: z.strictObject({
      abortSignalAny: z.literal(true),
      abortSignalTimeout: z.literal(true),
      workerThreads: z.literal(true),
      callbackDnsCancel: z.literal(true),
      bigint: z.literal(true),
    }),
  })
  .refine((value) => (value.kind === 'electron') === (value.electronVersion !== null));

/** Data-only private parent scope. The server's mode schema is the final authority. */
export const DesktopQualificationSubjectSchema = z.strictObject({
  runtimeClass: DesktopQualificationRuntimeClassSchema,
  executableSHA256: digest,
  version: z.string().min(1).max(128),
  revision: z.literal('1243'),
  libraryVersion: z.literal('1.63.0'),
  platform: z.literal('darwin'),
  arch: z.literal('arm64'),
  channel: z.literal('desktop'),
  sourceManifestSHA256: digest,
  controllerSHA256: digest,
  verifierSHA256: digest,
  nativeJournalSHA256: digest,
  productionSubjectSHA256: digest,
  mode: z.enum(['native', 'chrome-compatible']),
  identityPolicyRevision: z.literal(1),
  networkPolicyRevision: z.literal(1),
});
export const DesktopQualificationGrantSchema = z.strictObject({
  home: path,
  appPath: path,
  signedArtifactSHA256: digest,
  desktopExecutableSHA256: digest,
  serverEntrySHA256: digest,
  subject: DesktopQualificationSubjectSchema,
});
export type DesktopQualificationGrant = Readonly<z.infer<typeof DesktopQualificationGrantSchema>>;
export const DesktopQualificationHelloSchema = z.strictObject({
  type: z.literal('browser-desktop-qualification-hello'),
  nonce: z.string().regex(/^[a-f0-9]{48}$/u),
  home: path,
  appPath: path,
  desktopExecutableSHA256: digest,
  serverEntrySHA256: digest,
});
export const DesktopQualificationReplySchema = z.strictObject({
  type: z.literal('browser-desktop-qualification-grant'),
  nonce: z.string().regex(/^[a-f0-9]{48}$/u),
  grant: DesktopQualificationGrantSchema,
});
/** Join an exact nonlinked original file, preserving its first failure and descriptor close. */
export async function readOriginalDesktopDigest(
  path: string,
  current: () => void
): Promise<string> {
  current();
  if ((await realpath(path)) !== path) throw new Error('DESKTOP_QUALIFICATION_FILE_REFUSED');
  const original = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  let first: { value: unknown } | undefined;
  let digest: string | undefined;
  try {
    current();
    const before = await original.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 32n * 1024n * 1024n)
      throw new Error('DESKTOP_QUALIFICATION_FILE_REFUSED');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      current();
      const read = await original.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await original.stat({ bigint: true });
    current();
    if (
      BigInt(count) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('DESKTOP_QUALIFICATION_FILE_REFUSED');
    digest = createHash('sha256').update(bytes.subarray(0, count)).digest('hex');
  } catch (value) {
    first = { value };
  }
  try {
    await original.close();
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
  current();
  if (!digest) throw new Error('DESKTOP_QUALIFICATION_FILE_REFUSED');
  return digest;
}

import type { Readable, Writable } from 'node:stream';
/** One original bounded frame; arbitrary extra bytes or original EOF refuse. */
export function readOriginalDesktopFrame(
  input: Readable,
  signal: AbortSignal,
  prefix = ''
): Promise<unknown> {
  const on = input.on.bind(input),
    off = input.off.bind(input);
  return new Promise((yes, no) => {
    let settled = false,
      bytes = Buffer.alloc(0),
      total = 0;
    const finish = (failure: { value: unknown } | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      off('data', data);
      off('error', error);
      off('end', ended);
      off('close', ended);
      signal.removeEventListener('abort', aborted);
      if (failure) no(failure.value);
      else yes(value);
    };
    const error = (value: unknown) => finish({ value });
    const ended = () => error(new Error('DESKTOP_QUALIFICATION_EOF'));
    const aborted = () => error(signal.reason);
    const data = (value: Buffer | string) => {
      try {
        const next = Buffer.isBuffer(value) ? value : Buffer.from(value);
        total += next.length;
        if (total > (prefix ? 262144 : 16384)) throw new Error('DESKTOP_QUALIFICATION_FRAME_LIMIT');
        bytes = Buffer.concat([bytes, next]);
        for (;;) {
          const line = bytes.indexOf(10);
          if (line < 0) {
            if (bytes.length > 16384) throw new Error('DESKTOP_QUALIFICATION_FRAME_LIMIT');
            return;
          }
          if (line > 16384) throw new Error('DESKTOP_QUALIFICATION_FRAME_LIMIT');
          const text = bytes.subarray(0, line).toString('utf8');
          const remaining = bytes.subarray(line + 1);
          if (prefix && !text.startsWith(prefix)) {
            bytes = remaining;
            continue;
          }
          if (!prefix && remaining.length) throw new Error('DESKTOP_QUALIFICATION_EXTRA_FRAME');
          finish(undefined, JSON.parse(text.slice(prefix.length)));
          return;
        }
      } catch (value) {
        error(value);
      }
    };
    on('data', data);
    on('error', error);
    on('end', ended);
    on('close', ended);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
/** Acknowledge the same original write callback; no unjoined backpressure send. */
export function writeOriginalDesktopFrame(
  output: Writable,
  value: unknown,
  prefix = ''
): Promise<void> {
  const write = output.write.bind(output);
  const bytes = prefix + JSON.stringify(value) + '\n';
  if (Buffer.byteLength(bytes) > 16384) throw new Error('DESKTOP_QUALIFICATION_FRAME_LIMIT');
  return new Promise((yes, no) => {
    let returned = false;
    let callback: { failure?: { value: unknown } } | undefined;
    const settle = () => {
      if (!returned || !callback) return;
      if (callback.failure) no(callback.failure.value);
      else yes();
    };
    try {
      write(bytes, (error: unknown) => {
        callback ??= error !== undefined && error !== null ? { failure: { value: error } } : {};
        settle();
      });
      returned = true;
      settle();
    } catch (value) {
      no(callback?.failure ? callback.failure.value : value);
    }
  });
}
