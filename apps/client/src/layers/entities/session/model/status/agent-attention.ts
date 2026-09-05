/**
 * Attention-signal model — the single source of per-agent "does this need my
 * eyes?" truth (spec agent-list-settings, DOR-339). The per-group display
 * filter, the inactive reveal row, the group rollup dot, and mute all derive
 * from this one module instead of each maintaining its own notion of "busy"
 * or "stale".
 *
 * @module entities/session/model/status/agent-attention
 */
import { useCallback, useMemo } from 'react';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { useSessionListStore } from '../stream/session-list-store';
import { borderKindFromLifecycle } from './use-session-border-state';
import { useRecentSessions } from '../query/use-recent-sessions';

/**
 * Per-agent attention state, ordered by precedence — the first matching state
 * (top to bottom) wins:
 *
 * - `needs-attention` — a live session is awaiting approval, or one is in an
 *   error/blocked state.
 * - `active` — a live session is streaming, or the agent had activity within
 *   {@link ATTENTION_THRESHOLDS.activeWithinMs}.
 * - `idle` — activity exists, but older than the active window and not yet
 *   past the inactive threshold.
 * - `fresh` — a brand-new agent that has never had any session activity. Kept
 *   distinct from `inactive` so a newly-created agent (e.g. the DorkBot a user
 *   just set up in onboarding) reads as new rather than dormant, and stays
 *   visible in the roster instead of collapsing behind the inactive reveal row.
 * - `inactive` — had activity once, but none within
 *   {@link ATTENTION_THRESHOLDS.inactiveAfterMs}.
 */
export type AttentionState = 'needs-attention' | 'active' | 'idle' | 'fresh' | 'inactive';

/** Recency thresholds bounding the `active` / `idle` / `inactive` boundaries. */
export const ATTENTION_THRESHOLDS = {
  /** Activity within this window ⇒ 'active'. */
  activeWithinMs: 60 * 60 * 1000, // 1h
  /** No activity beyond this window ⇒ 'inactive'. */
  inactiveAfterMs: 7 * 24 * 60 * 60 * 1000, // 7d
} as const;

/**
 * The subset of {@link borderKindFromLifecycle}'s output that carries a live
 * signal (its `null` case means "no actionable lifecycle" and never reaches
 * the fold below).
 */
export type LiveBorderKind = NonNullable<ReturnType<typeof borderKindFromLifecycle>>;

/** Input to {@link deriveAttention} — pre-folded so it stays pure and cheap to test. */
export interface DeriveAttentionInput {
  /** Live border kinds observed across every session for this agent's path (may be empty). */
  liveKinds: LiveBorderKind[];
  /** Latest known session activity (epoch ms), or `null` when the agent has never had one. */
  lastActivityAt: number | null;
  /**
   * When the VIEWER last opened this agent (epoch ms), or `null`/absent when
   * they never have.
   *
   * **It only ever holds an agent back from `inactive`.** An agent is also a
   * project, and one you opened last Tuesday to read is not dormant even if it
   * ran nothing — so the week-long boundary is measured from the later of the
   * two facts (spec `sidebar-simplification` D3). The `active` window above is
   * deliberately NOT measured from it: opening a page is not the agent working,
   * and a green "active" dot earned by your own click would be a lie about
   * somebody else.
   */
  lastInteractionAt?: number | null;
  /** Caller-supplied clock reading (epoch ms) — kept pure and testable, no `Date.now()` inside. */
  now: number;
  /**
   * Whether this agent's execution settings cannot be honored as written — a
   * runtime it names that is not connected, a model its runtime no longer
   * offers, an effort where there is none (spec `execution-defaults` §5).
   *
   * Folded in here rather than shown only in Settings because breakage has to
   * surface where attention already lives: an agent that cannot start a session
   * the way it is configured is exactly what "needs attention" has always meant,
   * and a person who never opens Settings would otherwise find out by running it.
   */
  hasBrokenExecutionConfig?: boolean;
}

/**
 * Derive one agent's {@link AttentionState}. Pure: a live signal always wins
 * over recency; recency then resolves active vs. idle vs. inactive.
 *
 * `borderKindFromLifecycle` exposes three live kinds: `streaming`,
 * `pendingApproval`, and `error`. Their mapping here is an implementer
 * decision (spec agent-list-settings §1 + Open Questions watch-item):
 * `streaming` means the agent is actively working, so it maps to `active`.
 * `pendingApproval` and `error` both mean "a human needs to look at this" —
 * an approval gate and a failed turn are equally blocking, neither resolves
 * itself — so both fold into `needs-attention`. `error` is exactly the
 * "blocked/error kind distinct from `pendingApproval`" the spec's Open
 * Questions section anticipated finding in the enum.
 *
 * @param input - Pre-folded live kinds, last-activity timestamp, and clock reading.
 */
export function deriveAttention(input: DeriveAttentionInput): AttentionState {
  if (
    input.liveKinds.includes('pendingApproval') ||
    input.liveKinds.includes('error') ||
    input.hasBrokenExecutionConfig === true
  ) {
    return 'needs-attention';
  }
  if (input.liveKinds.includes('streaming')) {
    return 'active';
  }
  if (input.lastActivityAt === null) {
    return 'fresh';
  }
  const elapsed = input.now - input.lastActivityAt;
  if (elapsed <= ATTENTION_THRESHOLDS.activeWithinMs) return 'active';
  const lastSeen = Math.max(input.lastActivityAt, input.lastInteractionAt ?? input.lastActivityAt);
  if (input.now - lastSeen > ATTENTION_THRESHOLDS.inactiveAfterMs) return 'inactive';
  return 'idle';
}

/**
 * Fold every entry in the session-list store's `statusCwds`/`statuses` whose
 * cwd is in `pathSet` into the live border kinds observed for that path.
 * Multiple sessions per agent accumulate into one array (the "hottest state
 * across sessions" join {@link useAgentAttentionMap}'s hook test covers).
 * Shared by {@link useAgentAttentionMap} and `useAgentsAggregateStatus` so
 * both read the fleet-wide liveness signal with the exact same fold.
 *
 * @internal Exported for the sibling aggregate-status hook and direct testing.
 * @param statusCwds - The session-list store's session-id → cwd map.
 * @param statuses - The session-list store's session-id → status map.
 * @param pathSet - Agent project paths to fold into.
 */
export function foldLiveKindsByPath(
  statusCwds: Record<string, string>,
  statuses: Record<string, SessionStatus>,
  pathSet: ReadonlySet<string>
): Map<string, LiveBorderKind[]> {
  const result = new Map<string, LiveBorderKind[]>();
  for (const [id, cwd] of Object.entries(statusCwds)) {
    if (!pathSet.has(cwd)) continue;
    const kind = borderKindFromLifecycle(statuses[id]?.lifecycle);
    if (!kind) continue;
    const existing = result.get(cwd);
    if (existing) existing.push(kind);
    else result.set(cwd, [kind]);
  }
  return result;
}

/**
 * The empty interaction record, minted once.
 *
 * A default parameter is evaluated per call, so `= {}` handed the memo below a
 * fresh object on every render and rebuilt the whole map on every store tick —
 * for exactly the callers that pass nothing, which is every one but the sidebar.
 */
const NO_INTERACTIONS: Readonly<Record<string, number>> = Object.freeze({});

/**
 * Derive the {@link AttentionState} for every path in `paths` — the single
 * source of attention truth the sidebar's filters, reveal rows, and mute all
 * read. One session-list-store subscription (two raw-property selectors, not
 * a per-row one) joined with `agentActivity` recency from
 * {@link useRecentSessions}; O(1) regardless of fleet size.
 *
 * Raw store slices are read directly rather than folding inside the zustand
 * selector: Immer only replaces `statusCwds`/`statuses` references when they
 * actually mutate, so subscribing to them directly stays cheap, whereas
 * returning a freshly-built `Map` from inside a selector mints a new
 * reference on every store tick — `useSyncExternalStore` treats that as
 * "always changed" (see the `useSessionListSessions` comment in
 * `session-list-store.ts` for the same gotcha with `useShallow`).
 *
 * @param paths - Agent project paths to derive attention for.
 * @param brokenExecutionPaths - Paths whose execution settings cannot be
 *   honored, from `useExecutionExceptions`. Passed in rather than computed here
 *   because that question spans agents, config, and runtimes, and this module
 *   is the session entity — the caller already holds all three.
 * @param lastInteractionAt - Agent path → when the viewer last opened it, epoch
 *   ms. Passed in for the same reason: the record lives in
 *   `entities/interactions`, a sibling entity this one may not import. A caller
 *   that has no such record omits it and the boundary reads activity alone.
 */
export function useAgentAttentionMap(
  paths: string[],
  brokenExecutionPaths: string[] = [],
  lastInteractionAt: Readonly<Record<string, number>> = NO_INTERACTIONS
): Record<string, AttentionState> {
  const key = paths.join('\n');
  // Joined to a string for the same reason `paths` is: a fresh array every
  // render would defeat the memo below on every store tick.
  const brokenKey = brokenExecutionPaths.join('\n');
  const statusCwds = useSessionListStore(useCallback((s) => s.statusCwds, []));
  const statuses = useSessionListStore(useCallback((s) => s.statuses, []));
  const { data } = useRecentSessions();
  const agentActivity = data?.agentActivity;

  return useMemo(() => {
    const pathList = key.length === 0 ? [] : key.split('\n');
    const broken = new Set(brokenKey.length === 0 ? [] : brokenKey.split('\n'));
    const liveFolded = foldLiveKindsByPath(statusCwds, statuses, new Set(pathList));
    // eslint-disable-next-line react-hooks/purity -- Date.now() is intentional for recency-threshold classification
    const now = Date.now();
    const result: Record<string, AttentionState> = {};
    for (const path of pathList) {
      const iso = agentActivity?.[path];
      result[path] = deriveAttention({
        liveKinds: liveFolded.get(path) ?? [],
        lastActivityAt: iso ? new Date(iso).getTime() : null,
        lastInteractionAt: lastInteractionAt[path] ?? null,
        now,
        hasBrokenExecutionConfig: broken.has(path),
      });
    }
    return result;
  }, [key, brokenKey, statusCwds, statuses, agentActivity, lastInteractionAt]);
}
