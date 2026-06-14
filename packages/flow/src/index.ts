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
