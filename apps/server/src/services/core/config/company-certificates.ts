/**
 * Company certificates, as Settings shows them (DOR-3361).
 *
 * The desktop app's server process adds the certificate bundle a person named
 * in `network.extraCaCertsPath` to the trust store before this server loads
 * (`apps/desktop/src/extra-ca-certs.ts`), and leaves what happened on a
 * process global. This module reads it back for `GET /api/config`, so the
 * count Settings shows is the one actually loaded, not a fresh read of a file
 * that may have changed since.
 *
 * Outside the desktop app nothing loads the bundle, and the status is `null`:
 * Settings then has nothing true to say and shows no row.
 *
 * @module services/core/config/company-certificates
 */
import {
  CompanyCertificatesStatusSchema,
  type CompanyCertificatesStatus,
} from '@dorkos/shared/schemas';
import { env } from '../../../env.js';
import { configManager } from '../config-manager.js';

/**
 * Where the desktop entry leaves its result, inside the same process. A global
 * rather than an import because the desktop bundles the server separately.
 * Mirrors `COMPANY_CERTIFICATES_STATUS` in `apps/desktop/src/extra-ca-certs.ts`.
 */
export const COMPANY_CERTIFICATES_STATUS = Symbol.for('dorkos.desktop.companyCertificates');

/**
 * What the desktop app loaded at start-up, or `null` when the desktop app does
 * not run this server, or left nothing readable.
 */
export function readCompanyCertificatesStatus(): CompanyCertificatesStatus | null {
  if (env.DORKOS_MANAGED_BY !== 'desktop') return null;
  const recorded = (globalThis as Record<symbol, unknown>)[COMPANY_CERTIFICATES_STATUS];
  const parsed = CompanyCertificatesStatusSchema.safeParse(recorded);
  return parsed.success ? parsed.data : null;
}

/** The `network` block of `GET /api/config`: the setting and what loaded. */
export function describeCompanyCertificates(): {
  extraCaCertsPath: string | null;
  companyCertificates: CompanyCertificatesStatus | null;
} {
  return {
    extraCaCertsPath: configManager.get('network')?.extraCaCertsPath ?? null,
    companyCertificates: readCompanyCertificatesStatus(),
  };
}
