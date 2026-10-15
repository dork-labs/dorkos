import type { Db } from '@dorkos/db';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import type {
  consumeServerNativeRelayConstruction,
  ServerNativeRelayConstruction,
} from '@dorkos/db/internal-server';
import type {
  consumeServerDocumentRelayOrigin,
  consumeInstalledDocumentAdapterOrigin,
} from '@dorkos/relay/server-private-document';
import type { requireOriginalDocumentRelayStore, requireOriginalDocGrantStore } from '../store.js';
import type { requireOriginalDocumentRelayGrants } from '../grant-revalidation.js';
import type { currentRoomDueServicePort } from '../service.js';
import type { createIsolatedRelaySourceCustody } from './relay-source-custody.js';
/** Fixed original installation bindings and live private wake state. */
export interface OriginalRelayPreparationView {
  access: ReturnType<typeof consumeServerDocumentRelayOrigin>;
  originalStore: ReturnType<typeof requireOriginalDocumentRelayStore>;
  originalGrants: ReturnType<typeof requireOriginalDocumentRelayGrants>;
  originalGrantStore: ReturnType<typeof requireOriginalDocGrantStore> | undefined;
  roomDue: ReturnType<typeof currentRoomDueServicePort> | undefined;
  nativePrincipals: ConnectorRuntimePrincipalPort | undefined;
  ownDb: Db | undefined;
  serverNativeRelayConstruction: ServerNativeRelayConstruction | undefined;
  adapter: ReturnType<typeof consumeInstalledDocumentAdapterOrigin> | undefined;
  native: ReturnType<typeof consumeServerNativeRelayConstruction> | undefined;
  originalRelaySources: ReturnType<typeof createIsolatedRelaySourceCustody>['originalRelaySources'];
  readonly stopped: boolean;
  wakeFailed: boolean;
  firstWakeCause: unknown;
  pendingWakes: Set<Promise<readonly string[]>>;
  rememberSinkFailure: (cause: unknown) => void;
}
/** Original identifier-only Room correlation DATA. */
export type RoomWakeIdentity = {
  documentId: string;
  openerAgentId?: string;
  targetAgentId?: string;
};
