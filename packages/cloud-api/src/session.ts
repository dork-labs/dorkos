import { z } from 'zod';

import { IdSchema, SecretValueSchema, TimestampSchema } from './primitives.js';

/**
 * The scopes a bearer token can carry.
 *
 * Mechanism, not catalog: a scope names an ability the protocol defines, and no
 * subscription is inferable from the set.
 */
export const ScopeSchema = z
  .enum([
    'account:read',
    'account:write',
    'instances:read',
    'instances:write',
    'connections:read',
    'connections:write',
    'billing:read',
    'billing:write',
    'seats:read',
    'seats:write',
    'inference:mint',
    'remote:read',
    'remote:write',
  ])
  .describe('An ability a bearer token carries. Scopes describe the protocol, not a subscription.');

/** An ability a bearer token carries. */
export type Scope = z.infer<typeof ScopeSchema>;

/** The account a token or cookie resolves to. */
export const AccountSchema = z
  .object({
    id: IdSchema,
    email: z.string().describe("The account's primary email address."),
    displayName: z.string().describe('The name to show for this account.'),
    avatarUrl: z.string().url().optional().describe("A URL for the account's avatar image."),
    createdAt: TimestampSchema,
  })
  .describe('The person behind a token or cookie.');

/** The person behind a token or cookie. */
export type Account = z.infer<typeof AccountSchema>;

/** `GET /v1/session` — introspection of the presented token or cookie. */
export const SessionSchema = z
  .object({
    authenticated: z
      .boolean()
      .describe(
        'False when the credential is absent or unusable; every other field is then omitted.'
      ),
    account: AccountSchema.optional(),
    instanceId: IdSchema.optional().describe(
      'The instance this credential was issued to, when it was issued to one rather than to a person.'
    ),
    orgId: IdSchema.optional().describe('The organization this credential is scoped to.'),
    seatId: IdSchema.optional().describe('The seat this credential is scoped to.'),
    scopes: z.array(ScopeSchema).describe('Every scope this credential carries.'),
    expiresAt: TimestampSchema.optional(),
  })
  .describe(
    'What the presented credential resolves to. Unauthenticated is a normal answer, not an error.'
  );

/** What the presented credential resolves to. */
export type Session = z.infer<typeof SessionSchema>;

/** `POST /v1/account/export` — a request for a copy of everything the account holds. */
export const AccountExportRequestSchema = z
  .object({
    notifyEmail: z
      .boolean()
      .optional()
      .describe('Email the account when the export is ready. Defaults to the server policy.'),
  })
  .describe('A request for a copy of everything the caller`s account holds.');

/** The accepted export job. */
export const AccountExportResponseSchema = z
  .object({
    exportId: IdSchema,
    requestedAt: TimestampSchema,
    readyAt: TimestampSchema.nullable().describe('Null while the export is still being assembled.'),
    downloadUrl: z
      .string()
      .url()
      .nullable()
      .describe('A short-lived download link, null until the export is ready.'),
  })
  .describe('The state of an account export the caller asked for.');

/** The state of an account export. */
export type AccountExport = z.infer<typeof AccountExportResponseSchema>;

/**
 * `POST /v1/device/code` — the device-authorization request of RFC 8628.
 *
 * One of the two unauthenticated routes in this contract; the other is the
 * token poll below.
 */
export const DeviceCodeRequestSchema = z
  .object({
    clientId: z.string().min(1).describe('The public client identifier of the program asking.'),
    scope: z
      .string()
      .optional()
      .describe('A space-delimited scope request, as RFC 8628 spells it.'),
  })
  .describe('The device-authorization request of RFC 8628. Unauthenticated by design.');

/**
 * The device-authorization response of RFC 8628.
 *
 * Field names are snake_case here and only here: RFC 8628 fixes them on the
 * wire, and renaming them would make this contract describe something other
 * than the standard it implements.
 */
export const DeviceCodeResponseSchema = z
  .object({
    device_code: SecretValueSchema.describe(
      'The device verification code. A credential: it is what the poll below exchanges for a token.'
    ),
    user_code: z.string().describe('The short code the person types into the verification page.'),
    verification_uri: z.string().url().describe('The page the person opens to approve the device.'),
    verification_uri_complete: z
      .string()
      .url()
      .optional()
      .describe('The verification page with the user code already filled in.'),
    expires_in: z.number().int().positive().describe('Seconds until the device code expires.'),
    interval: z
      .number()
      .int()
      .positive()
      .describe('Seconds to wait between polls of the token endpoint.'),
  })
  .describe('The device-authorization response of RFC 8628, with the RFC`s own field names.');

/** `POST /v1/device/token` — the token poll of RFC 8628. */
export const DeviceTokenRequestSchema = z
  .object({
    clientId: z.string().min(1),
    device_code: SecretValueSchema,
    grant_type: z
      .literal('urn:ietf:params:oauth:grant-type:device_code')
      .describe('Fixed by RFC 8628.'),
  })
  .describe('The token poll of RFC 8628. Unauthenticated by design.');

/** The granted token pair. */
export const DeviceTokenResponseSchema = z
  .object({
    access_token: SecretValueSchema,
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive().describe('Seconds until the access token expires.'),
    refresh_token: SecretValueSchema.optional(),
    scope: z.string().optional().describe('The space-delimited scopes actually granted.'),
  })
  .describe('The token pair RFC 8628 grants once the person has approved the device.');

/**
 * The pending-state errors RFC 8628 defines for the token poll.
 *
 * Mechanism, and fixed by the RFC rather than by us.
 */
export const DeviceTokenErrorSchema = z
  .object({
    error: z.enum(['authorization_pending', 'slow_down', 'expired_token', 'access_denied']),
    error_description: z.string().optional(),
  })
  .describe(
    'The RFC 8628 token-poll error set. `authorization_pending` and `slow_down` mean keep polling.'
  );

/** The RFC 8628 token-poll error set. */
export type DeviceTokenError = z.infer<typeof DeviceTokenErrorSchema>;
