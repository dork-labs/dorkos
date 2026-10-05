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
  ExtensionToolDeclarationSchema,
  ExtensionSkillDeclarationSchema,
  EXTENSION_TOOL_TIMEOUT_MAX_SECONDS,
  EXTENSION_TOOL_TIMEOUT_DEFAULT_SECONDS,
  WORKER_RUNTIME_REFUSAL,
  ALLOW_NEEDS_SUBPROCESS,
  EXTERNAL_HOSTS_NEED_ALLOW_NET,
  NO_SERVER_CODE_TO_ISOLATE,
  ALLOW_NET_MAX,
  ALLOW_RUN_MAX,
  ISOLATION_MEMORY_MB,
} from './manifest-schema.js';
export {
  parseNetEntry,
  isNetEntryError,
  formatNetEntry,
  matchesNetEntry,
  isNetEntryCovered,
  NET_ENTRY_JUST_HOST,
  NET_ENTRY_LOCAL_NEEDS_PORT,
} from './net-allowlist.js';
export type { ParsedNetEntry, NetEntryError, NetEntryKind } from './net-allowlist.js';
export {
  runEntryProblem,
  isAbsoluteProgramPath,
  RUN_ENTRY_ONE_PROGRAM,
  RUN_PROGRAM_NOT_FOUND,
} from './run-allowlist.js';
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
  ExtensionToolDeclaration,
  IsolationRuntime,
  ExtensionAllow,
  ExtensionLimits,
} from './manifest-schema.js';
export type {
  ExtensionAPI,
  ExtensionDialogControls,
  ExtensionDialogProps,
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
  ExtensionToolCheckSummary,
  ExtensionToolStatus,
  ExtensionIsolation,
  ExtensionResolvedProgram,
  ExtensionSkillStatus,
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
export type { ToolsApi, ExtensionToolHandler, ExtensionToolCall } from './extension-tools.js';
