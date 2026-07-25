/**
 * One snapshot of everything DorkOS knows about a session — the live value
 * beside each Session-panel row, the roomier readout in the Session tab, and the
 * blob **Copy diagnostics** puts on the clipboard. All three read from this
 * single object, so a value shown in the panel, a value shown in the tab, and a
 * value pasted into a bug report can never disagree.
 *
 * The snapshot itself is assembled by `use-session-diagnostics`, which is the
 * only place any of these fields is sourced.
 *
 * @module features/status/model/session-diagnostics
 */
import type {
  ConnectionState,
  ContextUsage,
  EffortLevel,
  PermissionMode,
  SubagentInfo,
  UsageStatus,
} from '@dorkos/shared/types';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { StatusBarItemKey } from './status-bar-registry';

/** Prompt-cache accounting for one session. */
export interface CacheDiagnostics {
  /** Tokens served from cache. */
  readTokens: number;
  /** Tokens written to cache. */
  creationTokens: number;
  /** Full request input, when known — already includes both cache terms. */
  contextTokens?: number;
}

/**
 * One subagent this session has running (or has run) in the turn in progress,
 * folded from the turn's `subagent_update` events.
 */
export interface ActiveSubagent {
  /** The runtime's task id — stable identity across updates. */
  taskId: string;
  /** Lifecycle of the subagent task. */
  status: string;
  /** What it was asked to do, when the runtime reported it. */
  description?: string;
  /** How many tools it has called so far. */
  toolUses?: number;
  /** The most recent tool it called. */
  lastToolName?: string;
  /** Its result summary, once it finished. */
  summary?: string;
}

/** Everything the Session surfaces report about the active session. */
export interface SessionDiagnostics {
  /** The session id. */
  sessionId: string;
  /** Working directory, or `null` when unresolved. */
  cwd: string | null;
  /** Current branch name, or `null` when the directory is not a git repository. */
  gitBranch: string | null;
  /** Whether the working tree has uncommitted changes; `null` when unknown. */
  gitDirty: boolean | null;
  /** Runtime this session runs on, or `null` while it is resolving. */
  runtime: string | null;
  /**
   * Resolved model id — what the runtime actually answered with (e.g.
   * `claude-opus-4-6`), or `null` when unknown.
   */
  model: string | null;
  /**
   * The model OPTION the person picked (e.g. `default`, `opusplan`). Distinct
   * from {@link model} on purpose: the picker and the auto-mode gate key off this
   * value while the transcript reports the id the SDK resolved it to, and a
   * readout that showed only one of the two would hide exactly the mismatch
   * someone opens this surface to find. `null` when nothing is selected yet.
   */
  selectedModel: string | null;
  /** Reasoning effort, when the runtime exposes one. */
  effort: EffortLevel | null;
  /** Whether fast mode is on for this session. */
  fastMode: boolean;
  /** The session's permission mode. */
  permissionMode: PermissionMode;
  /** Context-window utilization percent (0-100), or `null` before the first reading. */
  contextPercent: number | null;
  /** Rich per-category context breakdown, or `null` until a live event carries one. */
  contextUsage: ContextUsage | null;
  /** Prompt-cache accounting, or `null` when nothing has been cached yet. */
  cache: CacheDiagnostics | null;
  /** Runtime-neutral usage descriptor, or `null` when the session has none. */
  usage: UsageStatus | null;
  /** Live-sync connection state of the durable event stream. */
  connectionState: ConnectionState;
  /**
   * Whether this client considers a turn in flight — the same predicate the
   * composer gates Enter on. Not derivable from {@link lifecycle} alone: before
   * the durable stream hydrates it falls back to the legacy send-path status.
   */
  streaming: boolean;
  /** Server-projected lifecycle, or `null` before the stream hydrates. */
  lifecycle: SessionLifecycle | null;
  /** True between a turn trigger (POST) and the server's `turn_start`. */
  triggerPending: boolean;
  /** Highest event sequence this client has applied. */
  lastEventSeq: number;
  /**
   * Cursor of the snapshot this client resumed from, or `null` before the first
   * hydration. Read beside {@link lastEventSeq} it says whether the stream has
   * delivered anything at all since it connected.
   */
  snapshotCursor: number | null;
  /**
   * `Date.now()` when the last frame was applied, or `null` before hydration.
   * A `connected` stream with a long-stale timestamp is the signature of a
   * stream that has quietly stopped delivering.
   */
  lastEventAt: number | null;
  /** How many composed messages are waiting to send. */
  queueDepth: number;
  /** Subagents this session can call. */
  subagents: SubagentInfo[];
  /** Subagents folded from the turn in progress; empty when nothing is running. */
  activeSubagents: ActiveSubagent[];
  /** DorkOS version reported by the server, or `null` while config loads. */
  clientVersion: string | null;
}

/**
 * Share of a request's input that came from cache, as a whole percent.
 *
 * `contextTokens` is the full request input and already includes both cache
 * terms, so it is the denominator when present; otherwise the two cache figures
 * are all we know about.
 *
 * @param cache - The session's cache accounting.
 */
export function cacheHitPercent(cache: CacheDiagnostics): number {
  const totalInput = cache.contextTokens ?? cache.readTokens + cache.creationTokens;
  if (totalInput <= 0) return 0;
  return Math.round((cache.readTokens / totalInput) * 100);
}

/** Human-readable usage figure — utilization for a plan, cost for pay-as-you-go. */
function usageLabel(usage: UsageStatus | null): string | null {
  if (!usage) return null;
  if (usage.kind === 'subscription' && usage.utilization != null) {
    return `${Math.round(usage.utilization * 100)}% of ${usage.windowLabel ?? 'your plan'}`;
  }
  if (usage.costUsd != null) return `$${usage.costUsd.toFixed(2)}`;
  return null;
}

/** The leaf folder of a path — what the status line and the popover both show. */
function leafFolder(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd;
}

/**
 * The live value shown on the right of one popover row, or `null` when the item
 * has nothing to report yet.
 *
 * @param key - Which registry row to describe.
 * @param d - The session snapshot to read from.
 */
export function statusRowValue(key: StatusBarItemKey, d: SessionDiagnostics): string | null {
  switch (key) {
    case 'cwd':
      return d.cwd ? leafFolder(d.cwd) : null;
    case 'git':
      if (d.gitBranch === null) return 'No repo';
      return d.gitDirty ? `${d.gitBranch} · changed` : d.gitBranch;
    case 'runtime':
      return d.runtime;
    case 'model':
      return d.model;
    case 'context':
      return d.contextPercent === null ? null : `${d.contextPercent}% full`;
    case 'cache':
      return d.cache === null ? null : `${cacheHitPercent(d.cache)}% from cache`;
    case 'usage':
      return usageLabel(d.usage);
    case 'permission':
      return d.permissionMode;
    case 'connection':
      return `${d.connectionState} · event ${d.lastEventSeq}`;
    default:
      return null;
  }
}

/**
 * The Copy-diagnostics payload: one pretty-printed JSON object with everything
 * needed to reason about a misbehaving session, in a shape that is readable in a
 * bug report as-is.
 *
 * @param d - The session snapshot to serialize.
 */
export function formatDiagnostics(d: SessionDiagnostics): string {
  return JSON.stringify(
    {
      sessionId: d.sessionId,
      cwd: d.cwd,
      git: d.gitBranch === null ? null : { branch: d.gitBranch, dirty: d.gitDirty },
      runtime: d.runtime,
      model: d.model,
      selectedModel: d.selectedModel,
      effort: d.effort,
      fastMode: d.fastMode,
      permissionMode: d.permissionMode,
      contextPercent: d.contextPercent,
      contextUsage: d.contextUsage,
      cache:
        d.cache === null
          ? null
          : {
              readTokens: d.cache.readTokens,
              creationTokens: d.cache.creationTokens,
              contextTokens: d.cache.contextTokens ?? null,
              hitPercent: cacheHitPercent(d.cache),
            },
      usage: d.usage,
      connectionState: d.connectionState,
      streaming: d.streaming,
      lifecycle: d.lifecycle,
      triggerPending: d.triggerPending,
      lastEventSeq: d.lastEventSeq,
      snapshotCursor: d.snapshotCursor,
      lastEventAt: d.lastEventAt === null ? null : new Date(d.lastEventAt).toISOString(),
      queueDepth: d.queueDepth,
      subagents: d.subagents.map((a) => a.name),
      activeSubagents: d.activeSubagents,
      clientVersion: d.clientVersion,
      capturedAt: new Date().toISOString(),
    },
    null,
    2
  );
}
