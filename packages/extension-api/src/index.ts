/**
 * Extension API — public contract for DorkOS extensions.
 *
 * Extension authors type against this package. The host provides the implementation.
 *
 * @module @dorkos/extension-api
 */
export {
  EXTENSION_ID_REGEX,
  ExtensionManifestSchema,
  SettingOptionSchema,
  SettingDeclarationSchema,
  StorageMigrationSchema,
  StorageDeclarationSchema,
} from './manifest-schema.js';
export type {
  ExtensionManifest,
  SecretDeclaration,
  SettingOption,
  SettingDeclaration,
  DataProxyConfig,
  ServerCapabilities,
  ExtensionCapabilities,
  StorageMigration,
  StorageDeclaration,
} from './manifest-schema.js';
export type {
  ExtensionAPI,
  ExtensionPointId,
  ExtensionReadableState,
  ExtensionPageProps,
  ExtensionPageOptions,
  ProjectRef,
  StatusBarItemOptions,
  StatusBarSlotContext,
  TrackerItemRef,
  DecisionActions,
  DecisionAnswer,
  DecisionAnswerResult,
  ExtensionDecisionView,
} from './extension-api.js';
export type { StartWorkInput } from './start-work.js';
export { StartWorkError } from './start-work.js';
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
  ExtensionOrigin,
} from './types.js';
export type {
  SecretStore,
  SettingsStore,
  DataProviderContext,
  ServerExtensionRegister,
  AccountsApi,
  AccountSummary,
  AccountUsage,
  AccountAdvisor,
  AccountCandidate,
  AdvisorContext,
  AdvisorRanking,
  SessionInfo,
  LimitedSessionInfo,
  ProjectInfo,
  ProjectsApi,
  LimitedPlan,
  CarryOverSeed,
  InboxApi,
  InboxLimit,
  DecisionInput,
  RaisedDecision,
  DecisionOutcome,
  DecisionActor,
  DecisionActionEvent,
  DecisionActionResult,
  DecisionOffer,
  DecisionWatch,
  RecordedDecisionInput,
  ProjectSettingsReader,
  SessionsApi,
} from './server-extension-api.js';
