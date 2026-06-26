/**
 * Zod schema for `.agents/flow/config.json` — the authoritative source of truth
 * for the `/flow` engine's runtime configuration.
 *
 * This schema is the single home that downstream engine code (calibration
 * ladder, dispatch policy, gates, ownership classification, recovery) imports
 * from and extends. The `config.schema.json` JSON Schema artifact at
 * `.agents/flow/config.json`'s `$schema` target is GENERATED from this module
 * via `z.toJSONSchema` (the `conf` precedent — mirrors
 * `apps/server/src/services/core/config-manager.ts`). Never hand-edit the
 * generated artifact; run `pnpm --filter @dorkos/flow generate:schema`.
 *
 * Every field carries its §9 resolved default so that `FlowConfigSchema.parse({})`
 * yields the fully-resolved config the engine runs on.
 *
 * @see specs/unified-workflow-system/02-specification.md §9
 * @module @dorkos/flow/config-schema
 */

import { z } from 'zod';

/** Supported project trackers. Only Linear is wired in v1 (§3). */
export const TrackerSchema = z.enum(['linear']);

/**
 * Agent identity & authorship marker (§7). No personal identity ships in the
 * package — `agent: "auto"` and `reviewer: null` are resolved at runtime from
 * the installer's account; the marker is the durable authorship signal.
 */
export const IdentitySchema = z
  .object({
    /** Agent account resolution. `"auto"` resolves from the runtime account. */
    agent: z.string().default('auto'),
    /** Reviewer account, or `null` to resolve at runtime. */
    reviewer: z.string().nullable().default(null),
    /** Comment/authorship marker appended to tracker writes. */
    marker: z.string().default('— 🤖 /flow'),
  })
  .prefault({});

/** Ownership scopes the engine may claim work within (§7). */
export const OwnershipScopeSchema = z.enum(['issues', 'projects']);

/**
 * Ownership claim policy (§7) — governs which work items the agent may claim
 * based on assignment, feeding `classifyOwnership` (task 3.1).
 */
export const OwnershipSchema = z
  .object({
    /** Claim items already assigned to the agent account. */
    claimAssignedToAgent: z.boolean().default(true),
    /** Claim unassigned items. */
    claimUnassigned: z.boolean().default(true),
    /** Claim items assigned to a human (off by default). */
    claimAssignedToHuman: z.boolean().default(false),
    /** Claim items assigned to other agents (off by default). */
    claimAssignedToOthers: z.boolean().default(false),
    /** Scopes the claim policy applies to. */
    scope: z.array(OwnershipScopeSchema).default(['issues', 'projects']),
  })
  .prefault({});

/** When the agent should respond to tracker comments (§5). */
export const RespondWhenSchema = z.enum(['addressed', 'always', 'never']);
/** Bias when a comment's intent is ambiguous (§5). */
export const AmbiguousBiasSchema = z.enum(['quiet', 'engage']);

/** Comment-engagement policy (§5). */
export const CommentsSchema = z
  .object({
    /** Trigger condition for responding to comments. */
    respondWhen: RespondWhenSchema.default('addressed'),
    /** Default behavior when comment intent is ambiguous. */
    ambiguousBias: AmbiguousBiasSchema.default('quiet'),
  })
  .prefault({});

/** Tracker state category a stage projects onto (§1, §8). */
export const StateCategorySchema = z.enum([
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
]);

/**
 * A single stage in the spine (§1). Carries the slash command that drives it,
 * its durable `stage/*` label, and optional projection metadata. The `review`
 * stage is the human gate and intentionally has NO command.
 */
export const StageSchema = z.object({
  /** Slash command that drives the stage. Absent for the human-gate `review`. */
  command: z.string().optional(),
  /** Durable `stage/*` label projected onto the work item. */
  label: z.string().optional(),
  /** Tracker state category this stage projects onto, if any. */
  stateCategory: StateCategorySchema.optional(),
  /** Whether this stage is a human-approval gate. */
  humanGate: z.boolean().optional(),
});

/**
 * The full stage spine (§1). Defaults bake in the §9 resolved stage set:
 * `execute`/`verify` carry `stateCategory: "started"`; `review` carries
 * `{ stateCategory: "started", humanGate: true }` and no command; `done`
 * carries `stateCategory: "completed"`.
 */
export const StagesSchema = z
  .object({
    capture: StageSchema.default({ command: '/flow:capture', label: 'stage/capture' }),
    triage: StageSchema.default({ command: '/flow:triage', label: 'stage/triage' }),
    ideate: StageSchema.default({ command: '/flow:ideate', label: 'stage/ideate' }),
    specify: StageSchema.default({ command: '/flow:specify', label: 'stage/specify' }),
    decompose: StageSchema.default({ command: '/flow:decompose', label: 'stage/decompose' }),
    execute: StageSchema.default({
      command: '/flow:execute',
      label: 'stage/execute',
      stateCategory: 'started',
    }),
    verify: StageSchema.default({
      command: '/flow:verify',
      label: 'stage/verify',
      stateCategory: 'started',
    }),
    review: StageSchema.default({ stateCategory: 'started', humanGate: true }),
    done: StageSchema.default({
      command: '/flow:done',
      label: 'stage/done',
      stateCategory: 'completed',
    }),
  })
  .prefault({});

/** Default autonomy posture (§7.3). */
export const AutonomyDefaultSchema = z.enum(['auto', 'manual']);
/** Concurrency model for the autonomous loop (§7.3). */
export const ConcurrencySchema = z.enum(['sequential', 'parallel']);
/**
 * Where the autonomous loop is seated (§10) — the host that fires each tick.
 *
 * v1 ships one seat, `pulse` (the DorkOS Pulse croner). A generic
 * `claude -p`-per-issue `watcher` seat for non-DorkOS repos is a documented
 * future seat (SPEC §10 / the flow README), deliberately **not** offered as a
 * selectable value until it is implemented: an enum value the engine cannot
 * honor would silently no-op the loop. Re-add `'watcher'` here when that seat
 * ships.
 */
export const SeatSchema = z.enum(['pulse']);

/** Work-in-progress caps (§7.3). */
export const WipCapSchema = z
  .object({
    /** Global concurrent-work cap across all projects. */
    global: z.number().int().nonnegative().default(2),
    /** Per-project concurrent-work cap. */
    perProject: z.number().int().nonnegative().default(1),
  })
  .prefault({});

/** Autonomy & concurrency posture (§7.3, §10). */
export const AutonomySchema = z
  .object({
    /** Default autonomy posture. */
    default: AutonomyDefaultSchema.default('auto'),
    /** Concurrency model for the loop. */
    concurrency: ConcurrencySchema.default('sequential'),
    /** Work-in-progress caps. */
    wipCap: WipCapSchema,
    /** Seat for the autonomous poller (Pulse in v1). */
    seat: SeatSchema.default('pulse'),
  })
  .prefault({});

/** How comms tone is chosen (§5). */
export const CommsSchema = z.enum(['infer-from-trigger', 'concise', 'verbose']);
/** Calibration-ladder condition tags that permit silent progress (§5). */
export const ProceedSilentlyWhenSchema = z.enum(['reversible', 'confident']);
/** Calibration-ladder condition tags that always force a stop-and-ask (§5). */
export const AlwaysAskSchema = z.enum([
  'irreversible-or-destructive',
  'outward-facing',
  'secrets-or-spend',
  'scope-change',
]);
/** Per-stage involvement bias values (§5). */
export const StageBiasValueSchema = z.enum(['ask', 'proceed-and-log']);
/** Where assumptions get logged on the ticket (§5, §8). */
export const TicketCommentSchema = z.enum(['pm-driven', 'always', 'never']);

/** Per-stage involvement bias (§5). */
export const StageBiasSchema = z
  .object({
    /** Bias during intake stages (capture/triage/ideate). */
    intake: StageBiasValueSchema.default('ask'),
    /** Bias during execution stages (execute/verify). */
    execution: StageBiasValueSchema.default('proceed-and-log'),
  })
  .prefault({});

/** How assumptions are recorded (§5, §8). */
export const AssumptionLogSchema = z
  .object({
    /** Whether to write a durable assumption-log artifact. */
    artifact: z.boolean().default(true),
    /** Whether/how to mirror assumptions onto the ticket. */
    ticketComment: TicketCommentSchema.default('pm-driven'),
  })
  .prefault({});

/** The calibration ladder (§5) — the single most important involvement behavior. */
export const CalibrationSchema = z
  .object({
    /** Condition tags under which the agent proceeds silently. */
    proceedSilentlyWhen: z.array(ProceedSilentlyWhenSchema).default(['reversible', 'confident']),
    /** Condition tags that always force a stop-and-ask (ladder floor). */
    alwaysAsk: z
      .array(AlwaysAskSchema)
      .default([
        'irreversible-or-destructive',
        'outward-facing',
        'secrets-or-spend',
        'scope-change',
      ]),
    /** Per-stage involvement bias. */
    stageBias: StageBiasSchema,
    /** Assumption-logging policy. */
    assumptionLog: AssumptionLogSchema,
  })
  .prefault({});

/**
 * Out-of-band nudge channels (§5). A courtesy ping alongside `interactive` /
 * `comment-and-assign`, but **promoted to the primary attention channel** on the
 * `comment-and-nudge` route (unattended + shared-account mode), where the tracker
 * assignment notifies no one because agent and human share the account — see
 * `comms.ts` `resolveCommsChannel` and `CommsRoute.nudgePrimary`. The structural
 * shape is unchanged (the `relay` / `telegram` booleans); only the *role* of the
 * nudge shifts by route.
 */
export const NudgeSchema = z
  .object({
    /** Nudge via the DorkOS relay bus. */
    relay: z.boolean().default(false),
    /** Nudge via Telegram. */
    telegram: z.boolean().default(false),
  })
  .prefault({});

/** Human-involvement policy (§5) — comms, calibration ladder, and nudges. */
export const InvolvementSchema = z
  .object({
    /** How comms tone is chosen. */
    comms: CommsSchema.default('infer-from-trigger'),
    /** The calibration ladder. */
    calibration: CalibrationSchema,
    /** Out-of-band nudge channels. */
    nudge: NudgeSchema,
  })
  .prefault({});

/** Dispatch ranking factors, ordered by precedence (§4). */
export const DispatchRankSchema = z.enum([
  'unblockers',
  'priority',
  'projectStatus',
  'type',
  'size',
  'age',
]);
/** Tie-break order by work-item size (§4). */
export const SizeOrderSchema = z.enum(['small-first', 'large-first']);

/** Dispatch policy — what to work on next (§4). */
export const DispatchSchema = z
  .object({
    /** Ranking factors in precedence order. */
    rank: z
      .array(DispatchRankSchema)
      .default(['unblockers', 'priority', 'projectStatus', 'type', 'size', 'age']),
    /** Size tie-break order. */
    sizeOrder: SizeOrderSchema.default('small-first'),
  })
  .prefault({});

/** Conflict-resolution policy for auto-merge (§6). */
export const OnConflictSchema = z.enum(['resolve-if-mechanical', 'always-bounce', 'never-resolve']);

/** Auto-merge / review-gate policy (§6). */
export const ReviewGateSchema = z
  .object({
    /** Merge automatically once a human approves. */
    mergeOnApproval: z.boolean().default(true),
    /** Require CI green before merging. */
    requireCiGreen: z.boolean().default(true),
    /** Tear down the worktree after merge. */
    teardownWorktree: z.boolean().default(true),
    /** How to handle merge conflicts. */
    onConflict: OnConflictSchema.default('resolve-if-mechanical'),
    /** Number of CI retries before bouncing. */
    ciRetries: z.number().int().nonnegative().default(1),
    /** Re-request approval when a functional change lands post-approval. */
    reapproveOnFunctionalChange: z.boolean().default(true),
    /** Maximum merge attempts before escalating. */
    maxMergeAttempts: z.number().int().positive().default(3),
  })
  .prefault({});

/** Circuit-breaker thresholds (§6). */
export const CircuitBreakerSchema = z
  .object({
    /** Bail when actual effort exceeds estimate by this multiple. */
    estimateMultiplier: z.number().positive().default(2),
    /** Per-issue token budget ceiling. */
    tokenBudget: z.number().int().positive().default(2_000_000),
  })
  .prefault({});

/** Gates — plan approval, review/auto-merge, and circuit breakers (§6, §7.4). */
export const GatesSchema = z
  .object({
    /** Require plan approval before EXECUTE (off by default — §7.4). */
    planApproval: z.boolean().default(false),
    /** Auto-merge / review-gate policy. */
    review: ReviewGateSchema,
    /** Circuit-breaker thresholds. */
    circuitBreaker: CircuitBreakerSchema,
  })
  .prefault({});

/** Context lifetime per issue (§7.7). */
export const PerIssueSchema = z.enum(['fresh-session', 'shared-session']);
/** Context lifetime per stage (§7.7). */
export const PerStageSchema = z.enum(['fresh-subagent', 'shared-subagent']);

/** Per-stage context-window budgets in tokens (§11). */
export const StageBudgetsSchema = z
  .object({
    /** SPECIFY stage budget. */
    specify: z.number().int().positive().default(40_000),
    /** DECOMPOSE stage budget. */
    decompose: z.number().int().positive().default(40_000),
    /** EXECUTE stage budget. */
    execute: z.number().int().positive().default(80_000),
    /** VERIFY stage budget. */
    verify: z.number().int().positive().default(40_000),
    /** REVIEW stage budget. */
    review: z.number().int().positive().default(30_000),
  })
  .prefault({});

/** Context strategy — session/subagent lifetime, compaction, externalization (§11). */
export const ContextSchema = z
  .object({
    /** Context lifetime per issue. */
    perIssue: PerIssueSchema.default('fresh-session'),
    /** Context lifetime per stage. */
    perStage: PerStageSchema.default('fresh-subagent'),
    /** Fraction of the window that triggers compaction. */
    compactionTrigger: z.number().min(0).max(1).default(0.65),
    /** Per-stage token budgets. */
    stageBudgets: StageBudgetsSchema,
    /** Durable artifacts the engine externalizes context into. */
    externalize: z
      .array(z.string())
      .default(['flow-state.json', 'execution.log.jsonl', 'flow-history.tsv']),
  })
  .prefault({});

/** Workspace isolation strategy (§5.9, §14). */
export const IsolationSchema = z.enum(['worktree', 'none']);
/** Worktree management flow (§5.9). */
export const WorkspaceFlowSchema = z.enum(['gtr', 'manual']);

/** Workspace provisioning policy (§5.9, §14). */
export const WorkspaceSchema = z
  .object({
    /** Isolation strategy for per-issue work. */
    isolation: IsolationSchema.default('worktree'),
    /** Worktree management tool/flow. */
    flow: WorkspaceFlowSchema.default('gtr'),
    /** Tear down the worktree automatically on close. */
    autoTeardown: z.boolean().default(true),
  })
  .prefault({});

/** What to do when retries are exhausted (§12). */
export const OnExhaustedSchema = z.enum(['block', 'escalate', 'abandon']);

/** Crash & stall recovery policy (§12). */
export const RecoverySchema = z
  .object({
    /** Maximum retry attempts per stage. */
    maxRetries: z.number().int().nonnegative().default(2),
    /** Action when retries are exhausted. */
    onExhausted: OnExhaustedSchema.default('block'),
    /** Duration after which a run is considered stale. */
    staleAfter: z.string().default('5m'),
  })
  .prefault({});

/** Task-decomposition mode (§8, §7.6). */
export const DecompositionModeSchema = z.enum(['hybrid', 'always', 'never']);
/** Size threshold at/above which a task promotes to a sub-issue (§7.6). */
export const SubIssueThresholdSchema = z.enum(['xs', 'sm', 'md', 'lg', 'xl']);

/** Task decomposition policy (§8, §7.6). */
export const DecompositionSchema = z
  .object({
    /** Decomposition strategy. */
    mode: DecompositionModeSchema.default('hybrid'),
    /** Size at/above which tasks promote to sub-issues. */
    subIssueThreshold: SubIssueThresholdSchema.default('xl'),
  })
  .prefault({});

/** UI proof-of-completion mode (§13). */
export const EvidenceUiSchema = z.enum(['auto', 'screenshot', 'off']);
/** Temporal (motion) proof mode (§13). */
export const EvidenceTemporalSchema = z.enum(['video', 'gif', 'off']);
/** Logic proof mode (§13). */
export const EvidenceLogicSchema = z.enum(['test-summary', 'full-output', 'off']);
/** Where the evidence bundle is attached (§13). */
export const EvidenceAttachToSchema = z.enum(['pr', 'tracker']);

/** Browser proof-of-completion policy (§13). */
export const EvidenceSchema = z
  .object({
    /** UI proof mode. */
    ui: EvidenceUiSchema.default('auto'),
    /** Temporal (motion) proof mode. */
    temporal: EvidenceTemporalSchema.default('video'),
    /** Logic proof mode. */
    logic: EvidenceLogicSchema.default('test-summary'),
    /** Where the evidence bundle attaches. */
    attachTo: z.array(EvidenceAttachToSchema).default(['pr', 'tracker']),
  })
  .prefault({});

/**
 * Per-reconciler control knobs (§3) — the canonical mirror of the
 * `ReconcilerConfig` interface (`reconciler.ts`, task 2.1). `priority` orders the
 * tick and resolves same-item contention (**lower runs first / lower wins**);
 * `intervalMs` is the cadence floor; `enabled: false` skips the loop entirely.
 *
 * This base shape leaves `priority`/`intervalMs` required (each loop's calibrated
 * value is supplied by {@link loopConfig}). It documents the contract; the per-loop
 * variants in {@link LoopsSchema} are what `config.json` is parsed against.
 */
export const ReconcilerConfigSchema = z.object({
  /** Whether the loop runs at all. */
  enabled: z.boolean().default(true),
  /** Tick ordering + contention precedence — lower runs first and lower wins. */
  priority: z.number().int(),
  /** Cadence floor between runs, in milliseconds. */
  intervalMs: z.number().int().positive(),
});

/**
 * Build a per-loop config schema from {@link ReconcilerConfigSchema} with this
 * loop's calibrated `priority`/`intervalMs` baked in as field defaults. The
 * `.prefault({})` lets a missing entry resolve to the full calibrated default,
 * and — crucially — the field defaults let a PARTIAL edit in `config.json`
 * (e.g. just `{ "enabled": false }`, task 5.2) resolve to the full calibrated
 * entry without re-stating the priority/cadence.
 *
 * @param priority - The loop's tick-order / contention precedence default.
 * @param intervalMs - The loop's cadence-floor default, in milliseconds.
 * @returns A reconciler-config schema defaulting to this loop's calibration.
 */
function loopConfig(priority: number, intervalMs: number) {
  return ReconcilerConfigSchema.extend({
    priority: z.number().int().default(priority),
    intervalMs: z.number().int().positive().default(intervalMs),
  }).prefault({});
}

/**
 * The `loops` config block (§3) — the reconciler registry's extension seam,
 * keyed by reconciler id. Each entry resolves to its calibrated default
 * (priority + cadence); add a loop = register it here, disable one =
 * `enabled: false`, reorder = change `priority`.
 *
 * Resolved priority ladder (lower = earlier + contention winner):
 * `recovery 10 < inbox 20 < review 25 < dispatch 30 < triage 40 < hygiene 50`.
 * Recovery re-adopts orphans first; inbox/resume un-parks answered questions
 * before new claims; review clears completed PRs so a finished item leaves the
 * gate before dispatch claims a fresh one; triage readies backlog; hygiene
 * (slowest cadence) surfaces starvation. Cadence is fast for inbox (1m) and slow
 * for hygiene (6h).
 */
export const LoopsSchema = z
  .object({
    /** Re-adopt orphaned claimed work (head of the tick). */
    recovery: loopConfig(10, 300_000),
    /** Drain the inbox / resume parked `agent/needs-input` items (fast cadence). */
    inbox: loopConfig(20, 60_000),
    /** Clear approved PRs at the human-review gate. */
    review: loopConfig(25, 300_000),
    /** Claim the top-ranked ready item. */
    dispatch: loopConfig(30, 300_000),
    /** Ready shapeable backlog that lacks `agent/ready`. */
    triage: loopConfig(40, 3_600_000),
    /** Surface starvation + keep the queue honest (slowest cadence). */
    hygiene: loopConfig(50, 21_600_000),
  })
  .prefault({});

/** Inbound-event producer (§4). `poll` is the v1 default; `webhook` is deferred. */
export const ProducerSchema = z.enum(['poll', 'webhook']);

/**
 * Inbound-event ingestion / transport policy (§4) — selects the producer that
 * feeds the normalized {@link TrackerEvent} seam (`events.ts` / `transport.ts`),
 * proving the poll↔webhook swap is a **config edit**, not a code change (G9).
 *
 * Inline assumption (§4): the default producer is `poll` (v1; the webhook producer
 * is deferred per the Non-Goals), and `pollIntervalMs` mirrors the `loops.inbox`
 * cadence (60_000ms / task 2.4) so the polling transport and the inbox reconciler
 * tick at the same rate. The durable poll **watermark** is a runtime cursor (the
 * `PollingTransport` `Watermark`, persisted with the run record) — NOT a config
 * field, so it is intentionally absent here.
 */
export const IngestionSchema = z
  .object({
    /** Which producer feeds the inbound event seam. */
    producer: ProducerSchema.default('poll'),
    /** Poll cadence in milliseconds (mirrors `loops.inbox`). Ignored for `webhook`. */
    pollIntervalMs: z.number().int().positive().default(60_000),
  })
  .prefault({});

/**
 * The authoritative `/flow` engine configuration schema (§9).
 *
 * `FlowConfigSchema.parse({})` resolves the complete §9 default config.
 * Downstream engine tasks (1.6, 2.1, 2.2, 2.3, 3.1, 3.3) import the relevant
 * sub-schemas and the inferred {@link FlowConfig} type from this module.
 */
export const FlowConfigSchema = z
  .object({
    /** JSON Schema reference (points at the generated `config.schema.json`). */
    $schema: z.string().optional(),
    /** Active project tracker. */
    tracker: TrackerSchema.default('linear'),
    /** Agent identity & authorship marker. */
    identity: IdentitySchema,
    /** Ownership claim policy. */
    ownership: OwnershipSchema,
    /** Comment-engagement policy. */
    comments: CommentsSchema,
    /** The stage spine. */
    stages: StagesSchema,
    /** Autonomy & concurrency posture. */
    autonomy: AutonomySchema,
    /** Per-reconciler loop knobs (priority / cadence / enabled). */
    loops: LoopsSchema,
    /** Inbound-event ingestion / transport policy (poll vs webhook producer). */
    ingestion: IngestionSchema,
    /** Human-involvement policy. */
    involvement: InvolvementSchema,
    /** Dispatch policy. */
    dispatch: DispatchSchema,
    /** Gates — plan approval, review/auto-merge, circuit breakers. */
    gates: GatesSchema,
    /** Context strategy. */
    context: ContextSchema,
    /** Workspace provisioning policy. */
    workspace: WorkspaceSchema,
    /** Crash & stall recovery policy. */
    recovery: RecoverySchema,
    /** Task decomposition policy. */
    decomposition: DecompositionSchema,
    /** Browser proof-of-completion policy. */
    evidence: EvidenceSchema,
  })
  .strict();

/** The fully-resolved `/flow` engine configuration (§9). */
export type FlowConfig = z.infer<typeof FlowConfigSchema>;

/** A single stage definition in the spine. */
export type Stage = z.infer<typeof StageSchema>;
