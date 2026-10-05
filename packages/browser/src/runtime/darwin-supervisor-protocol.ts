import { z } from 'zod';
import { RuntimeDescriptorSchema, AbsolutePathSchema } from '../runtime-descriptor.js';
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z
  .object({ pid: z.number().int().positive().max(2147483647), birth: z.string().min(1).max(128) })
  .strict();
const nonce = z.string().uuid();
const sequence = counter.refine((value) => value > 0);
export const SupervisorSeedSchema = z
  .object({
    kind: z.literal('launch'),
    nonce,
    reservationNonce: nonce,
    manager: identity,
    browserId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    generation: counter,
    runtime: RuntimeDescriptorSchema,
    profileDir: AbsolutePathSchema,
    artifact: z
      .object({ path: AbsolutePathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
    ownedProxy: z
      .object({
        url: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/),
        credentials: z
          .object({ username: z.literal('dorkos'), password: z.string().min(1).max(4096) })
          .strict(),
      })
      .strict()
      .optional(),
    origin: z
      .string()
      .url()
      .max(256)
      .refine((value) => {
        const url = new URL(value);
        return (
          value === 'about:blank' ||
          (url.protocol === 'http:' &&
            ['127.0.0.1', '[::1]'].includes(url.hostname) &&
            url.origin === value &&
            !!url.port)
        );
      }),
  })
  .strict();
export const SupervisorActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list') }).strict(),
  z
    .object({
      kind: z.literal('navigate'),
      tab: sequence,
      url: z
        .string()
        .url()
        .max(4096)
        .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
    })
    .strict(),
  z.object({ kind: z.literal('close') }).strict(),
]);
export const SupervisorCommandSchema = z
  .object({ kind: z.literal('command'), nonce, sequence, action: SupervisorActionSchema })
  .strict();
const tab = z.object({ tab: sequence, url: z.string().max(4096) }).strict();
export const SupervisorReplySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ready'),
      nonce,
      reservationNonce: nonce,
      browserId: SupervisorSeedSchema.shape.browserId,
      generation: counter,
      endpointURL: z
        .string()
        .max(256)
        .regex(/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/devtools\/browser\/[a-fA-F0-9-]{36}$/),
      root: identity,
      supervisor: identity,
      proxyURL: z
        .string()
        .max(256)
        .regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reply'),
      nonce,
      sequence,
      value: z.union([z.array(tab).max(128), z.object({ tab: sequence }).strict()]),
    })
    .strict(),
  z.object({ kind: z.literal('closed'), nonce, sequence, returned: z.boolean() }).strict(),
  z.object({ kind: z.literal('refused'), nonce, sequence }).strict(),
  z.object({ kind: z.literal('custodyFault'), nonce }).strict(),
  z.object({ kind: z.literal('rootFailure'), nonce, root: identity }).strict(),
]);
