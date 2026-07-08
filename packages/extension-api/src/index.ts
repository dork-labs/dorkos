/**
 * Extension API — public contract for DorkOS extensions.
 *
 * Extension authors type against this package. The host provides the implementation.
 *
 * @module @dorkos/extension-api
 */
export {
  ExtensionManifestSchema,
  SettingOptionSchema,
  SettingDeclarationSchema,
} from './manifest-schema.js';
export type {
  ExtensionManifest,
  SecretDeclaration,
  SettingOption,
  SettingDeclaration,
  DataProxyConfig,
  ServerCapabilities,
  ExtensionCapabilities,
} from './manifest-schema.js';
export type { ExtensionAPI, ExtensionPointId, ExtensionReadableState } from './extension-api.js';
export {
  EXTENSION_EVENT_KINDS,
  EXTENSION_EVENT_CATEGORIES,
  EXTENSION_EVENT_DECLARATIONS,
  extensionEventCategory,
  isExtensionEventDeclared,
} from './extension-events.js';
export type {
  ExtensionEvent,
  ExtensionEventKind,
  ExtensionEventCategory,
  ExtensionEventDeclaration,
  ExtensionEventsAPI,
  ExtensionSessionStartedEvent,
  ExtensionSessionEndedEvent,
  ExtensionSessionSwitchedEvent,
  ExtensionTurnStartedEvent,
  ExtensionTurnCompletedEvent,
  ExtensionToolActivityEvent,
  ExtensionRelayMessageEvent,
} from './extension-events.js';
export type {
  ExtensionStatus,
  ExtensionRecord,
  ExtensionRecordPublic,
  ExtensionModule,
} from './types.js';
export type {
  SecretStore,
  SettingsStore,
  DataProviderContext,
  ServerExtensionRegister,
} from './server-extension-api.js';
