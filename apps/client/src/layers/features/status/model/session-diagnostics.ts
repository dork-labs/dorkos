/**
 * One snapshot of everything the Session popover knows about a session — the
 * live value beside each row, and the blob **Copy diagnostics** puts on the
 * clipboard. Both read from this single object, so a value shown in the panel and
 * a value pasted into a bug report can never disagree.
 *
 * @module features/status/model/session-diagnostics
 */
import type { ConnectionState, PermissionMode, UsageStatus } from '@dorkos/shared/types';
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

/** Everything the Session popover reports about the active session. */
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
  /** Resolved model id, or `null` when unknown. */
  model: string | null;
  /** Reasoning effort, when the runtime exposes one. */
  effort: string | null;
  /** The session's permission mode. */
  permissionMode: PermissionMode;
  /** Context-window utilization percent (0-100), or `null` before the first reading. */
  contextPercent: number | null;
  /** Prompt-cache accounting, or `null` when nothing has been cached yet. */
  cache: CacheDiagnostics | null;
  /** Runtime-neutral usage descriptor, or `null` when the session has none. */
  usage: UsageStatus | null;
  /** Live-sync connection state of the durable event stream. */
  connectionState: ConnectionState;
  /** Highest event sequence this client has applied. */
  lastEventSeq: number;
  /** How many composed messages are waiting to send. */
  queueDepth: number;
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
      effort: d.effort,
      permissionMode: d.permissionMode,
      contextPercent: d.contextPercent,
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
      lastEventSeq: d.lastEventSeq,
      queueDepth: d.queueDepth,
      clientVersion: d.clientVersion,
      capturedAt: new Date().toISOString(),
    },
    null,
    2
  );
}
