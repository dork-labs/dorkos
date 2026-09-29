import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';

/**
 * What a caller knows about an app's logo: the catalog's same-origin path;
 * `null` when the catalog lists the app and says it has no logo; `undefined`
 * when the caller has no catalog entry for the app at all.
 */
export type ServiceLogo = string | null | undefined;

/**
 * The {@link ServiceLogo} a catalog entry gives, keeping "listed without a
 * logo" (`null`) apart from "not listed" (`undefined`).
 *
 * @param service - The app's catalog entry, when the caller has one.
 */
export function serviceLogo(service: ConnectorCatalogService | null | undefined): ServiceLogo {
  if (!service) return undefined;
  return service.logo ?? null;
}
