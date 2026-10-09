import { z } from 'zod';
import { Resolver } from 'node:dns';
import { Worker } from 'node:worker_threads';

const version = z.string().regex(/^\d+\.\d+\.\d+$/u);
export const BrowserRuntimeClassSchema = z
  .strictObject({
    kind: z.enum(['node', 'electron']),
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
    platform: z.enum(['darwin', 'linux', 'win32']),
    arch: z.enum(['arm64', 'x64']),
    featureContract: z.literal('browser-owner-runtime-v1'),
    surface: z.strictObject({
      abortSignalAny: z.literal(true),
      abortSignalTimeout: z.literal(true),
      workerThreads: z.literal(true),
      callbackDnsCancel: z.literal(true),
      bigint: z.literal(true),
    }),
  })
  .refine((value) => (value.kind === 'electron') === (value.electronVersion !== null))
  .refine((value) => {
    if (value.kind === 'electron') return true;
    const [major, minor, patch] = value.nodeVersion.split('.').map(Number);
    return major! > 22 || (major === 22 && (minor! > 22 || (minor === 22 && patch! >= 3)));
  });
export type BrowserRuntimeClass = Readonly<z.infer<typeof BrowserRuntimeClassSchema>>;
/** Original local process facts, not qualification evidence or an accepted version range. */
export function readOriginalBrowserRuntimeClass(): BrowserRuntimeClass {
  const original = BrowserRuntimeClassSchema.parse({
    kind: process.versions.electron ? 'electron' : 'node',
    nodeVersion: process.versions.node,
    modulesABI: process.versions.modules,
    v8Version: process.versions.v8,
    opensslVersion: process.versions.openssl,
    uvVersion: process.versions.uv,
    electronVersion: process.versions.electron ?? null,
    platform: process.platform,
    arch: process.arch,
    featureContract: 'browser-owner-runtime-v1',
    surface: Object.freeze({
      abortSignalAny: typeof AbortSignal.any === 'function',
      abortSignalTimeout: typeof AbortSignal.timeout === 'function',
      workerThreads: typeof Worker === 'function',
      callbackDnsCancel: typeof Resolver.prototype.cancel === 'function',
      bigint: typeof BigInt === 'function',
    }),
  });
  Object.freeze(original.surface);
  return Object.freeze(original);
}
