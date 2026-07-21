/**
 * Attention-signal model — the single source of per-agent "does this need my
 * eyes?" truth (spec agent-list-settings, DOR-339). The per-group display
 * filter, the inactive reveal row, the group rollup dot, and mute all derive
 * from this one module instead of each maintaining its own notion of "busy"
 * or "stale".
 *
 * @module entities/session/model/agent-attention
 */
import { useCallback, useMemo } from 'react';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { useSessionListStore } from './session-list-store';
import { borderKindFromLifecycle } from './use-session-border-state';
import { useRecentSessions } from './use-recent-sessions';

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
 * - `inactive` — no activity within {@link ATTENTION_THRESHOLDS.inactiveAfterMs}
 *   (or no activity at all).
 */
export type AttentionState = 'needs-attention' | 'active' | 'idle' | 'inactive';

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
  /** Caller-supplied clock reading (epoch ms) — kept pure and testable, no `Date.now()` inside. */
  now: number;
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
  if (input.liveKinds.includes('pendingApproval') || input.liveKinds.includes('error')) {
    return 'needs-attention';
  }
  if (input.liveKinds.includes('streaming')) {
    return 'active';
  }
  if (input.lastActivityAt === null) {
    return 'inactive';
  }
  const elapsed = input.now - input.lastActivityAt;
  if (elapsed <= ATTENTION_THRESHOLDS.activeWithinMs) return 'active';
  if (elapsed > ATTENTION_THRESHOLDS.inactiveAfterMs) return 'inactive';
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
 */
export function useAgentAttentionMap(paths: string[]): Record<string, AttentionState> {
  const key = paths.join('\n');
  const statusCwds = useSessionListStore(useCallback((s) => s.statusCwds, []));
  const statuses = useSessionListStore(useCallback((s) => s.statuses, []));
  const { data } = useRecentSessions();
  const agentActivity = data?.agentActivity;

  return useMemo(() => {
    const pathList = key.length === 0 ? [] : key.split('\n');
    const liveFolded = foldLiveKindsByPath(statusCwds, statuses, new Set(pathList));
    const now = Date.now();
    const result: Record<string, AttentionState> = {};
    for (const path of pathList) {
      const iso = agentActivity?.[path];
      result[path] = deriveAttention({
        liveKinds: liveFolded.get(path) ?? [],
        lastActivityAt: iso ? new Date(iso).getTime() : null,
        now,
      });
    }
    return result;
  }, [key, statusCwds, statuses, agentActivity]);
}
