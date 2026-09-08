/**
 * External connector SDK adapters shared by DorkOS runtimes and hosted services.
 *
 * @module connector-providers
 */
export * from './composio/index.js';
export {
  ConnectorEventPayloadProtector,
  normalizeConnectorEventContent,
  type ConnectorEventPayloadScope,
  type ConnectorEventPayloadKeys,
} from './event-content.js';
