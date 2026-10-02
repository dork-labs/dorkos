import { isAbsolute, normalize, parse } from 'node:path';
import { z } from 'zod';
import { CounterSchema } from './counters.js';
import { parseValidated } from './validation.js';

/** Internal trusted-path schema; it makes no filesystem or symlink assertion. */
export const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes('\0') &&
      isAbsolute(value) &&
      normalize(value) === value &&
      parse(value).root !== value
  );

const RuntimeSchema = z
  .object({
    library: z
      .object({
        package: z.literal('playwright-core'),
        version: z.literal('1.63.0'),
        rootDir: AbsolutePathSchema,
        assets: z
          .object({ manifest: z.literal('browsers.json'), cli: z.literal('cli.js') })
          .strict(),
      })
      .strict(),
    executable: z
      .object({
        path: AbsolutePathSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        revision: z.string().min(1).max(16).regex(/^\d+$/),
        version: z
          .string()
          .max(64)
          .regex(/^\d+\.\d+\.\d+(?:\.\d+)?$/),
        platform: z.enum(['darwin', 'linux', 'win32']),
        arch: z.enum(['arm64', 'x64']),
      })
      .strict(),
    identity: z
      .object({ mode: z.enum(['native', 'chrome-compatible']), policyRevision: CounterSchema })
      .strict(),
  })
  .strict();

/** Trusted runtime provenance/configuration, not installation or identity readiness evidence. */
export type BrowserRuntimeDescriptor = z.infer<typeof RuntimeSchema>;

/** Validate the public pinned library layout; never resolve/install/check executable files. */
export function parseRuntimeDescriptor(value: unknown): BrowserRuntimeDescriptor {
  return parseValidated(RuntimeSchema, value, 'INVALID_RUNTIME_DESCRIPTOR');
}

/** Internal schema for composing trusted configuration without exporting package internals. */
export const RuntimeDescriptorSchema = RuntimeSchema;
