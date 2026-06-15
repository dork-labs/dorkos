/**
 * @dorkos/flow — the `/flow` engine's typed core.
 *
 * Home of the authoritative Zod config schema for `.agents/flow/config.json`
 * and the JSON Schema bridge that generates `.agents/flow/config.schema.json`.
 * Downstream engine code (calibration ladder, dispatch policy, gates,
 * ownership classification, recovery) imports the relevant sub-schemas and the
 * inferred {@link FlowConfig} type from here.
 *
 * @module @dorkos/flow
 */

export {
  FlowConfigSchema,
  TrackerSchema,
  IdentitySchema,
  OwnershipSchema,
  OwnershipScopeSchema,
  CommentsSchema,
  RespondWhenSchema,
  AmbiguousBiasSchema,
  StageSchema,
  StagesSchema,
  StateCategorySchema,
  AutonomySchema,
  AutonomyDefaultSchema,
  ConcurrencySchema,
  SeatSchema,
  WipCapSchema,
  InvolvementSchema,
  CommsSchema,
  CalibrationSchema,
  ProceedSilentlyWhenSchema,
  AlwaysAskSchema,
  StageBiasSchema,
  StageBiasValueSchema,
  AssumptionLogSchema,
  TicketCommentSchema,
  NudgeSchema,
  DispatchSchema,
  DispatchRankSchema,
  SizeOrderSchema,
  GatesSchema,
  ReviewGateSchema,
  OnConflictSchema,
  CircuitBreakerSchema,
  ContextSchema,
  PerIssueSchema,
  PerStageSchema,
  StageBudgetsSchema,
  WorkspaceSchema,
  IsolationSchema,
  WorkspaceFlowSchema,
  RecoverySchema,
  OnExhaustedSchema,
  DecompositionSchema,
  DecompositionModeSchema,
  SubIssueThresholdSchema,
  EvidenceSchema,
  EvidenceUiSchema,
  EvidenceTemporalSchema,
  EvidenceLogicSchema,
  EvidenceAttachToSchema,
} from './config-schema.js';
export type { FlowConfig, Stage } from './config-schema.js';

export { CONFIG_SCHEMA_RELATIVE_PATH, buildConfigJsonSchema } from './generate-config-schema.js';

export {
  TasksFileSchema,
  TaskSchema,
  TaskSizeSchema,
  TaskPrioritySchema,
  ProvenanceSchema,
  ProvenanceTrackerSchema,
  CANONICAL_SIZE_ORDER,
  normalizeSize,
  isPromotableToSubIssue,
} from './tasks-schema.js';
export type { TasksFile, Task, TaskSize, CanonicalSize, Provenance } from './tasks-schema.js';

// Work model — the normalized WorkItem the adapter produces and the engine consumes.
export type {
  WorkItem,
  WorkItemProject,
  WorkItemRelations,
  OwnershipClass,
  WorkItemType,
  WorkItemPriority,
  AgentDisposition,
  StateCategory,
} from './work-item.js';

// Calibration ladder (§5) — uncertainty-gated involvement.
export { resolveInvolvement, CalibrationRow } from './calibration.js';
export type {
  Calibration,
  FloorTrigger,
  Reversibility,
  Confidence,
  DecisionStage,
  InvolvementBehavior,
  DecisionDescriptor,
  InvolvementDecision,
} from './calibration.js';

// Dispatch policy (§4) — eligibility filter + 7-tier ranking ladder.
export { selectDispatch, filterEligible, rankEligible, isClaimable } from './dispatch.js';
export type {
  DispatchOptions,
  DispatchConfig,
  OwnershipConfig,
  WipCap,
  RankFactor,
} from './dispatch.js';

// Gates (§5) + auto-merge recovery ladder (§6) — config-driven loop control.
export { planApprovalRequired, tripsCircuitBreaker, evaluateAutoMerge } from './gates.js';
export type {
  GatesConfig,
  ReviewGateConfig,
  CircuitBreakerConfig,
  MergeableState,
  CiState,
  MergeState,
  MergeDispositionKind,
  MergeDisposition,
  UnitUsage,
  CircuitBreakerTrip,
} from './gates.js';

// Comms routing (§5) — infer the human-contact channel from the trigger.
export { resolveCommsChannel } from './comms.js';
export type {
  InvolvementConfig,
  NudgeConfig,
  CommsChannel,
  CommsTrigger,
  CommsRoute,
} from './comms.js';

// Comment-response rules (§5) — reading the comms channel back.
export { shouldRespondToComment } from './comment-response.js';
export type {
  CommentsConfig,
  InboxComment,
  CommentIdentity,
  CommentDecisionContext,
  CommentAction,
  CommentDecision,
} from './comment-response.js';
