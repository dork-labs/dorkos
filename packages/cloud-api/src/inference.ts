import { z } from 'zod';

import {
  IdSchema,
  SecretValueSchema,
  TimestampSchema,
  UNRECOGNISED,
  tolerantEnum,
} from './primitives.js';

/**
 * `POST /v1/inference/tokens` — mint a short-lived inference token.
 *
 * The caller is taken from the bearer credential; `seatRef` and `agentRef` only
 * narrow it. Two kinds of caller may mint: an instance linked to an account
 * (a person's computer or a hub), and a cloud agent computer, with its own
 * instance key.
 *
 * On an agent computer the same rules hold as anywhere else, and these:
 *
 * - Tokens stay short-lived, and the limits on them apply per computer and
 *   per account at once.
 * - What a computer spends is billed to the account that owns it, and the
 *   preview gate applies to it exactly as it does today.
 * - `agentRef`, when present, is the agent's id on the hub the computer works
 *   for: the agent lives on the hub, and the computer only runs it. It is the
 *   computer's own claim, used for attribution and billing only, never for
 *   authorization.
 */
export const InferenceTokenRequestSchema = z
  .object({
    instanceId: IdSchema,
    seatRef: IdSchema.optional(),
    agentRef: IdSchema.optional().describe(
      'The agent the token is for. On a cloud agent computer, the agent`s id on its hub. The computer`s own claim: attribution and billing only, never authorization.'
    ),
  })
  .describe('Mint a short-lived inference token for one instance.');

/**
 * The endpoints a minted token may be used against, one per request format.
 *
 * Runtime values. No host, origin or URL literal belongs in this package, and
 * which provider serves a request is not part of this contract.
 *
 * Each field is a BASE a client appends its format's own path to (`/v1/messages`,
 * `/chat/completions`, `/responses`), and each names a request format, never a
 * supplier. The first two are always present; `openaiResponses` is optional.
 * Whether a format is SERVED is said by the token's `served` list, not by an
 * endpoint being present: a format the token does not list must not be sent
 * with this token at all — not to its endpoint, not to another endpoint here,
 * and not anywhere else — so an app offers a runtime that speaks only that
 * format nothing until a token lists it.
 */
export const InferenceEndpointsSchema = z
  .object({
    anthropicMessages: z.string().url(),
    openaiChat: z.string().url(),
    openaiResponses: z
      .string()
      .url()
      .optional()
      .describe(
        'Where to send requests in the responses format. Absent when this token may not be used for that format.'
      ),
  })
  .describe(
    'Where to send inference requests, one base per request format. Runtime values; no origin is baked into this package.'
  );

/** Where a minted token may send each request format. */
export type InferenceEndpoints = z.infer<typeof InferenceEndpointsSchema>;

/**
 * One request format, named by the endpoint field that carries it. Mechanism,
 * not catalog: it says which wire a caller encodes in, never which supplier or
 * model serves it.
 */
export const InferenceFormatSchema = z
  .enum(['anthropicMessages', 'openaiChat', 'openaiResponses'])
  .describe('A request format, named by its field in `endpoints`.');

/** One request format. */
export type InferenceFormat = z.infer<typeof InferenceFormatSchema>;

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
    // Strings, not `InferenceFormatSchema`: a service a release ahead may list
    // a format this package does not know yet, and that must never make the
    // whole token fail to parse. A caller reads the values it knows
    // (`InferenceFormatSchema.options`) and ignores the rest.
    served: z
      .array(z.string())
      .optional()
      .describe(
        'The request formats this token may be used for, by their `InferenceFormatSchema` names; a value a caller does not know is ignored, never an error. Absent means `anthropicMessages` only, which is what every service before this field served: an endpoint being present is not enough, the format must be listed here too.'
      ),
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
    protocols: z
      .array(z.string())
      .optional()
      .describe(
        'The request formats (by their `InferenceFormatSchema` names) a caller should offer this model in. A caller offers a model only in a format listed here, and ignores values it does not know, never an error. Absent means the service has not said.'
      ),
    recommendedOn: z
      .array(z.string())
      .optional()
      .describe(
        'The request formats (by their `InferenceFormatSchema` names) in which this is the model the service suggests starting with. At most one model per format; a caller that finds more uses the first. Absent means none.'
      ),
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
 * It is carried as `error.dorkos_reason` on {@link InferenceErrorBodySchema},
 * the body the inference endpoint refuses a request with.
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

/**
 * The refusals that mean the account itself cannot run inference right now,
 * so a caller holds off asking for a new token for a while. Every other reason
 * means something else: wait and retry the same work (`rate_limited`,
 * `concurrency_exceeded`), end that one turn (`turn_budget_exhausted`), get a
 * new token (`token_revoked`, `token_expired`), or try another model.
 */
export const ACCOUNT_HOLD_REASONS: ReadonlySet<InferenceRefusalReason> = new Set([
  'balance_exhausted',
  'daily_limit_reached',
  'entitlement_required',
]);

/**
 * Whether a refusal's reason starts the account hold. Anything that is not
 * one of {@link ACCOUNT_HOLD_REASONS}, a reason this release does not know, a
 * missing reason or a malformed one included, does not: it passes through as
 * busy. That is the fail-safe a hold depends on.
 *
 * @param reason - The `dorkos_reason` a refusal carried, as read.
 */
export function startsAccountHold(reason: unknown): boolean {
  return typeof reason === 'string' && ACCOUNT_HOLD_REASONS.has(reason as InferenceRefusalReason);
}

/**
 * The body the inference endpoint refuses a request with: the error envelope
 * the model vendors' own clients already parse, with the service's own two
 * fields inside `error`.
 *
 * - `error.dorkos_code` is the endpoint's own word for what happened. An open
 *   string: a client never branches on it, and never starts a hold from it.
 * - `error.dorkos_reason` is the published {@link InferenceRefusalReasonSchema}
 *   word, when the endpoint has one. It may be missing, and one this release
 *   does not know reads as unrecognised rather than failing the parse, so a
 *   reason added later never breaks a computer. Only
 *   {@link startsAccountHold} decides what it means.
 * - `request_id` is null.
 *
 * A rate-limited refusal also carries a `retry-after` header: the number of
 * seconds to wait, worked out from the limit's window.
 */
export const InferenceErrorBodySchema = z
  .object({
    type: z.literal('error'),
    error: z.object({
      type: z.string().describe('The vendor-style error type.'),
      message: z.string().describe('What went wrong, for a log; never shown as a decision.'),
      dorkos_code: z
        .string()
        .optional()
        .describe('The endpoint`s own word for the refusal. Never branched on.'),
      dorkos_reason: tolerantEnum(InferenceRefusalReasonSchema)
        .optional()
        .catch(UNRECOGNISED)
        .describe(
          'The published refusal reason, when there is one. Unknown reads as unrecognised.'
        ),
    }),
    request_id: z.string().nullable().optional(),
  })
  .describe(
    'The body an inference request is refused with: the vendor error envelope plus two fields of the service`s own.'
  );

/** The body an inference request is refused with. */
export type InferenceErrorBody = z.infer<typeof InferenceErrorBodySchema>;
