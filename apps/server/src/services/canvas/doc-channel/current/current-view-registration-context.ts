import type { OriginalEngineCoreProjectionFacet } from './projection/current-core-projection-context.js';
import type { createIsolatedEngineFacetCustody } from './current-isolated-facet-custody.js';
import type { createIsolatedCurrentTokenCustody } from './current-isolated-token-custody.js';
import type { DocChannelGrants } from '../grants.js';
import type { DocChannelStore } from '../store.js';
import type { DocChannelTokenStore } from '../tokens/token-store.js';

/** Only the actual private constructor can obtain these original registration closures. */
export interface OriginalEngineViewRegistrationFacet extends OriginalEngineCoreProjectionFacet {
  readonly custody: ReturnType<typeof createIsolatedEngineFacetCustody>;
  readonly tokenCustody: ReturnType<typeof createIsolatedCurrentTokenCustody>;
  readonly freeze: typeof Object.freeze;
  readonly tokenStreamDelay: typeof setTimeout;
  readonly tokenStreamCancel: typeof clearTimeout;
  readonly MaintenanceDate: typeof Date;
  readonly maintenanceNow: typeof Date.now;
  readonly maintenanceParse: typeof Date.parse;
  readonly maintenanceIso: typeof Date.prototype.toISOString;
  readonly tokenScalarJson: typeof JSON.stringify;
  readonly tokenOwnDescriptor: typeof Object.getOwnPropertyDescriptor;
  readonly tokenOwnKeys: typeof Object.keys;
  readonly tokenUtf8Bytes: typeof Buffer.byteLength;
  readonly retainTokenManifestOwner: (grants: DocChannelGrants, store: DocChannelStore) => void;
  readonly originalTokenStore: () => DocChannelTokenStore;
  readonly schedulePresence: () => void;
}
