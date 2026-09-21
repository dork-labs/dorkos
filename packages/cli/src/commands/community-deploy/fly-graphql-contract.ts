/**
 * Minimal, secret-safe Fly GraphQL contracts used by Community deployment.
 *
 * @module commands/community-deploy/fly-graphql-contract
 */
import { z } from 'zod';

const SafeIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const SafeStatusSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

const AddOnSchema = z
  .object({
    id: SafeIdentifierSchema,
    name: SafeIdentifierSchema,
    status: SafeStatusSchema,
    options: z.object({ public: z.boolean() }).passthrough(),
    organization: z.object({ slug: SafeIdentifierSchema }).strict(),
    addOnProvider: z.object({ name: SafeIdentifierSchema }).strict(),
    app: z.object({ id: SafeIdentifierSchema, name: SafeIdentifierSchema }).strict(),
  })
  .strict();

const TermsEnvelopeSchema = z
  .object({
    data: z
      .object({
        viewer: z.object({ agreedToProviderTos: z.boolean() }).strict().nullable(),
      })
      .strict(),
  })
  .strict();

const CreateEnvelopeSchema = z
  .object({
    data: z.object({ createAddOn: z.object({ addOn: AddOnSchema }).strict() }).strict(),
  })
  .strict();

const ReadEnvelopeSchema = z
  .object({
    data: z.object({ node: AddOnSchema.nullable() }).strict(),
  })
  .strict();

const ExpectedBindingSchema = z
  .object({
    addOnId: SafeIdentifierSchema,
    addOnName: SafeIdentifierSchema,
    organizationSlug: SafeIdentifierSchema,
    appId: SafeIdentifierSchema,
    appName: SafeIdentifierSchema,
  })
  .strict();

const CreateInputSchema = z
  .object({
    clientMutationId: SafeIdentifierSchema,
    appId: SafeIdentifierSchema,
    organizationId: SafeIdentifierSchema,
    name: SafeIdentifierSchema,
    primaryRegion: SafeIdentifierSchema,
  })
  .strict();

/** Minimal query for the provider terms gate. */
export const FLY_TIGRIS_TERMS_QUERY = `
  query DorkosTigrisTerms($provider: String!) {
    viewer {
      ... on User {
        agreedToProviderTos(providerName: $provider)
      }
    }
  }
`;

/**
 * Minimal creation mutation. The input deliberately has no `options` member, so public access
 * cannot be requested by this operation.
 */
export const FLY_TIGRIS_CREATE_MUTATION = `
  mutation DorkosCreateTigris($input: CreateAddOnInput!) {
    createAddOn(input: $input) {
      addOn {
        id
        name
        status
        options
        organization { slug }
        addOnProvider { name }
        app { id name }
      }
    }
  }
`;

/** Minimal exact-ID readback used after Tigris creation. */
export const FLY_TIGRIS_READ_QUERY = `
  query DorkosReadTigris($id: ID!) {
    node(id: $id) {
      ... on AddOn {
        id
        name
        status
        options
        organization { slug }
        addOnProvider { name }
        app { id name }
      }
    }
  }
`;

/** Stable error codes emitted without copying a GraphQL response or provider message. */
export type FlyGraphqlContractErrorCode =
  | 'INVALID_RESPONSE'
  | 'TERMS_VIEWER_MISSING'
  | 'ADD_ON_MISSING'
  | 'INVALID_EXPECTED_BINDING'
  | 'BINDING_MISMATCH'
  | 'PUBLIC_BUCKET';

/** Secret-free failure from the Fly GraphQL response boundary. */
export class FlyGraphqlContractError extends Error {
  /** Stable code safe for diagnostics and recovery journals. */
  readonly code: FlyGraphqlContractErrorCode;

  /**
   * Create a response-contract error without provider payload text.
   *
   * @param code - Stable failure classification.
   */
  constructor(code: FlyGraphqlContractErrorCode) {
    super(`Fly GraphQL contract failed (${code})`);
    this.name = 'FlyGraphqlContractError';
    this.code = code;
  }
}

/** Sanitized, non-secret identity returned by the Tigris contract. */
export interface TigrisAddOnIdentity {
  /** Provider-issued add-on ID. */
  addOnId: string;
  /** Provider-issued bucket/add-on name. */
  addOnName: string;
  /** Safe provider status token. */
  status: string;
  /** Owning Fly organization slug. */
  organizationSlug: string;
  /** Add-on provider name. */
  providerName: string;
  /** Bound Fly app ID. */
  appId: string;
  /** Bound Fly app name. */
  appName: string;
  /** Whether provider readback reports public access. */
  public: boolean;
}

/** Expected Tigris identity and binding selected in the immutable plan. */
export type ExpectedTigrisBinding = z.infer<typeof ExpectedBindingSchema>;

/** Input for the minimal Tigris creation mutation. */
export type TigrisCreateInput = z.infer<typeof CreateInputSchema>;

function invalidResponse(): FlyGraphqlContractError {
  return new FlyGraphqlContractError('INVALID_RESPONSE');
}

function sanitizeAddOn(value: unknown): TigrisAddOnIdentity {
  let addOn: z.infer<typeof AddOnSchema>;
  try {
    addOn = AddOnSchema.parse(value);
  } catch {
    throw invalidResponse();
  }
  return {
    addOnId: addOn.id,
    addOnName: addOn.name,
    status: addOn.status,
    organizationSlug: addOn.organization.slug,
    providerName: addOn.addOnProvider.name,
    appId: addOn.app.id,
    appName: addOn.app.name,
    public: addOn.options.public,
  };
}

/**
 * Parse the terms query without retaining GraphQL error text or response metadata.
 *
 * @param response - Decoded response held in the bounded sensitive sink.
 * @returns Whether the authenticated Fly user accepted the Tigris provider terms.
 */
export function parseTigrisTermsResponse(response: unknown): boolean {
  let parsed: z.infer<typeof TermsEnvelopeSchema>;
  try {
    parsed = TermsEnvelopeSchema.parse(response);
  } catch {
    throw invalidResponse();
  }
  if (parsed.data.viewer === null) throw new FlyGraphqlContractError('TERMS_VIEWER_MISSING');
  return parsed.data.viewer.agreedToProviderTos;
}

/**
 * Parse a Tigris creation response into its non-secret identity.
 *
 * @param response - Decoded response held in the bounded sensitive sink.
 * @returns Sanitized add-on identity and binding.
 */
export function parseTigrisCreateResponse(response: unknown): TigrisAddOnIdentity {
  let parsed: z.infer<typeof CreateEnvelopeSchema>;
  try {
    parsed = CreateEnvelopeSchema.parse(response);
  } catch {
    throw invalidResponse();
  }
  return sanitizeAddOn(parsed.data.createAddOn.addOn);
}

/**
 * Parse an exact-ID Tigris readback into its non-secret identity.
 *
 * @param response - Decoded response held in the bounded sensitive sink.
 * @returns Sanitized add-on identity and binding.
 */
export function parseTigrisReadResponse(response: unknown): TigrisAddOnIdentity {
  let parsed: z.infer<typeof ReadEnvelopeSchema>;
  try {
    parsed = ReadEnvelopeSchema.parse(response);
  } catch {
    throw invalidResponse();
  }
  if (parsed.data.node === null) throw new FlyGraphqlContractError('ADD_ON_MISSING');
  return sanitizeAddOn(parsed.data.node);
}

/**
 * Validate the exact provider, organization, app, and private posture selected by the plan.
 *
 * @param identity - Sanitized creation or readback result.
 * @param expected - Journaled expected identity and binding.
 * @returns The unchanged identity when every binding matches.
 */
export function verifyTigrisBinding(
  identity: TigrisAddOnIdentity,
  expected: ExpectedTigrisBinding
): TigrisAddOnIdentity {
  let binding: ExpectedTigrisBinding;
  try {
    binding = ExpectedBindingSchema.parse(expected);
  } catch {
    throw new FlyGraphqlContractError('INVALID_EXPECTED_BINDING');
  }
  if (identity.public) throw new FlyGraphqlContractError('PUBLIC_BUCKET');
  if (
    identity.providerName !== 'tigris' ||
    identity.addOnId !== binding.addOnId ||
    identity.addOnName !== binding.addOnName ||
    identity.organizationSlug !== binding.organizationSlug ||
    identity.appId !== binding.appId ||
    identity.appName !== binding.appName
  ) {
    throw new FlyGraphqlContractError('BINDING_MISMATCH');
  }
  return identity;
}

/**
 * Build variables for private Tigris creation without an options/public-access field.
 *
 * @param input - Provider identities and name selected by the consented plan.
 * @returns GraphQL variables with the fixed `tigris` add-on type.
 */
export function createTigrisVariables(input: TigrisCreateInput): {
  input: TigrisCreateInput & { type: 'tigris' };
} {
  const parsed = CreateInputSchema.parse(input);
  return { input: { ...parsed, type: 'tigris' } };
}
