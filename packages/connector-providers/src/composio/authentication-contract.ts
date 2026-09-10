/** Provider metadata and transient field validation, confined to hosted owner authentication. */
import { z } from 'zod';

/** Field schemes proven against the pinned raw connected-account create union. */
export const ComposioFieldSchemeSchema = z.enum(['API_KEY', 'BEARER_TOKEN', 'BASIC', 'NO_AUTH']);
/** Supported transient account-field scheme. OAuth cannot enter this union. */
export type ComposioFieldScheme = z.infer<typeof ComposioFieldSchemeSchema>;

/** One declared input; defaults are intentionally absent, including secret defaults. */
export const ComposioAuthenticationFieldSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .refine((name) => !['__proto__', 'constructor', 'prototype', 'status'].includes(name)),
    label: z.string().min(1).max(512),
    description: z.string().max(2048),
    type: z.enum(['string', 'password', 'boolean', 'number']),
    required: z.boolean(),
    secret: z.boolean(),
  })
  .strict();
/** Internal hosted input descriptor; never a local-instance transport resource. */
export type ComposioAuthenticationField = z.infer<typeof ComposioAuthenticationFieldSchema>;

/** Exact normalized auth choice; OAuth1/DCR remain unsupported until separate wire/verifier proof. */
export const ComposioAuthenticationDescriptorSchema = z
  .object({
    toolkit: z.string().min(1).max(200),
    scheme: z.enum(['OAUTH2', 'API_KEY', 'BEARER_TOKEN', 'BASIC', 'NO_AUTH']),
    kind: z.enum(['oauth', 'fields', 'none']),
    source: z.enum(['configured', 'managed', 'account-fields']),
    fields: z.array(ComposioAuthenticationFieldSchema).max(64),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.fields.map((field) => field.name)).size !== value.fields.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate authentication field.' });
    const expected =
      value.scheme === 'OAUTH2' ? 'oauth' : value.scheme === 'NO_AUTH' ? 'none' : 'fields';
    if (value.kind !== expected || (value.kind === 'none' && value.fields.length > 0))
      ctx.addIssue({ code: 'custom', message: 'Authentication method does not match its fields.' });
  });
/** Validated metadata for one server-selected auth flow. */
export type ComposioAuthenticationDescriptor = z.infer<
  typeof ComposioAuthenticationDescriptorSchema
>;

/** Parse only declared field values, using closed errors that never include credential input. */
export function validateComposioAuthenticationFields(
  descriptor: ComposioAuthenticationDescriptor,
  raw: unknown
): Record<string, string | number | boolean> {
  const fail = (): never => {
    throw new Error('Account details do not match the required fields.');
  };
  if (
    !ComposioAuthenticationDescriptorSchema.safeParse(descriptor).success ||
    descriptor.kind === 'oauth'
  )
    fail();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
  let encoded: string;
  try {
    encoded = JSON.stringify(raw);
  } catch {
    return fail();
  }
  if (Buffer.byteLength(encoded, 'utf8') > 65536) fail();
  const record = raw as Record<string, unknown>;
  const allowed = new Set(descriptor.fields.map((field) => field.name));
  if (Object.keys(record).some((name) => !allowed.has(name))) fail();
  const result: Record<string, string | number | boolean> = Object.create(null);
  for (const field of descriptor.fields) {
    if (!Object.hasOwn(record, field.name)) {
      if (field.required) fail();
      continue;
    }
    const value = record[field.name];
    const type = field.type === 'password' ? 'string' : field.type;
    if (
      typeof value !== type ||
      (typeof value === 'string' &&
        (value.length > 8192 || (field.required && value.length === 0))) ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      fail();
    result[field.name] = value as string | number | boolean;
  }
  return result;
}
