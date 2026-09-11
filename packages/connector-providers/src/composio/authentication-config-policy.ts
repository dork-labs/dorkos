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

/** Return only a verified empty/default policy shape; absent means unsuitable for automatic reuse. */
export function projectComposioAuthenticationConfigPolicy(
  raw: unknown
): ComposioAuthenticationConfigPolicy | undefined {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !knownKeys.has(key))
  )
    return undefined;
  // Managed OAuth app credentials belong to Composio, not the connected account.
  // Validate only the documented envelope; never retain its client credentials.
  const envelope = raw as Record<string, unknown>;
  const managed =
    envelope.type === 'default' &&
    envelope.is_composio_managed === true &&
    envelope.auth_scheme === 'OAUTH2';
  const parsed = (
    managed ? policy.extend({ credentials: managedCredentials.optional() }) : policy
  ).safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    type: parsed.data.type,
    scopes: scopes(parsed.data.credentials?.scopes),
    userScopes: scopes(parsed.data.credentials?.user_scopes),
    credentialsEmpty: Object.keys(parsed.data.credentials ?? {}).length === 0,
    routerEnabled: parsed.data.is_enabled_for_tool_router,
  };
}
