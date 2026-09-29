/**
 * Derives a session's sidebar border indicator state from the live session
 * projections.
 *
 * Three sources are merged, hottest signal wins (spec chat-stream-reconnection):
 *
 * 1. **Per-session stream store** — the seq-gated projection for sessions this
 *    client has hydrated (foreground + recently attached).
 * 2. **Global session-list store** — `session_status` lifecycle fan-outs on
 *    `/api/events`, covering sessions this client never attached (background
 *    work, other windows, other agents).
 * 3. **Legacy chat store** — the send-path/recovery state, kept as a source
 *    until the dual-pipeline retirement.
 *
 * @module entities/session/model/status/use-session-border-state
 */
import { useCallback } from 'react';
import { useReducedMotion } from 'motion/react';
import {
  sessionDisplayState,
  type SessionLifecycle,
  type SessionStatus,
} from '@dorkos/shared/session-stream';
import { sessionLimitDisplay } from '../../lib/session-limit-text';
import { useSessionChatStore } from '../stream/session-chat-store';
import { useSessionStreamStore } from '../stream/session-stream-store';
import { useSessionListStore } from '../stream/session-list-store';

/**
 * The single copy of the session border colour map, shared with
 * {@link useAgentHottestStatus} (`use-agent-hottest-status.ts`), which
 * imports it rather than keeping its own copy.
 *
 * Border color uses inline RGB values (not CSS custom properties) for states
 * that pulse, because Motion cannot interpolate CSS custom properties — it
 * needs concrete RGB values to tween `borderLeftColor`.
 *
 * (This note used to blame an "unlayered browser-extension stylesheet" as well.
 * That rule was the app's own neutral `border-color` default in `index.css`,
 * and it is layered as of DOR-1024, so it no longer outranks anything. The
 * Motion constraint above is the whole reason these are literals.)
 *
 * Non-pulsing states (error, unseen) use CSS variables directly since
 * Motion never has to animate them.
 */
export const BORDER_COLORS = {
  green: 'rgb(34, 197, 94)',
  greenDim: 'rgba(34, 197, 94, 0.15)',
  amber: 'rgb(245, 158, 11)',
  amberDim: 'rgba(245, 158, 11, 0.15)',
  blue: 'var(--color-blue-500)',
  destructive: 'hsl(var(--destructive))',
  /** An out-of-usage session that is only waiting for its reset (Q13: not red). */
  neutral: 'var(--color-muted-foreground)',
  transparent: 'transparent',
  /** Barely-visible resting color so idle borders aren't fully invisible. */
  idle: 'rgba(128, 128, 128, 0.08)',
} as const;

/** Visual activity state derived from a session's chat store entry. */
export type SessionBorderKind =
  'idle' | 'pendingApproval' | 'streaming' | 'limited' | 'error' | 'unseen';

/** Border rendering state: color, pulse animation flag, and human-readable status. */
export interface SessionBorderState {
  /** Current visual kind, useful for non-border affordances (icons, tooltips). */
  kind: SessionBorderKind;
  /** Primary border color (CSS value). */
  color: string;
  /** Whether the border should pulse between color and dimColor. */
  pulse: boolean;
  /** Dim color target for the pulse animation. Only set when pulse is true. */
  dimColor?: string;
  /** Human-readable status string for tooltips and screen readers. */
  label: string;
}

/**
 * The words each border kind says in its tooltip and the row's accessible
 * name. Shared with {@link useAgentHottestStatus}, which reads the same map.
 */
export const BORDER_LABELS: Record<SessionBorderKind, string> = {
  idle: 'Idle',
  pendingApproval: 'Awaiting your approval',
  streaming: 'Working',
  limited: 'Out of usage',
  error: 'Error: check session',
  unseen: 'New activity',
};

/**
 * The border a session wears for its usage limit, or `null` when the limit
 * draws none: shown while `sessionDisplayState` reads `limited`, except for a
 * `moved` session and a limit on one model only (the same rule as the row's
 * text, `sessionLimitDisplay`). Red while the session needs action; the
 * neutral grey once the person chose to wait (decision Q13).
 */
function limitedBorder(
  status: Pick<SessionStatus, 'lifecycle' | 'limit'> | null | undefined
): SessionBorderState | null {
  if (!status || sessionDisplayState(status) !== 'limited') return null;
  const display = sessionLimitDisplay(status.limit);
  if (!display) return null;
  return {
    kind: 'limited',
    color: display.needsAction ? BORDER_COLORS.destructive : BORDER_COLORS.neutral,
    pulse: false,
    label: BORDER_LABELS.limited,
  };
}

/**
 * Map a projector {@link SessionLifecycle} to a border kind, or `null` when it
 * carries no actionable signal (`idle`, `interrupted`, or absent).
 */
export function borderKindFromLifecycle(
  lifecycle: SessionLifecycle | undefined
): 'streaming' | 'pendingApproval' | 'error' | null {
  switch (lifecycle) {
    case 'streaming':
      return 'streaming';
    case 'blocked':
      return 'pendingApproval';
    case 'error':
      return 'error';
    default:
      return null;
  }
}

/**
 * Derive a session's border indicator from its live projections (stream store,
 * global list store, legacy chat store — hottest signal wins).
 *
 * The border communicates **operational status** only. Selection state ("active")
 * is handled independently by the row component via background highlight.
 *
 * Priority (highest first):
 * 1. **Pending approval** — most actionable signal; must never be hidden.
 * 2. **Streaming** — agent is generating output.
 * 3. **Limited** — the session's account ran out of usage (only when the caller
 *    passes the session's status, which it does only while the account
 *    identity gate is open).
 * 4. **Error** — last turn failed.
 * 5. **Unseen** — background activity the user has not yet acknowledged.
 * 6. **Idle** — default.
 *
 * Pulse animations are suppressed when the user has requested reduced motion.
 *
 * @param sessionId - Session to observe
 * @param limitStatus - The session's live lifecycle and usage limit, for the
 *   `limited` border. Omit it (as the agent and tab dots do) to never draw one.
 */
export function useSessionBorderState(
  sessionId: string,
  limitStatus?: Pick<SessionStatus, 'lifecycle' | 'limit'> | null
): SessionBorderState {
  const status = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.status ?? 'idle', [sessionId])
  );
  const sdkRunning = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.sdkState === 'running', [sessionId])
  );
  // Unseen background settles live in the LIST store (fed by the global stream),
  // so sessions this client never visited still light up.
  const hasUnseenActivity = useSessionListStore(
    useCallback((s) => sessionId in s.unseen, [sessionId])
  );
  const legacyPendingApproval = useSessionChatStore(
    useCallback(
      (s) =>
        s.sessions[sessionId]?.sdkState === 'requires_action' ||
        (s.sessions[sessionId]?.messages.some((m) =>
          m.toolCalls?.some((tc) => tc.interactiveType && tc.status === 'pending')
        ) ??
          false),
      [sessionId]
    )
  );
  // Live projection from the per-session stream store (hydrated sessions).
  const streamKind = useSessionStreamStore(
    useCallback(
      (s) => {
        const entry = s.sessions[sessionId];
        if (!entry) return null;
        if (entry.pendingInteractions.length > 0) return 'pendingApproval' as const;
        return borderKindFromLifecycle(entry.status?.lifecycle);
      },
      [sessionId]
    )
  );
  // Lifecycle fan-out from the global `/api/events` stream (all sessions).
  const listKind = useSessionListStore(
    useCallback((s) => borderKindFromLifecycle(s.statuses[sessionId]?.lifecycle), [sessionId])
  );
  const shouldReduceMotion = useReducedMotion();

  const liveKind = streamKind ?? listKind;
  const hasPendingApproval = legacyPendingApproval || liveKind === 'pendingApproval';

  if (hasPendingApproval) {
    return {
      kind: 'pendingApproval',
      color: BORDER_COLORS.amber,
      pulse: !shouldReduceMotion,
      dimColor: BORDER_COLORS.amberDim,
      label: BORDER_LABELS.pendingApproval,
    };
  }
  if (sdkRunning || status === 'streaming' || liveKind === 'streaming') {
    return {
      kind: 'streaming',
      color: BORDER_COLORS.green,
      pulse: !shouldReduceMotion,
      dimColor: BORDER_COLORS.greenDim,
      label: BORDER_LABELS.streaming,
    };
  }
  const limited = limitedBorder(limitStatus);
  if (limited) return limited;
  if (status === 'error' || liveKind === 'error') {
    return {
      kind: 'error',
      color: BORDER_COLORS.destructive,
      pulse: false,
      label: BORDER_LABELS.error,
    };
  }
  if (hasUnseenActivity) {
    return {
      kind: 'unseen',
      color: BORDER_COLORS.blue,
      pulse: false,
      label: BORDER_LABELS.unseen,
    };
  }
  return {
    kind: 'idle',
    color: BORDER_COLORS.idle,
    pulse: false,
    label: BORDER_LABELS.idle,
  };
}
