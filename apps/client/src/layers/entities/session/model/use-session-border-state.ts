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
 * @module entities/session/model/use-session-border-state
 */
import { useCallback } from 'react';
import { useReducedMotion } from 'motion/react';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import { useSessionChatStore } from './session-chat-store';
import { useSessionStreamStore } from './session-stream-store';
import { useSessionListStore } from './session-list-store';

/*
 * Border color uses inline RGB values (not CSS custom properties) for states that
 * pulse. An unlayered browser-extension stylesheet
 * (`:where(:not(.copilot-view-content *))`) overrides all Tailwind border-color
 * utilities in `@layer utilities`, and Motion cannot interpolate CSS custom
 * properties — it needs concrete RGB values to tween `borderLeftColor`.
 *
 * Non-pulsing states (error, unseen) use CSS variables directly since
 * Motion never has to animate them.
 */
const BORDER_COLORS = {
  green: 'rgb(34, 197, 94)',
  greenDim: 'rgba(34, 197, 94, 0.15)',
  amber: 'rgb(245, 158, 11)',
  amberDim: 'rgba(245, 158, 11, 0.15)',
  blue: 'var(--color-blue-500)',
  destructive: 'hsl(var(--destructive))',
  transparent: 'transparent',
  /** Barely-visible resting color so idle borders aren't fully invisible. */
  idle: 'rgba(128, 128, 128, 0.08)',
} as const;

/** Visual activity state derived from a session's chat store entry. */
export type SessionBorderKind = 'idle' | 'pendingApproval' | 'streaming' | 'error' | 'unseen';

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

const LABELS: Record<SessionBorderKind, string> = {
  idle: 'Idle',
  pendingApproval: 'Awaiting your approval',
  streaming: 'Working',
  error: 'Error — check session',
  unseen: 'New activity',
};

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
 * 3. **Error** — last turn failed.
 * 4. **Unseen** — background activity the user has not yet acknowledged.
 * 5. **Idle** — default.
 *
 * Pulse animations are suppressed when the user has requested reduced motion.
 *
 * @param sessionId - Session to observe
 */
export function useSessionBorderState(sessionId: string): SessionBorderState {
  const status = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.status ?? 'idle', [sessionId])
  );
  const sdkRunning = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.sdkState === 'running', [sessionId])
  );
  const hasUnseenActivity = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.hasUnseenActivity ?? false, [sessionId])
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
      label: LABELS.pendingApproval,
    };
  }
  if (sdkRunning || status === 'streaming' || liveKind === 'streaming') {
    return {
      kind: 'streaming',
      color: BORDER_COLORS.green,
      pulse: !shouldReduceMotion,
      dimColor: BORDER_COLORS.greenDim,
      label: LABELS.streaming,
    };
  }
  if (status === 'error' || liveKind === 'error') {
    return {
      kind: 'error',
      color: BORDER_COLORS.destructive,
      pulse: false,
      label: LABELS.error,
    };
  }
  if (hasUnseenActivity) {
    return {
      kind: 'unseen',
      color: BORDER_COLORS.blue,
      pulse: false,
      label: LABELS.unseen,
    };
  }
  return {
    kind: 'idle',
    color: BORDER_COLORS.idle,
    pulse: false,
    label: LABELS.idle,
  };
}
