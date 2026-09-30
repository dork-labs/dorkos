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
    // Fly stores no options for a bucket created without them (as this launcher creates it) and
    // answers `options: null` (DOR-2559; `AddOn.options: JSON` is nullable in Fly's schema). That
    // is Fly's private default. The key must still be present, and a present `public` must be a
    // boolean, so only an explicit `public: true` reads as public.
    options: z.object({ public: z.boolean() }).passthrough().nullable(),
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

/**
 * The create answer also carries the bucket's `environment`, which holds its access keys. It is
 * accepted here as opaque data and handed only to `tigrisCredentialsFromEnvironment`; the identity
 * never includes it.
 */
const CreateEnvelopeSchema = z
  .object({
    data: z
      .object({
        createAddOn: z
          .object({ addOn: AddOnSchema.extend({ environment: z.unknown().optional() }) })
          .strict(),
      })
      .strict(),
  })
  .strict();

/** Printable, single-line key text; anything else is treated as no key at all. */
const TigrisKeyValueSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[\x21-\x7e]+$/u);
const TigrisEnvironmentSchema = z
  .object({ AWS_ACCESS_KEY_ID: TigrisKeyValueSchema, AWS_SECRET_ACCESS_KEY: TigrisKeyValueSchema })
  .passthrough();

const CredentialsEnvelopeSchema = z
  .object({
    data: z
      .object({
        addOn: z.object({ id: SafeIdentifierSchema, environment: z.unknown().optional() }).strict(),
      })
      .strict(),
  })
  .strict();

const ReadEnvelopeSchema = z
  .object({
    // Fly's GraphQL has no Relay `node` root field; `addOn(id:)` is the exact-ID read (live gate,
    // DOR-2169, 2026-09-29: `node(id:)` answered only "Field 'node' doesn't exist on type 'Queries'").
    // Not nullable: a bare `addOn: null` without Fly's NOT_FOUND error is not proof the bucket is
    // gone, and treating it as gone once let cleanup skip a bucket that was still billing (DOR-2584
    // review). Only `AddOnNotFoundEnvelopeSchema` means missing.
    data: z.object({ addOn: AddOnSchema }).strict(),
  })
  .strict();
/**
 * Fly's answer for an add-on id it does not know (live, 2026-09-29): `data.addOn` is null and every
 * error is a `NOT_FOUND` on the `addOn` path. Only this exact shape means "gone"; any other error,
 * or a not-found beside other errors, stays an invalid response.
 */
const AddOnNotFoundEnvelopeSchema = z
  .object({
    data: z.object({ addOn: z.null() }).strict(),
    errors: z
      .array(
        z
          .object({
            path: z.tuple([z.literal('addOn')]),
            extensions: z.object({ code: z.literal('NOT_FOUND') }).passthrough(),
          })
          .passthrough()
      )
      .min(1),
  })
  .strict();

/**
 * Fly's answer for an add-on it has deleted (live gate, 2026-09-30): the exact-ID read still returns
 * it, renamed `<name>_deleted_<suffix>`, with `status: "deleted"` and `app: null`. Fly soft-deletes
 * and keeps the record, so this, like `NOT_FOUND`, means the bucket is gone; `fly storage list` no
 * longer shows it. Only this exact shape counts: a deleted status beside an attached app, another
 * provider, or any error stays an invalid response.
 */
const AddOnDeletedEnvelopeSchema = z
  .object({
    data: z
      .object({
        addOn: z
          .object({
            id: SafeIdentifierSchema,
            name: SafeIdentifierSchema,
            status: z.literal('deleted'),
            options: z.unknown(),
            organization: z.object({ slug: SafeIdentifierSchema }).strict(),
            addOnProvider: z.object({ name: z.literal('tigris') }).strict(),
            app: z.null(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const AppTigrisEnvelopeSchema = z
  .object({
    data: z
      .object({
        app: z
          .object({
            name: SafeIdentifierSchema,
            addOns: z
              .object({
                totalCount: z.number().int().nonnegative(),
                nodes: z.array(
                  z.object({ id: SafeIdentifierSchema, name: SafeIdentifierSchema }).strict()
                ),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
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
        environment
        organization { slug }
        addOnProvider { name }
        app { id name }
      }
    }
  }
`;

/**
 * Exact-ID read of the bucket's access keys, used only when resuming a launch that stopped after
 * Fly created the bucket but before its keys reached the app. flyctl itself reads `environment`
 * only from the create answer, so Fly may return nothing here; the caller then stops instead of
 * guessing.
 */
export const FLY_TIGRIS_CREDENTIALS_QUERY = `
  query DorkosReadTigrisCredentials($id: ID!) {
    addOn(id: $id) {
      id
      environment
    }
  }
`;

/**
 * Every Tigris bucket attached to one app, by id and name. The live gate's cleanup uses it to
 * confirm a bucket Fly reported as not found is really absent before it skips deleting it.
 */
export const FLY_APP_TIGRIS_QUERY = `
  query DorkosListAppTigris($appName: String!) {
    app(name: $appName) {
      name
      addOns(type: tigris, first: 50) {
        totalCount
        nodes { id name }
      }
    }
  }
`;

/** Minimal exact-ID readback used after Tigris creation. */
export const FLY_TIGRIS_READ_QUERY = `
  query DorkosReadTigris($id: ID!) {
    addOn(id: $id) {
      id
      name
      status
      options
      organization { slug }
      addOnProvider { name }
      app { id name }
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

/**
 * A bucket's two access keys, held only in memory. flyctl sets these on the app itself from the
 * add-on's `environment` (`setSecretsFromExtension`); Fly's servers do not, so the launcher does.
 */
export class TigrisBucketCredentials {
  #values: { AWS_ACCESS_KEY_ID: string; AWS_SECRET_ACCESS_KEY: string } | undefined;

  /**
   * Wrap validated keys without exposing them as object data.
   *
   * @param accessKeyId - The bucket's access key id.
   * @param secretAccessKey - The bucket's secret access key.
   */
  constructor(accessKeyId: string, secretAccessKey: string) {
    this.#values = { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey };
  }

  /**
   * Use the keys, by their app secret names, inside one bounded callback.
   *
   * @param consumer - The secret-staging call.
   * @returns The consumer result.
   */
  async use<T>(consumer: (values: Readonly<Record<string, string>>) => Promise<T>): Promise<T> {
    if (!this.#values) throw new FlyGraphqlContractError('INVALID_RESPONSE');
    return consumer(this.#values);
  }

  /** Drop this wrapper's reference to the keys. */
  dispose(): void {
    this.#values = undefined;
  }

  /** Return a safe marker for string interpolation. */
  toString(): string {
    return '[REDACTED Tigris bucket credentials]';
  }

  /** Return a safe marker for JSON serialization. */
  toJSON(): string {
    return '[REDACTED Tigris bucket credentials]';
  }
}

/** A created bucket's identity, plus its keys when Fly sent them. */
export interface TigrisCreateResult {
  /** Sanitized, non-secret identity. */
  identity: TigrisAddOnIdentity;
  /** The bucket's access keys, or null when the answer carried none usable. */
  credentials: TigrisBucketCredentials | null;
}

/**
 * Pick the two access keys out of an add-on `environment`, ignoring every other entry.
 *
 * Never throws: a missing or malformed environment is reported as no keys, so it cannot turn a
 * created bucket into an uncertain creation, and no key text can reach an error.
 *
 * @param environment - The add-on's `environment` JSON as Fly returned it.
 * @returns Redacting credentials, or null.
 */
export function tigrisCredentialsFromEnvironment(
  environment: unknown
): TigrisBucketCredentials | null {
  const parsed = TigrisEnvironmentSchema.safeParse(environment);
  if (!parsed.success) return null;
  return new TigrisBucketCredentials(
    parsed.data.AWS_ACCESS_KEY_ID,
    parsed.data.AWS_SECRET_ACCESS_KEY
  );
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
    public: addOn.options?.public ?? false,
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
 * Parse a Tigris creation response into its non-secret identity and its access keys.
 *
 * @param response - Decoded response held in the bounded sensitive sink.
 * @returns Sanitized add-on identity and binding, plus redacting credentials when present.
 */
export function parseTigrisCreateResponse(response: unknown): TigrisCreateResult {
  let parsed: z.infer<typeof CreateEnvelopeSchema>;
  try {
    parsed = CreateEnvelopeSchema.parse(response);
  } catch {
    throw invalidResponse();
  }
  const { environment, ...addOn } = parsed.data.createAddOn.addOn;
  return {
    identity: sanitizeAddOn(addOn),
    credentials: tigrisCredentialsFromEnvironment(environment),
  };
}

/**
 * Parse an exact-ID read of a bucket's access keys.
 *
 * @param response - Decoded response held in the bounded sensitive sink.
 * @param expectedId - The add-on ID that was asked for.
 * @returns Redacting credentials, or null when Fly returned none usable.
 */
export function parseTigrisCredentialsResponse(
  response: unknown,
  expectedId: string
): TigrisBucketCredentials | null {
  if (AddOnNotFoundEnvelopeSchema.safeParse(response).success) {
    throw new FlyGraphqlContractError('ADD_ON_MISSING');
  }
  let parsed: z.infer<typeof CredentialsEnvelopeSchema>;
  try {
    parsed = CredentialsEnvelopeSchema.parse(response);
  } catch {
    throw invalidResponse();
  }
  if (parsed.data.addOn.id !== expectedId) throw new FlyGraphqlContractError('BINDING_MISMATCH');
  return tigrisCredentialsFromEnvironment(parsed.data.addOn.environment);
}

/**
 * Parse an exact-ID Tigris readback into its non-secret identity.
 *
 * @param response - Decoded response held in the bounded sensitive sink.
 * @returns Sanitized add-on identity and binding.
 */
export function parseTigrisReadResponse(response: unknown): TigrisAddOnIdentity {
  if (
    AddOnNotFoundEnvelopeSchema.safeParse(response).success ||
    AddOnDeletedEnvelopeSchema.safeParse(response).success
  ) {
    throw new FlyGraphqlContractError('ADD_ON_MISSING');
  }
  let parsed: z.infer<typeof ReadEnvelopeSchema>;
  try {
    parsed = ReadEnvelopeSchema.parse(response);
  } catch {
    throw invalidResponse();
  }
  return sanitizeAddOn(parsed.data.addOn);
}

/**
 * Parse the Tigris buckets attached to one app.
 *
 * @param response - Decoded response held in the bounded sensitive sink.
 * @param appName - The app that was asked about.
 * @returns Every attached bucket's id and name; refuses a partial page or another app's answer.
 */
export function parseAppTigrisResponse(
  response: unknown,
  appName: string
): Array<{ id: string; name: string }> {
  let parsed: z.infer<typeof AppTigrisEnvelopeSchema>;
  try {
    parsed = AppTigrisEnvelopeSchema.parse(response);
  } catch {
    throw invalidResponse();
  }
  const { app } = parsed.data;
  if (app.name !== appName) throw new FlyGraphqlContractError('BINDING_MISMATCH');
  if (app.addOns.totalCount !== app.addOns.nodes.length) throw invalidResponse();
  return app.addOns.nodes.map(({ id, name }) => ({ id, name }));
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
