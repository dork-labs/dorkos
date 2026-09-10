/** Negotiated secret-free catalog authentication metadata. */
import { z } from 'zod';
import type { ConnectorCapabilityAvailability } from './connector-schemas.js';

/** Exact opt-in header; omitted by already released strict-v1 clients. */
export const CONNECTOR_AUTH_SETUP_HEADER = 'x-dorkos-catalog-auth-setup';
/** Supported catalog authentication metadata representation. */
export const CONNECTOR_AUTH_SETUP_VERSION = '1';

/** Authentication presentation only: never account authority or credential fields. */
export const ConnectorAuthenticationSetupSchema = z
  .object({
    kind: z.enum(['oauth', 'fields', 'none', 'unsupported']),
    source: z.enum(['configured', 'managed', 'account-fields', 'unsupported']),
    scheme: z.string().min(1).max(100).optional(),
    requiresAccountFields: z.boolean(),
  })
  .strict();
/** Authentication presentation only; field descriptors stay on the hosted owner surface. */
export type ConnectorAuthenticationSetup = z.infer<typeof ConnectorAuthenticationSetupSchema>;

/** Project one toolkit for negotiated clients or the unchanged strict legacy wire. */
export function projectConnectorAuthentication<
  T extends {
    authKind: 'oauth2' | 'api-key' | 'none';
    authentication?: ConnectorCapabilityAvailability;
    authenticationSetup?: ConnectorAuthenticationSetup;
  },
>(toolkit: T, includeSetup: boolean): T {
  const { authenticationSetup: setup, ...legacy } = toolkit;
  if (!setup) return toolkit;
  const authKind = setup.kind === 'oauth' ? 'oauth2' : setup.kind === 'fields' ? 'api-key' : 'none';
  if (includeSetup) return { ...toolkit, authKind };
  const needsUpgrade =
    setup.kind === 'unsupported' || (setup.kind === 'fields' && setup.scheme !== 'API_KEY');
  return {
    ...legacy,
    authKind,
    ...(needsUpgrade && (!toolkit.authentication || toolkit.authentication.status === 'available')
      ? {
          authentication: {
            status: 'unsupported',
            reason: 'Update DorkOS to use this service’s sign-in method.',
          },
        }
      : {}),
  } as T;
}
