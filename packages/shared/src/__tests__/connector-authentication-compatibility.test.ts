import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  projectConnectorAuthentication,
  ConnectorAuthenticationSetupSchema,
} from '../connector-authentication-setup.js';
import { ManagedConnectorCatalogPageSchema } from '../connector-managed-discovery-schemas.js';

// Exact pre-DOR1958 wire shape at57171c4. Keeping this frozen catches compatibility breaks in new schemas.
const legacyAvailability = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available') }),
  z.object({ status: z.literal('unsupported'), reason: z.string().min(1) }),
]);
const legacyToolkit = z
  .object({
    slug: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200),
    authKind: z.enum(['oauth2', 'api-key', 'none']),
    authentication: legacyAvailability.optional(),
    maxAccountsPerUser: z.number().int().positive().optional(),
  })
  .strict();
const legacyPage = z
  .object({
    version: z.literal(1),
    toolkits: z.array(legacyToolkit).max(100),
    nextCursor: z.string().min(1).max(500).optional(),
    truncated: z.boolean(),
  })
  .strict();

describe('negotiated catalog authentication compatibility', () => {
  const rows = [
    ['OAUTH2', 'oauth', 'managed'],
    ['API_KEY', 'fields', 'account-fields'],
    ['BEARER_TOKEN', 'fields', 'account-fields'],
    ['BASIC', 'fields', 'account-fields'],
    ['NO_AUTH', 'none', 'account-fields'],
    ['UNKNOWN', 'unsupported', 'unsupported'],
  ].map(([scheme, kind, source]) => ({
    slug: scheme,
    displayName: scheme,
    authKind: 'oauth2' as const,
    authentication: { status: 'available' as const },
    authenticationSetup: ConnectorAuthenticationSetupSchema.parse({
      scheme,
      kind,
      source,
      requiresAccountFields: kind === 'fields',
    }),
  }));
  it('keeps the whole mixed page parseable by released strict clients without lying about new methods', () => {
    const page = {
      version: 1,
      toolkits: rows.map((row) => projectConnectorAuthentication(row, false)),
      nextCursor: 'page2',
      truncated: true,
    };
    expect(legacyPage.parse(page).toolkits).toHaveLength(6);
    expect(JSON.stringify(page)).not.toContain('authenticationSetup');
    expect(page.toolkits[2].authentication.status).toBe('unsupported');
    expect(page.toolkits[3].authentication.status).toBe('unsupported');
    expect(page.toolkits[5].authentication.status).toBe('unsupported');
    expect(page.toolkits[0].authentication.status).toBe('available');
  });
  it('requires negotiation for rich fields and new callers accept an old server response', () => {
    const rich = {
      version: 1,
      toolkits: rows.map((row) => projectConnectorAuthentication(row, true)),
      truncated: false,
    };
    expect(legacyPage.safeParse(rich).success).toBe(false);
    expect(
      ManagedConnectorCatalogPageSchema.parse(rich).toolkits[2].authenticationSetup?.kind
    ).toBe('fields');
    const old = {
      ...rich,
      toolkits: rows.map((row) => projectConnectorAuthentication(row, false)),
    };
    expect(ManagedConnectorCatalogPageSchema.parse(old)).toEqual(old);
  });
});
