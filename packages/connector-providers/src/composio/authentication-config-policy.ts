/** Nonsecret projection of mutable automatic-authentication configuration policy. */
import { z } from 'zod';

/** Supported upstream policy facts; credential values and unknown keys are never retained. */
export interface ComposioAuthenticationConfigPolicy {
  type: 'default' | 'custom';
  scopes: string[];
  userScopes: string[];
  credentialsEmpty: boolean;
  routerEnabled: boolean;
}
const scopeValue = z.union([z.string().max(16_384), z.array(z.string().max(512)).max(512)]);
const credentials = z
  .object({ scopes: scopeValue.optional(), user_scopes: scopeValue.optional() })
  .strict();
const managedCredentials = credentials.extend({
  client_id: z.string().max(16_384).optional(),
  client_secret: z.string().max(16_384).optional(),
  oauth_redirect_uri: z
    .enum([
      'https://backend.composio.dev/api/v1/auth-apps/add',
      'https://backend.composio.dev/api/v3/toolkits/auth/callback',
    ])
    .optional(),
});
// Value hidden by Composio; this marker does not identify a Microsoft cloud.
const COMPOSIO_MASKED_VALUE = 'REDACTED';
/** Toolkit-only managed app metadata, validated here and never retained. */
const managedCredentialsByToolkit = {
  // Slack's legacy app token belongs to Composio, like its client_secret.
  slack: managedCredentials.extend({
    verification_token: z.string().max(16_384).optional(),
  }),
  // Security permits the public cloud and Composio's exact masking marker.
  outlook: managedCredentials
    .extend({ microsoft_cloud: z.enum(['global', COMPOSIO_MASKED_VALUE]).optional() })
    .refine(
      (value) => !Object.hasOwn(value, 'microsoft_cloud') || value.microsoft_cloud !== undefined,
      { path: ['microsoft_cloud'] }
    ),
};
const toolAccess = z
  .object({
    tools_available_for_execution: z.array(z.string()).max(0).optional(),
    tools_for_connected_account_creation: z.array(z.string()).max(0).optional(),
  })
  .strict();
const policy = z.object({
  type: z.enum(['default', 'custom']),
  credentials: credentials.optional(),
  shared_credentials: z.object({}).strict().optional(),
  // Composio added this to every config read in October 2026. Like
  // `shared_credentials` it holds values given to every connected account,
  // so only an empty object is known to carry nothing.
  shared_connection_fields: z.object({}).strict().optional(),
  proxy_config: z.null().optional(),
  restrict_to_following_tools: z.array(z.string()).max(0).optional(),
  tool_access_config: toolAccess,
  is_enabled_for_tool_router: z.boolean(),
  is_connection_revoke_supported: z.boolean().optional(),
});
const knownKeys = new Set([
  'id',
  'name',
  'no_of_connections',
  'status',
  'tool_access_config',
  'toolkit',
  'type',
  'uuid',
  'auth_scheme',
  'created_at',
  'created_by',
  'credentials',
  'expected_input_fields',
  'is_composio_managed',
  'is_connection_revoke_supported',
  'is_enabled_for_tool_router',
  'last_updated_at',
  'proxy_config',
  'restrict_to_following_tools',
  'shared_credentials',
  'shared_connection_fields',
]);
function scopes(value: string | string[] | undefined): string[] {
  return [
    ...new Set(
      (Array.isArray(value) ? value : (value?.split(/[\s,]+/) ?? []))
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ].sort();
}

function toolkitSlug(envelope: Record<string, unknown>): string {
  const toolkit = envelope.toolkit;
  if (!toolkit || typeof toolkit !== 'object' || Array.isArray(toolkit)) return 'unknown';
  const slug = (toolkit as Record<string, unknown>).slug;
  return typeof slug === 'string' && /^[a-z0-9_]{1,200}$/.test(slug) ? slug : 'unknown';
}

function refusePolicy(
  toolkit: string,
  reason: 'unsupported_policy_keys' | 'unsupported_policy_shape',
  keys: string[]
): undefined {
  // Zod messages can contain expected literals. Log only paths and key names.
  console.warn('[Composio] Authentication configuration policy refused', {
    toolkit,
    reason,
    keys: [...new Set(keys)].sort(),
  });
  return undefined;
}

/** Return only a verified empty/default policy shape; absent means unsuitable for automatic reuse. */
export function projectComposioAuthenticationConfigPolicy(
  raw: unknown
): ComposioAuthenticationConfigPolicy | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  // Managed OAuth app credentials belong to Composio, not the connected account.
  // Validate only the documented envelope; never retain its client credentials.
  const envelope = raw as Record<string, unknown>;
  const toolkit = toolkitSlug(envelope);
  const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) return refusePolicy(toolkit, 'unsupported_policy_keys', unknownKeys);
  const managed =
    envelope.type === 'default' &&
    envelope.is_composio_managed === true &&
    envelope.auth_scheme === 'OAUTH2';
  const managedCredentialSchema = Object.hasOwn(managedCredentialsByToolkit, toolkit)
    ? managedCredentialsByToolkit[toolkit as keyof typeof managedCredentialsByToolkit]
    : managedCredentials;
  const parsed = (
    managed
      ? policy.extend({
          credentials: managedCredentialSchema.optional(),
        })
      : policy
  ).safeParse(raw);
  if (!parsed.success)
    return refusePolicy(
      toolkit,
      'unsupported_policy_shape',
      parsed.error.issues.flatMap((issue) =>
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => [...issue.path, key].join('.'))
          : [issue.path.join('.')]
      )
    );
  const scopeList = scopes(parsed.data.credentials?.scopes);
  const userScopeList = scopes(parsed.data.credentials?.user_scopes);
  // Composio stores `scopes: []` on every API-key, bearer, basic and no-auth
  // config it creates, so an empty scope list holds no credential. Any other
  // key, or any scope at all, still counts as one.
  const credentialsEmpty = Object.keys(parsed.data.credentials ?? {}).every(
    (key) =>
      (key === 'scopes' || key === 'user_scopes') &&
      scopeList.length === 0 &&
      userScopeList.length === 0
  );
  return {
    type: parsed.data.type,
    scopes: scopeList,
    userScopes: userScopeList,
    credentialsEmpty,
    routerEnabled: parsed.data.is_enabled_for_tool_router,
  };
}
