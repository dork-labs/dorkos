import { z } from 'zod';

/** Browser-safe projections; authorization is enforced separately on every host action. */
export const ComputerPhaseSchema = z.enum([
  'disabled',
  'unsupported',
  'missing',
  'provisioning',
  'stopped',
  'starting',
  'ready',
  'stopping',
  'failed',
  'uncertain',
]);
export const ComputerErrorCodeSchema = z.enum([
  'unsupported',
  'disabled',
  'setup-failed',
  'not-ready',
  'sign-in-required',
  'control-lost',
  'cleanup-uncertain',
  'unavailable',
]);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ComputerStatusSchema = z
  .object({
    id: z.literal('local'),
    name: z.string().min(1).max(80),
    supported: z.boolean(),
    phase: ComputerPhaseSchema,
    generation,
    ready: z.boolean(),
    error: z.object({ code: ComputerErrorCodeSchema }).strict().optional(),
    runtimeId: z.string().min(1).max(128).optional(),
    cwd: z.string().min(1).max(4096).optional(),
  })
  .strict();
export const ComputerControlLeaseSchema = z
  .object({
    leaseId: z.string().min(1).max(128),
    generation,
  })
  .strict();
const lease = { leaseId: z.string().min(1).max(128), generation };
export const ComputerInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...lease,
      kind: z.literal('pointer'),
      x: z.number().int().min(0).max(8191),
      y: z.number().int().min(0).max(8191),
      button: z.number().int().min(0).max(2).optional(),
      action: z.enum(['move', 'down', 'up']),
    })
    .strict(),
  z
    .object({
      ...lease,
      kind: z.literal('key'),
      key: z.string().min(1).max(64),
      action: z.enum(['down', 'up']),
    })
    .strict(),
  z
    .object({
      ...lease,
      kind: z.literal('text'),
      text: z
        .string()
        .min(1)
        .max(4096)
        .refine((text) => !text.includes('\0')),
    })
    .strict(),
]);
export const ComputerFrameSchema = z
  .object({
    dataUrl: z
      .string()
      .max(16 * 1024 * 1024)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    generation,
    controlledByYou: z.boolean().optional(),
  })
  .strict();
export const ComputerSessionSchema = z
  .object({
    id: z.string().min(1).max(128),
    cwd: z.string().min(1).max(4096),
    runtime: z.string().min(1).max(128),
  })
  .strict();
export type ComputerPhase = z.infer<typeof ComputerPhaseSchema>;
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;
export type ComputerErrorCode = z.infer<typeof ComputerErrorCodeSchema>;
export type ComputerControlLease = z.infer<typeof ComputerControlLeaseSchema>;
export type ComputerInput = z.infer<typeof ComputerInputSchema>;
export type ComputerFrame = z.infer<typeof ComputerFrameSchema>;
export type ComputerSession = z.infer<typeof ComputerSessionSchema>;
