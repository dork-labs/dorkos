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
  BackgroundTaskStatus,
  ConnectionState,
  ContextUsage,
  EffortLevel,
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
 * What is known about the working directory's git repository.
 *
 * Three states, never two: "the request has not answered" is a different claim
 * from "this is not a repository", and a single nullable branch collapsed them —
 * so the readout asserted `no repo` on a real checkout for as long as the query
 * took to resolve.
 */
export type GitDiagnostics =
  /** The status request has not answered yet, or it failed. Nothing is known. */
  | { state: 'unknown' }
  /** The directory resolved and it is not a git repository. */
  | { state: 'no-repo' }
  /** A repository: the branch it is on, and whether the tree has changes. */
  | { state: 'repo'; branch: string; dirty: boolean };

/**
 * One subagent the turn in progress started, folded from the turn's
 * `subagent_update` events. Present whether it is still running or has finished —
 * {@link SessionDiagnostics.activeSubagents} keeps terminal rows so a surface can
 * report what a turn DID, and every reader must therefore partition on
 * {@link ActiveSubagent.status} before calling anything "running".
 */
export interface ActiveSubagent {
  /** The runtime's task id — stable identity across updates. */
  taskId: string;
  /** Lifecycle of the subagent task — only `running` is still in flight. */
  status: BackgroundTaskStatus;
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
  /** The working directory's repository, in one of its three honest states. */
  git: GitDiagnostics;
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
  /**
   * The session's permission mode — any id the runtime declares (DOR-811),
   * wider than the shared `PermissionMode` enum's known names. `string`,
   * matching `SessionStatusData`, so the diagnostics readout never narrows
   * with a cast (DOR-820).
   */
  permissionMode: string;
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
  /**
   * Every subagent the turn in progress started — still running AND already
   * finished, so a surface can report both. Empty when the turn started none.
   *
   * Folded on ACCESS, not on assembly: a long turn's event list reaches thousands
   * of frames, and the always-mounted status line reads every other field on this
   * snapshot but never this one — folding eagerly made it an O(turn²) rescan for a
   * surface that renders none of it. Reading it is memoized per applied frame, so
   * a surface that does show it folds at most once per frame.
   */
  readonly activeSubagents: ActiveSubagent[];
  /**
   * Running subagents as the SERVER counts them, or `null` before the stream
   * hydrates. Deliberately kept beside {@link activeSubagents} rather than derived
   * from it: that fold is this client's own reading of the turn's frames, and a
   * disagreement between the two is a real defect — a dropped frame, or a fold
   * that mis-read a terminal status — which one number alone would hide.
   */
  runningSubagentCount: number | null;
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
      // `unknown` reports nothing at all (the row renders `—`): claiming "No
      // repo" while the request is still in flight is the one wrong answer.
      if (d.git.state === 'unknown') return null;
      if (d.git.state === 'no-repo') return 'No repo';
      return d.git.dirty ? `${d.git.branch} · changed` : d.git.branch;
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
      // The whole discriminated state, not a nullable branch: a bug report that
      // says `"git": { "state": "unknown" }` is reporting something different from
      // one that says `"no-repo"`, and the reader needs to be able to tell.
      git: d.git,
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
      // Beside the fold, never instead of it: a mismatch between the two is the
      // signal, so a bug report has to carry both.
      runningSubagentCount: d.runningSubagentCount,
      clientVersion: d.clientVersion,
      capturedAt: new Date().toISOString(),
    },
    null,
    2
  );
}
