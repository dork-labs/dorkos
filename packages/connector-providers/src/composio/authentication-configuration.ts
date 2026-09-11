/** Closed provider metadata used to select one hosted authentication method. */
import { z } from 'zod';
import {
  projectComposioAuthenticationConfigPolicy,
  type ComposioAuthenticationConfigPolicy,
} from './authentication-config-policy.js';
import {
  ComposioAuthenticationDescriptorSchema,
  type ComposioAuthenticationDescriptor,
} from './authentication-contract.js';

/** Normalized method metadata; contains no provider credentials or defaults. */
export interface ComposioAuthenticationMethod {
  scheme: string;
  needsDeveloperConfiguration: boolean;
  descriptor?: ComposioAuthenticationDescriptor;
}

/** Exact selected-toolkit metadata; never an authority-bearing public DTO. */
export interface ComposioToolkitAuthentication {
  toolkit: string;
  enabled: boolean;
  managedOAuth2: boolean;
  managedScopes: string[];
  managedUserScopes: string[];
  methods: ComposioAuthenticationMethod[];
}

/** Safe configuration identity; vendor credentials and shared secrets are discarded. */
export interface ComposioAuthenticationConfiguration {
  id: string;
  name: string;
  toolkit: string;
  scheme: string;
  enabled: boolean;
  managed: boolean;
  policy?: ComposioAuthenticationConfigPolicy;
}

const metadataIssueLocations = [
  'auth_config_creation_required',
  'auth_config_creation_optional',
  'connected_account_initiation_required',
  'connected_account_initiation_optional',
] as const;
type MetadataIssueLocation = (typeof metadataIssueLocations)[number];
const metadataMethodKinds = ['oauth2', 'supported_account_fields', 'other'] as const;
type MetadataMethodKind = (typeof metadataMethodKinds)[number];

function isMetadataIssueLocation(value: string): value is MetadataIssueLocation {
  return (metadataIssueLocations as readonly string[]).includes(value);
}

function isMetadataMethodKind(value: string): value is MetadataMethodKind {
  return (metadataMethodKinds as readonly string[]).includes(value);
}

/** Closed capability refusal with no provider response or credential values. */
export class ComposioAuthenticationSetupError extends Error {
  /** Stable server-only reason safe for structured diagnostics. */
  readonly reason:
    'disabled' | 'configured_mismatch' | 'unsupported_method' | 'unsupported_metadata';
  /** Count of strict metadata issue objects, never provider keys or values. */
  readonly metadataIssueCount?: number;
  /** Fixed schema regions containing strict metadata issues. */
  readonly metadataIssueLocations?: readonly MetadataIssueLocation[];
  /** Closed authentication-method classes containing strict metadata issues. */
  readonly metadataMethodKinds?: readonly MetadataMethodKind[];

  constructor(
    reason: ComposioAuthenticationSetupError['reason'],
    metadata?: {
      issueCount: number;
      issueLocations: readonly string[];
      methodKinds: readonly string[];
    }
  ) {
    super(
      reason === 'unsupported_metadata'
        ? 'This service declares account-field constraints DorkOS does not support yet.'
        : reason === 'disabled'
          ? 'This service is currently unavailable.'
          : reason === 'configured_mismatch'
            ? 'The configured account setup does not match this service.'
            : 'This service needs advanced account setup or uses account fields DorkOS does not support yet.'
    );
    this.name = 'ComposioAuthenticationSetupError';
    this.reason = reason;
    if (
      reason === 'unsupported_metadata' &&
      metadata &&
      Number.isSafeInteger(metadata.issueCount) &&
      metadata.issueCount > 0
    ) {
      this.metadataIssueCount = metadata.issueCount;
      this.metadataIssueLocations = Object.freeze(
        [...new Set(metadata.issueLocations.filter(isMetadataIssueLocation))].sort()
      );
      this.metadataMethodKinds = Object.freeze(
        [...new Set(metadata.methodKinds.filter(isMetadataMethodKind))].sort()
      );
    }
  }
}

const text = z.string().min(1).max(512);
const rawField = z
  .object({
    name: text,
    displayName: z.string().max(512),
    description: z.string().max(2048),
    required: z.boolean(),
    type: text,
    is_secret: z.boolean().optional(),
    user_visible: z.boolean().optional(),
    default: z.string().nullable().optional(),
    legacy_template_name: z.string().optional(),
  })
  .strict();
const providerOwnedOAuthAppSetupField = rawField.strip();
const fieldGroup = z.object({
  required: z.array(rawField).max(64),
  optional: z.array(rawField).max(64),
});

function stripProviderOwnedOAuthAppSetupConstraints(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const method = raw as Record<string, unknown>;
  if (method.mode !== 'OAUTH2' || !method.fields || typeof method.fields !== 'object') return raw;
  const fields = method.fields as Record<string, unknown>;
  const creation = fields.auth_config_creation;
  if (!creation || typeof creation !== 'object' || Array.isArray(creation)) return raw;
  const groups = creation as Record<string, unknown>;
  if (!Array.isArray(groups.required) || !Array.isArray(groups.optional)) return raw;

  const strip = (field: unknown): unknown => {
    const parsed = providerOwnedOAuthAppSetupField.safeParse(field);
    return parsed.success ? parsed.data : field;
  };
  return {
    ...method,
    fields: {
      ...fields,
      auth_config_creation: {
        ...groups,
        required: groups.required.map(strip),
        optional: groups.optional.map(strip),
      },
    },
  };
}

const authenticationMethod = z.preprocess(
  stripProviderOwnedOAuthAppSetupConstraints,
  z.object({
    mode: text,
    fields: z.object({
      auth_config_creation: fieldGroup,
      connected_account_initiation: fieldGroup,
    }),
  })
);
const metadata = z.object({
  slug: z.string().min(1).max(200),
  enabled: z.boolean(),
  composio_managed_auth_schemes: z.array(text).max(64).optional(),
  composio_managed_auth: z
    .array(
      z.object({
        mode: text,
        scopes: z.object({ available: z.array(text).max(512) }),
        user_scopes: z.object({ available: z.array(text).max(512) }).optional(),
      })
    )
    .max(64)
    .optional(),
  auth_config_details: z.array(authenticationMethod).max(64).optional(),
});

function invalid(): never {
  throw new Error('Composio returned invalid authentication metadata.');
}

function strictMetadataIssueLocation(path: PropertyKey[]): MetadataIssueLocation | undefined {
  if (
    path.length !== 6 ||
    path[0] !== 'auth_config_details' ||
    typeof path[1] !== 'number' ||
    path[2] !== 'fields' ||
    !['auth_config_creation', 'connected_account_initiation'].includes(String(path[3])) ||
    !['required', 'optional'].includes(String(path[4])) ||
    typeof path[5] !== 'number'
  ) {
    return undefined;
  }
  const location = `${String(path[3])}_${String(path[4])}`;
  return isMetadataIssueLocation(location) ? location : undefined;
}

function strictMetadataMethodKind(raw: unknown, path: PropertyKey[]): MetadataMethodKind {
  if (
    path[0] !== 'auth_config_details' ||
    typeof path[1] !== 'number' ||
    !raw ||
    typeof raw !== 'object'
  ) {
    return 'other';
  }
  const details = (raw as Record<string, unknown>).auth_config_details;
  const method = Array.isArray(details) ? details[path[1]] : undefined;
  const mode =
    method && typeof method === 'object' ? (method as Record<string, unknown>).mode : undefined;
  if (mode === 'OAUTH2') return 'oauth2';
  if (['API_KEY', 'BEARER_TOKEN', 'BASIC', 'NO_AUTH'].includes(String(mode)))
    return 'supported_account_fields';
  return 'other';
}

/** Normalize only declared fields; unsupported types stay unavailable rather than becoming OAuth. */
export function normalizeComposioToolkitAuthentication(
  raw: unknown
): ComposioToolkitAuthentication {
  const parsed = metadata.safeParse(raw);
  if (!parsed.success) {
    const strictIssues = parsed.error.issues.filter((issue) => issue.code === 'unrecognized_keys');
    if (strictIssues.length > 0)
      throw new ComposioAuthenticationSetupError('unsupported_metadata', {
        issueCount: strictIssues.length,
        issueLocations: strictIssues.flatMap((issue) => {
          const location = strictMetadataIssueLocation(issue.path);
          return location ? [location] : [];
        }),
        methodKinds: strictIssues.map((issue) => strictMetadataMethodKind(raw, issue.path)),
      });
    return invalid();
  }
  const value = parsed.data;
  const managed = value.composio_managed_auth?.filter((item) => item.mode === 'OAUTH2') ?? [];
  if (managed.length > 1) return invalid();
  const details = value.auth_config_details ?? [];
  if (new Set(details.map((item) => item.mode)).size !== details.length) return invalid();
  return {
    toolkit: value.slug,
    enabled: value.enabled,
    managedOAuth2:
      managed.length === 1 || value.composio_managed_auth_schemes?.includes('OAUTH2') === true,
    managedScopes: managed[0]?.scopes.available ?? [],
    managedUserScopes: managed[0]?.user_scopes?.available ?? [],
    methods: details.map((method) => {
      const initiation = method.fields.connected_account_initiation;
      const fields = [
        ...initiation.required.map((field) => ({ ...field, required: true })),
        ...initiation.optional,
      ];
      // Connect Link collects OAuth context itself; it does not enter our credential POST.
      const normalized = ComposioAuthenticationDescriptorSchema.safeParse({
        toolkit: value.slug,
        scheme: method.mode,
        kind: method.mode === 'OAUTH2' ? 'oauth' : method.mode === 'NO_AUTH' ? 'none' : 'fields',
        source: 'account-fields',
        fields:
          method.mode === 'OAUTH2'
            ? []
            : fields.map((field) => ({
                name: field.name,
                label: field.displayName || field.name,
                description: field.description,
                type: field.type,
                required: field.required,
                secret: field.is_secret === true || field.type === 'password',
              })),
      });
      const requiredWireField =
        method.mode === 'BEARER_TOKEN' ? 'token' : method.mode === 'BASIC' ? 'username' : undefined;
      const requiredField =
        normalized.success && requiredWireField
          ? normalized.data.fields.find(
              (field) =>
                field.name === requiredWireField && ['string', 'password'].includes(field.type)
            )
          : undefined;
      const wireSupported = !requiredWireField || Boolean(requiredField);
      // Connect Link owns OAuth context. Our credential forms cannot honor hidden
      // account fields, so keep that method unavailable instead of exposing or
      // silently dropping them. Other valid methods remain selectable.
      const visibilitySupported =
        method.mode === 'OAUTH2' || fields.every((field) => field.user_visible !== false);
      // The pinned create union requires these fields even if toolkit metadata calls them optional.
      if (requiredField) requiredField.required = true;
      return {
        scheme: method.mode,
        needsDeveloperConfiguration: method.fields.auth_config_creation.required.length > 0,
        ...(normalized.success && wireSupported && visibilitySupported
          ? { descriptor: normalized.data }
          : {}),
      };
    }),
  };
}

/** Drop every provider envelope field except exact configuration identity and status. */
export function normalizeComposioAuthenticationConfiguration(
  raw: unknown
): ComposioAuthenticationConfiguration {
  const parsed = z
    .object({
      id: text,
      name: text,
      toolkit: z.object({ slug: z.string().min(1).max(200) }),
      auth_scheme: text,
      status: z.enum(['ENABLED', 'DISABLED']),
      is_composio_managed: z.boolean().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return invalid();
  const policy = projectComposioAuthenticationConfigPolicy(raw);
  return {
    ...(policy ? { policy } : {}),
    id: parsed.data.id,
    name: parsed.data.name,
    toolkit: parsed.data.toolkit.slug,
    scheme: parsed.data.auth_scheme,
    enabled: parsed.data.status === 'ENABLED',
    managed: parsed.data.is_composio_managed === true,
  };
}

/** Prefer an explicit configuration, then managed OAuth, then declared account-field methods. */
export function selectComposioAuthentication(
  toolkit: ComposioToolkitAuthentication,
  configured?: ComposioAuthenticationConfiguration
): ComposioAuthenticationDescriptor {
  if (!toolkit.enabled) throw new ComposioAuthenticationSetupError('disabled');
  if (configured) {
    if (!configured.enabled || configured.toolkit !== toolkit.toolkit)
      throw new ComposioAuthenticationSetupError('configured_mismatch');
    // An exact enabled OAuth2 configuration already supplies developer setup; Connect Link
    // collects its context even when optional toolkit field metadata is absent.
    if (configured.scheme === 'OAUTH2') {
      return {
        toolkit: toolkit.toolkit,
        scheme: 'OAUTH2',
        kind: 'oauth',
        source: 'configured',
        fields: [],
      };
    }
    const method = toolkit.methods.find((item) => item.scheme === configured.scheme);
    if (!method?.descriptor) throw new ComposioAuthenticationSetupError('unsupported_method');
    return { ...method.descriptor, source: 'configured' };
  }
  if (toolkit.managedOAuth2) {
    return {
      toolkit: toolkit.toolkit,
      scheme: 'OAUTH2',
      kind: 'oauth',
      source: 'managed',
      fields: [],
    };
  }
  for (const scheme of ['API_KEY', 'BEARER_TOKEN', 'BASIC', 'NO_AUTH']) {
    const method = toolkit.methods.find((item) => item.scheme === scheme);
    if (method?.descriptor && !method.needsDeveloperConfiguration) return method.descriptor;
  }
  throw new ComposioAuthenticationSetupError('unsupported_method');
}

/** Check mutable automatic policy without applying that restriction to an explicit custom mapping. */
export function matchesComposioAutomaticAuthenticationPolicy(
  config: ComposioAuthenticationConfiguration,
  toolkit: ComposioToolkitAuthentication,
  descriptor: ComposioAuthenticationDescriptor
): boolean {
  const policy = config.policy;
  if (!policy || policy.routerEnabled || descriptor.source === 'configured') return false;
  return descriptor.source === 'managed'
    ? config.managed &&
        policy.type === 'default' &&
        policy.scopes.every((scope) => toolkit.managedScopes.includes(scope)) &&
        policy.userScopes.every((scope) => toolkit.managedUserScopes.includes(scope))
    : !config.managed && policy.type === 'custom' && policy.credentialsEmpty;
}
