/** Server construction entry point; no origin mint or existing-bus attach is exported. */
export { RelayCore, consumeServerDocumentRelayOrigin } from './relay-core.js';
export type { ServerDocumentRelayOrigin, ServerDocumentRelayAccess } from './document-delivery.js';

export {
  ClaudeCodeAdapter,
  consumeInstalledDocumentAdapterOrigin,
  readOriginalInstalledDocumentAdapterOrigin,
} from './adapters/claude-code/claude-code-adapter.js';
export type {
  InstalledDocumentAdapterOrigin,
  InstalledDocumentAdapterSource,
} from './document-delivery.js';

export type { OriginalDocumentProcessReservation } from './document-process-custody.js';
