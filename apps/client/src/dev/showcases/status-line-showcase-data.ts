/**
 * The session states the status-line showcases run through the real pipeline, and the
 * widths they run them at.
 *
 * Data only, kept out of `StatusLineShowcases` so the demos read as demos. Each
 * scenario is one session's worth of live state: what the promotion rules see, what
 * the items need to render, and what the Session panel behind the `⋯` reports.
 *
 * @module dev/showcases/status-line-showcase-data
 */
import type { GitStatusResponse, UsageStatus } from '@dorkos/shared/types';
import type { SessionStatusData } from '@/layers/entities/session';
import { gitPromotionState } from '@/layers/features/status';
import type {
  ActiveSubagent,
  SessionDiagnostics,
  StatusPromotionContext,
} from '@/layers/features/status';
import type {
  PlanChipState,
  StatusItemNodesInput,
} from '@/layers/features/chat/ui/status/status-item-nodes';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { RuntimeChipState } from '@/layers/features/status';

export const AGENT = {
  name: 'dorkbot',
  color: '#6366f1',
  emoji: '🤖',
  path: '/Users/dev/code/dorkos',
} as const;

const CWD = '/Users/dev/code/dorkos';

const CLEAN_GIT: GitStatusResponse = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  modified: 0,
  staged: 0,
  untracked: 0,
  conflicted: 0,
  clean: true,
  detached: false,
  tracking: 'origin/main',
};

const DIRTY_GIT: GitStatusResponse = {
  branch: 'dor-452-status-line',
  ahead: 2,
  behind: 0,
  modified: 3,
  staged: 1,
  untracked: 2,
  conflicted: 0,
  clean: false,
  detached: false,
  tracking: 'origin/dor-452-status-line',
};

/**
 * Claude's way of working, as its profile declares it — the mode behind the
 * composer's Plan switch. Codex and OpenCode declare none, which is why the
 * degraded (Codex) scenario carries `plan: null` and draws no chip.
 */
const PLAN_MODE: PermissionModeDescriptor = {
  id: 'plan',
  label: 'Plan',
  stop: 'ask',
  axis: 'working',
  asks: 'always',
  reach: 'read',
  promise: 'Reads and plans only. Nothing changes until you approve the plan.',
};

/** The Plan switch, offered and off. */
const PLAN_OFF: PlanChipState = {
  descriptor: PLAN_MODE,
  active: false,
  onToggle: () => {},
};

const DEFAULT_RUNTIME_CHIP: RuntimeChipState = {
  runtime: 'claude-code',
  model: 'claude-opus-4-6',
  canSelect: false,
  onChangeRuntime: () => {},
};

const CODEX_RUNTIME_CHIP: RuntimeChipState = {
  runtime: 'codex',
  model: 'gpt-5.3-codex',
  canSelect: false,
  onChangeRuntime: () => {},
};

const USAGE_OK: UsageStatus = {
  kind: 'subscription',
  utilization: 0.22,
  windowLabel: '5-hour window',
  costUsd: 0.41,
  state: 'ok',
};

const USAGE_WARNING: UsageStatus = {
  kind: 'subscription',
  utilization: 0.87,
  windowLabel: '5-hour window',
  costUsd: 6.12,
  state: 'warning',
};

const USAGE_EXHAUSTED: UsageStatus = {
  kind: 'subscription',
  utilization: 1,
  windowLabel: '5-hour window',
  costUsd: 9.84,
  state: 'exhausted',
};

/**
 * Two subagents mid-flight. The item counts what is RUNNING, not what the runtime
 * could call — a catalogue never changes, so counting it says nothing (DOR-462).
 */
const RUNNING_SUBAGENTS: ActiveSubagent[] = Array.from({ length: 12 }, (_, i) => ({
  taskId: `task-${i}`,
  status: 'running' as const,
  description: `Explore the ${i}th call site`,
  toolUses: i,
  lastToolName: 'Grep',
}));

/** Kept only so the shape above stays readable beside a hand-written example. */
const _EXAMPLE_SUBAGENT_SHAPE: ActiveSubagent[] = [
  {
    taskId: 'task-explore-1',
    status: 'running',
    description: 'Search the codebase for status-line callers',
    toolUses: 7,
    lastToolName: 'Grep',
  },
  {
    taskId: 'task-review-1',
    status: 'running',
    description: 'Review the budget change',
    toolUses: 2,
    lastToolName: 'Read',
  },
];

const HEALTHY_STATUS: SessionStatusData = {
  permissionMode: 'default',
  model: 'claude-opus-4-6',
  effort: null,
  fastMode: false,
  costUsd: 0.41,
  contextPercent: 31,
  isStreaming: false,
  cwd: CWD,
};

const DEGRADED_STATUS: SessionStatusData = {
  ...HEALTHY_STATUS,
  permissionMode: 'bypassPermissions',
  model: 'gpt-5.3-codex',
  costUsd: 6.12,
  contextPercent: 88,
};

/** One session's worth of state, minus the density the width decides. */
export interface StatusScenario {
  /** What this state is, in the words a reviewer would use. */
  label: string;
  /** Live state the promotion rules read. */
  ctx: StatusPromotionContext;
  /** Everything the items need, minus `density`. */
  input: Omit<StatusItemNodesInput, 'density'>;
  /** What the Session panel behind the `⋯` reports for this session. */
  diagnostics: SessionDiagnostics;
}

const HEALTHY_DIAGNOSTICS: SessionDiagnostics = {
  sessionId: '3d81b5c0-6a24-4f9e-8c11-7b0e2d4a9f31',
  cwd: CWD,
  git: { state: 'repo', branch: CLEAN_GIT.branch, dirty: false },
  runtime: 'claude-code',
  model: 'claude-opus-4-6',
  selectedModel: 'default',
  effort: null,
  fastMode: false,
  permissionMode: 'default',
  contextPercent: 31,
  contextUsage: null,
  cache: { readTokens: 48_100, creationTokens: 6_200, contextTokens: 62_000 },
  usage: USAGE_OK,
  connectionState: 'connected',
  streaming: false,
  lifecycle: 'idle',
  triggerPending: false,
  lastEventSeq: 184,
  snapshotCursor: 180,
  lastEventAt: null,
  queueDepth: 0,
  subagents: [],
  activeSubagents: [],
  runningSubagentCount: 0,
  clientVersion: '0.57.0',
};

const DEGRADED_DIAGNOSTICS: SessionDiagnostics = {
  sessionId: '9f3c1a7e-4b2d-4f10-9c85-2a6e1b0d7f44',
  cwd: CWD,
  git: { state: 'repo', branch: DIRTY_GIT.branch, dirty: true },
  runtime: 'codex',
  model: 'gpt-5.3-codex',
  selectedModel: 'gpt-5.3-codex',
  effort: 'high',
  fastMode: false,
  permissionMode: 'bypassPermissions',
  contextPercent: 88,
  contextUsage: null,
  cache: { readTokens: 141_200, creationTokens: 18_400, contextTokens: 176_000 },
  usage: USAGE_WARNING,
  connectionState: 'disconnected',
  streaming: false,
  lifecycle: 'idle',
  triggerPending: false,
  lastEventSeq: 2471,
  snapshotCursor: 2400,
  lastEventAt: null,
  queueDepth: 2,
  subagents: [],
  activeSubagents: RUNNING_SUBAGENTS,
  runningSubagentCount: RUNNING_SUBAGENTS.length,
  clientVersion: '0.57.0',
};

/**
 * A resting session: clean tree on the default branch, a third of the context
 * window used, connected, default permissions, the default runtime. Nothing here
 * is news, so almost nothing shows.
 */
export const HEALTHY: StatusScenario = {
  label: 'Healthy — nothing to report',
  ctx: {
    cwd: CWD,
    git: gitPromotionState(CLEAN_GIT.branch, CLEAN_GIT.clean, CLEAN_GIT.detached),
    contextPercent: 31,
    connectionState: 'connected',
    permissionMode: 'default',
    permissionDescriptor: null,
    plan: { active: false },
    runtime: { isDefault: true, canSelect: false },
    usage: USAGE_OK,
    subagentsInFlight: 0,
  },
  input: {
    sessionId: 'showcase-healthy',
    agent: { name: AGENT.name, color: AGENT.color, emoji: AGENT.emoji, path: AGENT.path },
    status: HEALTHY_STATUS,
    onUpdateSession: () => {},
    onChangeMode: () => {},
    // No offer in a static showcase: the line under the dial is a response to
    // somebody moving it, and there is nobody here to have moved it.
    makeDefault: null,
    onPermissionPickerOpenChange: () => {},
    modelSupportsAutoMode: true,
    plan: PLAN_OFF,
    gitStatus: CLEAN_GIT,
    workspace: null,
    runtimeChip: DEFAULT_RUNTIME_CHIP,
    contextPercent: 31,
    contextUsage: null,
    compact: null,
    usage: USAGE_OK,
    supportsCostTracking: true,
    runningSubagents: [],
    liveSubagentCount: 0,
    waitingOnSubagents: false,
    connectionState: 'connected',
  },
  diagnostics: HEALTHY_DIAGNOSTICS,
};

/**
 * Everything going wrong at once — the state the width budget exists for. The
 * live link is down, the context window is nearly full, permissions are bypassed,
 * the runtime is not the default, the tree is dirty on a feature branch, usage is
 * near its ceiling, and two subagents are still running.
 */
export const DEGRADED: StatusScenario = {
  label: 'Degraded — live updates lost, context critical, bypass permissions, non-default runtime',
  ctx: {
    cwd: CWD,
    git: gitPromotionState(DIRTY_GIT.branch, DIRTY_GIT.clean, DIRTY_GIT.detached),
    contextPercent: 88,
    connectionState: 'disconnected',
    permissionMode: 'bypassPermissions',
    permissionDescriptor: {
      id: 'bypassPermissions',
      label: 'Bypass permissions',
      stop: 'autonomy',
      asks: 'never',
      reach: 'everything',
      promise:
        'Acts without approval prompts — including outside this project. Still asks when it needs your call.',
    },
    plan: null,
    runtime: { isDefault: false, canSelect: false },
    usage: USAGE_WARNING,
    subagentsInFlight: RUNNING_SUBAGENTS.length,
  },
  input: {
    sessionId: 'showcase-degraded',
    agent: { name: AGENT.name, color: AGENT.color, emoji: AGENT.emoji, path: AGENT.path },
    status: DEGRADED_STATUS,
    onUpdateSession: () => {},
    onChangeMode: () => {},
    // No offer in a static showcase: the line under the dial is a response to
    // somebody moving it, and there is nobody here to have moved it.
    makeDefault: null,
    onPermissionPickerOpenChange: () => {},
    modelSupportsAutoMode: false,
    plan: null,
    gitStatus: DIRTY_GIT,
    workspace: null,
    runtimeChip: CODEX_RUNTIME_CHIP,
    contextPercent: 88,
    contextUsage: null,
    compact: null,
    usage: USAGE_WARNING,
    supportsCostTracking: true,
    runningSubagents: RUNNING_SUBAGENTS,
    liveSubagentCount: RUNNING_SUBAGENTS.length,
    waitingOnSubagents: false,
    connectionState: 'disconnected',
  },
  diagnostics: DEGRADED_DIAGNOSTICS,
};

/**
 * The same degraded state on the default runtime, whose `bypassPermissions`
 * descriptor is the longest permission label DorkOS ships: `Bypass permissions`, 18
 * characters against a slot priced at 13 (`STATUS_VALUE_MAX_CHARS`). The widest tier
 * draws it whole, so this is the row where that shows. Codex's own bypass label is
 * `Full access`, which fits — which is exactly why the degraded rows above do not
 * make the point.
 */
export const DEGRADED_ON_DEFAULT: StatusScenario = {
  label: 'Degraded on the default runtime — the longest permission label DorkOS ships',
  ctx: { ...DEGRADED.ctx, runtime: { isDefault: true, canSelect: false } },
  input: {
    ...DEGRADED.input,
    sessionId: 'showcase-degraded-default',
    status: { ...DEGRADED_STATUS, model: 'claude-opus-4-6' },
    runtimeChip: DEFAULT_RUNTIME_CHIP,
  },
  diagnostics: {
    ...DEGRADED_DIAGNOSTICS,
    runtime: 'claude-code',
    model: 'claude-opus-4-6',
    effort: null,
  },
};

/**
 * Rate-limited: the connection is down, the window is nearly full, and the
 * subscription has hit its ceiling — with permissions left at their default.
 *
 * That last detail is the whole point of having this scenario as well as
 * {@link DEGRADED}. Severity puts `connection` (100), `context` (90) and `usage`
 * (80) at the top, so those three are exactly what a three-slot budget draws —
 * whereas DEGRADED's `bypassPermissions` (70) outranks a usage *warning* (50) and
 * pushes the usage item under the `⋯`, where its width can never be wrong. The
 * usage item is the one that shipped unable to shrink or be shrunk (DOR-461
 * review), and this is the row that puts it on screen beside its neighbours.
 */
export const RATE_LIMITED: StatusScenario = {
  label: 'Rate limited — live updates lost, context critical, subscription exhausted',
  ctx: {
    ...DEGRADED.ctx,
    permissionMode: 'default',
    permissionDescriptor: null,
    usage: USAGE_EXHAUSTED,
  },
  input: {
    ...DEGRADED.input,
    sessionId: 'showcase-rate-limited',
    status: { ...DEGRADED_STATUS, permissionMode: 'default' },
    usage: USAGE_EXHAUSTED,
  },
  diagnostics: {
    ...DEGRADED_DIAGNOSTICS,
    permissionMode: 'default',
    usage: USAGE_EXHAUSTED,
  },
};

/**
 * A turn that has delegated work, with one number beside it.
 *
 * The row where the subagents item is actually drawn: two rigid items is the most
 * the right cluster accepts, so a session that is also rate-limited pushes this
 * one under the `⋯` (see `MAX_RIGID_ITEMS`). Twelve running on purpose — a
 * two-digit count is the case that can be drawn wrong, and was: squeezed to its
 * floor it rendered `1`, with the ellipsis clipped off, reading as one subagent
 * out of twelve (DOR-461 review).
 */
export const DELEGATING: StatusScenario = {
  label: 'Delegating — a nearly-full window and twelve subagents running',
  ctx: {
    ...DEGRADED.ctx,
    connectionState: 'connected',
    permissionMode: 'default',
    permissionDescriptor: null,
    plan: { active: false },
    runtime: { isDefault: true, canSelect: false },
    usage: USAGE_OK,
  },
  input: {
    ...DEGRADED.input,
    sessionId: 'showcase-delegating',
    status: { ...DEGRADED_STATUS, permissionMode: 'default' },
    runtimeChip: DEFAULT_RUNTIME_CHIP,
    usage: USAGE_OK,
    connectionState: 'connected',
  },
  diagnostics: { ...DEGRADED_DIAGNOSTICS, connectionState: 'connected', usage: USAGE_OK },
};

/**
 * A session that has stopped talking while its background tasks have not
 * (DOR-1100).
 *
 * The one state where the same count means something different: `idle` with
 * children still running is why a session can look finished and not be, so the
 * item keeps its slot and its tooltip explains the wait. Built from HEALTHY —
 * nothing else about this session is news, which is the point: the subagents
 * item is the only thing that promotes.
 */
export const WAITING_ON_BACKGROUND_TASKS: StatusScenario = {
  label: 'Idle, but its background tasks are still running',
  ctx: { ...HEALTHY.ctx, subagentsInFlight: RUNNING_SUBAGENTS.length },
  input: {
    ...HEALTHY.input,
    sessionId: 'showcase-waiting-on-background-tasks',
    runningSubagents: RUNNING_SUBAGENTS,
    liveSubagentCount: RUNNING_SUBAGENTS.length,
    waitingOnSubagents: true,
  },
  diagnostics: {
    ...HEALTHY.diagnostics,
    activeSubagents: RUNNING_SUBAGENTS,
    runningSubagentCount: RUNNING_SUBAGENTS.length,
  },
};

/**
 * Plan holds the session, reconnecting and nearly out of context on top of it —
 * the exact reproduction that found DOR-1236. `permission` and `plan` used to
 * tie at the same severity, and `applyStatusBudget`'s tie-break (stable sort,
 * registry order) gave a narrow bar's contested slot to an empty permission
 * chip instead of the one chip that is news. Run this scenario at the
 * `compact` and `identity` floors (the two narrow tiers, ~440px and ~340px) to
 * see only the Plan chip in the line — never a redundant permission chip
 * beside it.
 */
export const PLANNING: StatusScenario = {
  label: 'Planning — reconnecting, and nearly out of context',
  ctx: {
    cwd: CWD,
    git: gitPromotionState(CLEAN_GIT.branch, CLEAN_GIT.clean, CLEAN_GIT.detached),
    contextPercent: 92,
    connectionState: 'reconnecting',
    permissionMode: 'plan',
    permissionDescriptor: PLAN_MODE,
    plan: { active: true },
    runtime: { isDefault: true, canSelect: false },
    usage: USAGE_OK,
    subagentsInFlight: 0,
  },
  input: {
    sessionId: 'showcase-planning',
    agent: { name: AGENT.name, color: AGENT.color, emoji: AGENT.emoji, path: AGENT.path },
    status: { ...HEALTHY_STATUS, permissionMode: 'plan', contextPercent: 92 },
    onUpdateSession: () => {},
    onChangeMode: () => {},
    makeDefault: null,
    onPermissionPickerOpenChange: () => {},
    modelSupportsAutoMode: true,
    plan: { descriptor: PLAN_MODE, active: true, onToggle: () => {} },
    gitStatus: CLEAN_GIT,
    workspace: null,
    runtimeChip: DEFAULT_RUNTIME_CHIP,
    contextPercent: 92,
    contextUsage: null,
    compact: null,
    usage: USAGE_OK,
    supportsCostTracking: true,
    runningSubagents: [],
    liveSubagentCount: 0,
    waitingOnSubagents: false,
    connectionState: 'reconnecting',
  },
  diagnostics: {
    ...HEALTHY_DIAGNOSTICS,
    permissionMode: 'plan',
    contextPercent: 92,
    connectionState: 'reconnecting',
  },
};

/**
 * One bar width per density tier, widest first: each tier at its floor from
 * `status-budget` (640 / 440 / 340), plus 320 for `avatar`, which has no floor.
 *
 * A tier's floor is the tier at its worst — the most it may say in the fewest
 * pixels it may say it in — which is the interesting width and the only one where a
 * budget can be caught over-promising.
 *
 * Capped at 640 on purpose. These boxes are a fixed pixel width, and the
 * playground's content column is ~680px on a 1280px laptop; a wider row would
 * scroll its own `⋯` out of sight, which is the one thing this demo must never
 * hide. The `full` tier's budget keeps growing above 640 — the showcase's budget
 * table reports that from the same function without drawing a 1440px bar.
 */
export const TIER_WIDTHS = [640, 440, 340, 320] as const;

/**
 * Widths the showcase's budget table samples, from a small phone to a wide desktop:
 * every tier floor (340 / 440 / 640), a 320px phone below the narrowest of them, one
 * width inside `compact` to show a tier whose budget does not move, and four above
 * 640, the only tier whose budget grows with the width.
 */
export const SAMPLED_WIDTHS = [320, 340, 440, 520, 640, 764, 890, 1024, 1440] as const;
