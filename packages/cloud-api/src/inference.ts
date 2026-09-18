import { z } from 'zod';

import { IdSchema, SecretValueSchema, TimestampSchema } from './primitives.js';

/**
 * `POST /v1/inference/tokens` — mint a short-lived inference token.
 *
 * The caller is taken from the bearer credential; `seatRef` and `agentRef` only
 * narrow it.
 */
export const InferenceTokenRequestSchema = z
  .object({
    instanceId: IdSchema,
    seatRef: IdSchema.optional(),
    agentRef: IdSchema.optional(),
  })
  .describe('Mint a short-lived inference token for one instance.');

/**
 * The endpoints a minted token may be used against.
 *
 * Runtime values. No host, origin or URL literal belongs in this package, and
 * which provider serves a request is not part of this contract.
 */
export const InferenceEndpointsSchema = z
  .object({
    anthropicMessages: z.string().url(),
    openaiChat: z.string().url(),
  })
  .describe(
    'Where to send inference requests. Runtime values; no origin is baked into this package.'
  );

/** What a minted token is allowed to do at once. */
export const InferenceLimitsSchema = z
  .object({
    concurrentStreams: z.number().int().positive(),
    requestsPerMinute: z.number().int().positive(),
  })
  .describe('The concurrency and rate ceilings a minted token carries.');

/**
 * A minted inference token.
 *
 * `token` is a credential returned once. Consumers hold it as a credential
 * reference, never as a configuration string, and never log it.
 *
 * No price, rate, multiplier or unit cost appears on this route. The published
 * price list is the one place a price belongs.
 */
export const InferenceTokenSchema = z
  .object({
    tokenId: IdSchema,
    token: SecretValueSchema,
    expiresAt: TimestampSchema,
    endpoints: InferenceEndpointsSchema,
    limits: InferenceLimitsSchema,
    catalogVersion: z
      .string()
      .describe('An opaque version string for the model catalog this token was minted against.'),
  })
  .describe(
    'A minted inference token. The `token` value is returned once and is a credential. No price appears here.'
  );

/** A minted inference token. */
export type InferenceToken = z.infer<typeof InferenceTokenSchema>;

/**
 * What one routed model supports.
 *
 * Booleans, and mechanism rather than catalog: they say what a caller may send,
 * not which model it is or who serves it.
 */
export const ModelSupportsSchema = z
  .object({
    tools: z.boolean(),
    promptCaching: z.boolean(),
    streaming: z.boolean(),
    thinking: z.boolean(),
  })
  .describe('What a routed model supports. Capability booleans only.');

/**
 * One routed model.
 *
 * `id` is an opaque string. Publishing the set of routed models would freeze
 * the catalog into a `.d.ts` on public npm, and read beside the published price
 * list it would say more than the list does.
 */
export const InferenceModelSchema = z
  .object({
    id: IdSchema.describe(
      'An opaque model identifier. The set is never enumerated in this package.'
    ),
    displayName: z.string(),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    supports: ModelSupportsSchema,
  })
  .describe('One routed model. No provider or vendor is named anywhere in this shape.');

/** One routed model. */
export type InferenceModel = z.infer<typeof InferenceModelSchema>;

/** `GET /v1/inference/models` — the models this caller may route to. */
export const InferenceModelsResponseSchema = z
  .object({
    catalogVersion: z.string(),
    models: z.array(InferenceModelSchema),
  })
  .describe(
    'The models this caller may route to, and the opaque version of the catalog they came from.'
  );

/** `POST /v1/inference/tokens/{tokenId}/revoke`. */
export const InferenceTokenRevokeResponseSchema = z
  .object({ revoked: z.boolean() })
  .describe('Whether the token is now revoked. Revoking an already-revoked token is not an error.');

/**
 * Why an inference request was refused.
 *
 * Mechanism: each value names a condition a caller can act on, and none of them
 * names a subscription, a model or a supplier.
 *
 * Two of them are easy to mistake for a neighbour, and the difference is the
 * whole reason they are separate values rather than one:
 *
 *   - `daily_limit_reached` — the account's daily spending limit is reached.
 *     The action is to wait for the reset, or to ask an administrator to raise
 *     it. That is a different action from `balance_exhausted`, which is
 *     answered by buying credit, so answering one with the other sends a person
 *     to a checkout page that will not help them.
 *   - `turn_budget_exhausted` — a single turn's extension budget or run width
 *     bound was reached. The action is to end the turn, or to run less at once.
 *     That is a different action from `rate_limited` or `concurrency_exceeded`,
 *     which are answered by waiting and retrying the same work unchanged.
 *
 * What either limit is, and how it is arrived at, is not published here.
 *
 * This is a published vocabulary rather than a field: no response shape in this
 * contract references it yet. Both sides can agree on the words before the row
 * that carries them exists, and a reader should expect the field it eventually
 * appears on to arrive in a later release.
 */
export const InferenceRefusalReasonSchema = z
  .enum([
    'balance_exhausted',
    'rate_limited',
    'concurrency_exceeded',
    'model_unavailable',
    'token_revoked',
    'token_expired',
    'entitlement_required',
    'daily_limit_reached',
    'turn_budget_exhausted',
  ])
  .describe(
    'Why an inference request was refused. Conditions a caller can act on; nothing about what they bought.'
  );

/** Why an inference request was refused. */
export type InferenceRefusalReason = z.infer<typeof InferenceRefusalReasonSchema>;
