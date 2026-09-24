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
const DeleteEnvelopeSchema = z
  .object({
    data: z
      .object({
        deleteAddOn: z.object({ deletedAddOnName: SafeIdentifierSchema }).strict(),
      })
      .strict(),
  })
  .strict();

const TotalCountSchema = z.object({ totalCount: z.number().int().nonnegative() }).strict();
const AppProvenanceSchema = z
  .object({
    id: SafeIdentifierSchema,
    internalNumericId: z.number().int().nonnegative(),
    name: SafeIdentifierSchema,
    // Compared exactly; any printable value, including the empty one, is kept as reported.
    network: z
      .string()
      .max(256)
      .regex(/^[\x21-\x7e]*$/u)
      .nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    organization: z.object({ slug: SafeIdentifierSchema }).strict(),
    machines: TotalCountSchema,
    volumes: TotalCountSchema,
    ipAddresses: TotalCountSchema,
    certificates: TotalCountSchema,
    secrets: z.array(
      z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u) }).strict()
    ),
  })
  .strict();
const AppProvenanceEnvelopeSchema = z
  .object({
    data: z.object({ app: AppProvenanceSchema.nullable() }).strict(),
    // Fly answers an unknown app name with `app: null` plus an error entry; its text is never read.
    errors: z.array(z.unknown()).optional(),
  })
  .strict();

const TigrisOnAppSchema = z
  .object({
    internalNumericId: z.number().int().nonnegative(),
    name: SafeIdentifierSchema,
    network: z
      .string()
      .max(256)
      .regex(/^[\x21-\x7e]*$/u)
      .nullable(),
    organization: z.object({ slug: SafeIdentifierSchema }).strict(),
    addOns: z
      .object({
        totalCount: z.number().int().nonnegative(),
        nodes: z.array(
          z
            .object({
              id: SafeIdentifierSchema,
              name: SafeIdentifierSchema.nullable(),
              createdAt: z.iso.datetime({ offset: true }),
              organization: z.object({ slug: SafeIdentifierSchema }).strict(),
            })
            .strict()
        ),
      })
      .strict(),
  })
  .strict();
const TigrisOnAppEnvelopeSchema = z
  .object({
    data: z.object({ app: TigrisOnAppSchema.nullable() }).strict(),
    errors: z.array(z.unknown()).optional(),
  })
  .strict();
const AppNameAvailableEnvelopeSchema = z
  .object({ data: z.object({ appNameAvailable: z.boolean() }).strict() })
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

/**
 * Minimal read of one app's provenance by name. flyctl's own app reads never select `network`, and
 * `apps list --json` always reports it as `""`, so this is the only read that can see a run's marker.
 * `secrets` selects names only, never values.
 */
export const FLY_APP_PROVENANCE_QUERY = `
  query DorkosReadAppProvenance($name: String!) {
    app(name: $name) {
      id
      internalNumericId
      name
      network
      createdAt
      organization { slug }
      machines { totalCount }
      volumes { totalCount }
      ipAddresses { totalCount }
      certificates { totalCount }
      secrets { name }
    }
  }
`;

/**
 * Minimal read of the Tigris add-ons on one app, with the app's own network so a removal can
 * re-prove the app the bucket is bound to in the same readback.
 */
export const FLY_TIGRIS_ON_APP_QUERY = `
  query DorkosFindTigrisOnApp($name: String!) {
    app(name: $name) {
      internalNumericId
      name
      network
      organization { slug }
      addOns(type: tigris) {
        totalCount
        nodes { id name createdAt organization { slug } }
      }
    }
  }
`;

/** Whether Fly would accept a new app with this name now. */
export const FLY_APP_NAME_AVAILABLE_QUERY = `
  query DorkosAppNameAvailable($name: String!) {
    appNameAvailable(name: $name)
  }
`;

/** Minimal deletion mutation used only after exact journal binding is reverified. */
export const FLY_TIGRIS_DELETE_MUTATION = `
  mutation DorkosDeleteTigris($name: String!, $provider: String!) {
    deleteAddOn(input: { name: $name, provider: $provider }) {
      deletedAddOnName
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

/** Sanitized, non-secret provenance of one Fly app as the service reports it. */
export interface FlyAppProvenance {
  /** GraphQL app ID, which Fly sets to the app name. */
  id: string;
  /** Numeric app ID Fly issues at creation; never reused for a later app with the same name. */
  internalNumericId: string;
  /** Globally unique app name. */
  name: string;
  /** Private network name, or `null` when Fly reports none. */
  network: string | null;
  /** Creation time the service reported. */
  createdAt: string;
  /** Owning organization slug. */
  organizationSlug: string;
  /** Number of Machines in the app. */
  machineCount: number;
  /** Number of volumes in the app. */
  volumeCount: number;
  /** Number of IP addresses assigned to the app. */
  ipAddressCount: number;
  /** Number of certificates on the app. */
  certificateCount: number;
  /** Secret names on the app, without values. */
  secretNames: string[];
}

/** One Tigris add-on attached to an app, as the service reports it. */
export interface TigrisAddOnOnApp {
  /** Add-on ID, the confirmation token for removing it. */
  id: string;
  /** Add-on name, when the service reports one. */
  name: string | null;
  /** Creation time the service reported. */
  createdAt: string;
  /** Owning organization slug. */
  organizationSlug: string;
}

/** An app and the Tigris add-ons attached to it, read in one request. */
export interface TigrisOnApp {
  /** Numeric app ID. */
  internalNumericId: string;
  /** App name. */
  name: string;
  /** Private network name, or `null` when Fly reports none. */
  network: string | null;
  /** Owning organization slug. */
  organizationSlug: string;
  /** Number of Tigris add-ons the service says the app has. */
  totalCount: number;
  /** The add-ons returned; fewer than `totalCount` means the list was cut short. */
  addOns: TigrisAddOnOnApp[];
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
 * Parse one app provenance read without retaining GraphQL error text or response metadata.
 *
 * @param response - Decoded response held in the bounded sensitive sink.
 * @returns The app's provenance, or `null` when Fly reports no app with that name.
 */
export function parseFlyAppProvenanceResponse(response: unknown): FlyAppProvenance | null {
  let parsed: z.infer<typeof AppProvenanceEnvelopeSchema>;
  try {
    parsed = AppProvenanceEnvelopeSchema.parse(response);
  } catch {
    throw invalidResponse();
  }
  const app = parsed.data.app;
  if (app === null) return null;
  // A found app must arrive without errors; a partial success is never read as provenance.
  if (parsed.errors !== undefined && parsed.errors.length > 0) throw invalidResponse();
  return {
    id: app.id,
    internalNumericId: String(app.internalNumericId),
    name: app.name,
    network: app.network,
    createdAt: app.createdAt,
    organizationSlug: app.organization.slug,
    machineCount: app.machines.totalCount,
    volumeCount: app.volumes.totalCount,
    ipAddressCount: app.ipAddresses.totalCount,
    certificateCount: app.certificates.totalCount,
    secretNames: app.secrets.map((secret) => secret.name),
  };
}

/**
 * Parse one read of an app's Tigris add-ons.
 *
 * @param response - Decoded response held in the bounded sensitive sink.
 * @returns The app and its add-ons, or `null` when Fly reports no app with that name.
 */
export function parseTigrisOnAppResponse(response: unknown): TigrisOnApp | null {
  let parsed: z.infer<typeof TigrisOnAppEnvelopeSchema>;
  try {
    parsed = TigrisOnAppEnvelopeSchema.parse(response);
  } catch {
    throw invalidResponse();
  }
  const app = parsed.data.app;
  if (app === null) return null;
  if (parsed.errors !== undefined && parsed.errors.length > 0) throw invalidResponse();
  return {
    internalNumericId: String(app.internalNumericId),
    name: app.name,
    network: app.network,
    organizationSlug: app.organization.slug,
    totalCount: app.addOns.totalCount,
    addOns: app.addOns.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      createdAt: node.createdAt,
      organizationSlug: node.organization.slug,
    })),
  };
}

/**
 * Parse whether Fly would accept a new app with a name. Any error entry is a failed read.
 *
 * @param response - Decoded response held in the bounded sensitive sink.
 */
export function parseAppNameAvailableResponse(response: unknown): boolean {
  try {
    return AppNameAvailableEnvelopeSchema.parse(response).data.appNameAvailable;
  } catch {
    throw invalidResponse();
  }
}

/** Parse Tigris deletion acknowledgement and bind it to the exact expected name. */
export function parseTigrisDeleteResponse(response: unknown, expectedName: string): string {
  let parsed: z.infer<typeof DeleteEnvelopeSchema>;
  try {
    parsed = DeleteEnvelopeSchema.parse(response);
  } catch {
    throw invalidResponse();
  }
  if (parsed.data.deleteAddOn.deletedAddOnName !== expectedName) {
    throw new FlyGraphqlContractError('BINDING_MISMATCH');
  }
  return parsed.data.deleteAddOn.deletedAddOnName;
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
