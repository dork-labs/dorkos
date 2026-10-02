import { z } from 'zod';
import { AbsolutePathSchema } from '../../runtime-descriptor.js';

/** Private mock-mechanism limits; no physical filesystem capability is supplied here. */
export const LIMITS = Object.freeze({
  deadlineMs: 5000,
  buffer: 65536,
  retained: 131072,
  pointer: 1024,
  manifest: 16384,
  file: 8388608,
  library: 33554432,
  executable: 2147483648,
  entries: 256,
  depth: 16,
  path: 1024,
  frontier: 1048576,
});
export const DISTRIBUTION = '6bf8e6d392f411f43046a5688021a5ed083fea9129f2f84dbff5aee88b2de728';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const unsigned = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,19})$/)
  .refine((v) => BigInt(v) <= 18446744073709551615n);
const signed = z
  .string()
  .max(32)
  .regex(/^(?:0|-?[1-9]\d*)$/);
export const IdentitySchema = z
  .object({
    device: unsigned,
    inode: unsigned,
    size: unsigned,
    mtimeNs: signed,
    ctimeNs: signed,
    type: z.enum(['file', 'directory']),
  })
  .strict();
export type Identity = z.infer<typeof IdentitySchema>;
export const relativePath = z
  .string()
  .refine(
    (v) =>
      new TextEncoder().encode(v).length <= LIMITS.path &&
      new TextDecoder().decode(new TextEncoder().encode(v)) === v &&
      !v.includes('\\') &&
      !v.includes('\0') &&
      !v.includes(':') &&
      v.split('/').every((s) => s && s !== '.' && s !== '..')
  );
export const trustedPath = AbsolutePathSchema.refine(
  (v) =>
    new TextEncoder().encode(v).length <= 16384 &&
    new TextDecoder().decode(new TextEncoder().encode(v)) === v
);
export const PointerSchema = z
  .object({ schemaVersion: z.literal(1), installationId: opaque, manifestDigest: hash })
  .strict();
export const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    installationId: opaque,
    packageName: z.literal('playwright-core'),
    packageVersion: z.literal('1.63.0'),
    libraryDistributionSHA256: hash,
    chromiumRevision: z.string().max(16).regex(/^\d+$/),
    observedVersion: z
      .string()
      .max(64)
      .regex(/^\d+\.\d+\.\d+(?:\.\d+)?$/),
    platform: z.enum(['darwin', 'linux', 'win32']),
    arch: z.enum(['arm64', 'x64']),
    executablePath: relativePath,
    executableSHA256: hash,
    verifierEvidence: z
      .object({
        attemptId: opaque,
        generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        evidenceDigest: hash,
      })
      .strict(),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;
export interface PinnedTarget {
  readonly chromiumRevision: string;
  readonly observedVersion: string;
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly arch: 'arm64' | 'x64';
}
type Common = Readonly<{
  schemaVersion: 1;
  pinnedPackageVersion: '1.63.0';
  chromiumRevision: string;
  platform: PinnedTarget['platform'];
  arch: PinnedTarget['arch'];
  observation: 'files-only';
  readiness: Readonly<{ state: 'unavailable'; cause: 'VERIFICATION_UNAVAILABLE' }>;
}>;
export type RuntimeStatus = Common &
  (
    | Readonly<{ state: 'installed'; cause: null; executableSHA256: string }>
    | Readonly<{ state: 'missing'; cause: null }>
    | Readonly<{ state: 'invalid'; cause: 'INSTALLATION_INVALID' }>
    | Readonly<{ state: 'unverified'; cause: 'VERIFICATION_UNAVAILABLE' }>
    | Readonly<{ state: 'unsupported'; cause: 'PLATFORM_UNSUPPORTED' }>
  );
/** Closed internal classification; arbitrary port errors never become status text. */
export class InspectionFailure extends Error {
  constructor(readonly state: 'invalid' | 'unverified') {
    super('FILES_INSPECTION_REFUSED');
  }
}
/** Validate the complete observed tuple; this supplies no physical observation capability. */
export function requireIdentity(value: unknown): Identity {
  const parsed = IdentitySchema.safeParse(value);
  if (!parsed.success) throw new InspectionFailure('unverified');
  return Object.freeze(parsed.data);
}
/** Compare every bounded identity field, including size and change metadata. */
export function equalIdentity(a: Identity, b: Identity): boolean {
  return Object.keys(a).every((k) => a[k as keyof Identity] === b[k as keyof Identity]);
}
