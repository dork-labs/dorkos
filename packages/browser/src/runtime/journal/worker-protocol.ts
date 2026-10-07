import { z } from 'zod';
import { JournalSnapshotSchema } from '../../lifecycle/process-journal.js';
import { journalIdentityRefusalCodes } from '../supervisor-uncertainty-diagnostic.js';

export const identity = z
  .object({
    pid: z.number().int().positive(),
    birth: z.string().min(1).max(128),
  })
  .strict();
export const seedSchema = z
  .object({
    kind: z.literal('seed'),
    ownedLaunch: z.boolean().default(false),
    logicalManager: identity.optional(),
    initial: JournalSnapshotSchema,
    location: z
      .object({
        parentDirectory: z.string().max(4096),
        parentIdentity: z
          .object({
            device: z.string(),
            inode: z.string(),
            mode: z.number(),
            uid: z.number(),
            type: z.literal('directory'),
          })
          .strict(),
        binding: JournalSnapshotSchema.shape.binding,
      })
      .strict(),
    artifact: z
      .object({
        path: z.string().max(4096),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    duration: z.number().positive().max(600000),
    continuous: z.boolean().default(false),
    maxGap: z.number().positive().max(10000),
  })
  .strict();
export const rootSchema = z
  .object({
    kind: z.literal('root'),
    identity,
    supervisor: identity.optional(),
  })
  .strict();
export const launchSchema = z
  .object({
    kind: z.literal('launch'),
    executable: z.string().min(1).max(4096),
    cwd: z.string().min(1).max(4096),
    argv: z.array(z.string().max(4096)).max(64),
  })
  .strict();
export const refuseSchema = z.object({ kind: z.literal('refuse-seed') }).strict();
export const returnedSchema = z
  .object({
    kind: z.literal('root-returned'),
    nonce: z.string().min(1).max(128),
    identity,
  })
  .strict();
export const prepareCloseSchema = z
  .object({
    kind: z.literal('prepare-close'),
    nonce: z.string().min(1).max(128),
    identity,
  })
  .strict();
export const endSchema = z
  .object({ kind: z.literal('end-browser'), launchEntered: z.boolean() })
  .strict();
export const messages = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('enrolled') }).strict(),
  z
    .object({
      kind: z.literal('observation-fault'),
      reason: z.enum(journalIdentityRefusalCodes).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('enumeration-closed'),
      nonce: z.string().min(1).max(128),
      sequence: z.number().int().positive().safe(),
      monotonic: z.number().int().nonnegative().safe(),
      root: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal('checkpoint'),
      sequence: z.number().int().positive().safe(),
      monotonic: z.number().int().nonnegative().safe(),
      root: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal('complete'),
      result: z.enum([
        'recorded-gone',
        'original-child-returned-observer-live',
        'campaign-closed-gapped',
        'campaign-closed',
        'retained',
        'uncertain',
      ]),
    })
    .strict(),
]);
/** Boot-relative monotonic clock shared by separate Node processes on this host. */
export function darwinMonotonicNow(): number {
  return Number(process.hrtime.bigint() / 1000000n);
}
