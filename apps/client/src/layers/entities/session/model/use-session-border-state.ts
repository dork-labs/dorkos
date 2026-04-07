/**
 * Derives a session's sidebar border indicator state from the session chat store.
 *
 * @module entities/session/model/use-session-border-state
 */
import { useCallback } from 'react';
import { useReducedMotion } from 'motion/react';
import { useSessionChatStore } from './session-chat-store';

/*
 * Border color uses inline RGB values (not CSS custom properties) for states that
 * pulse. An unlayered browser-extension stylesheet
 * (`:where(:not(.copilot-view-content *))`) overrides all Tailwind border-color
 * utilities in `@layer utilities`, and Motion cannot interpolate CSS custom
 * properties — it needs concrete RGB values to tween `borderLeftColor`.
 *
 * Non-pulsing states (active, error, unseen) use CSS variables directly since
 * Motion never has to animate them.
 */
const BORDER_COLORS = {
  green: 'rgb(34, 197, 94)',
  greenDim: 'rgba(34, 197, 94, 0.15)',
  amber: 'rgb(245, 158, 11)',
  amberDim: 'rgba(245, 158, 11, 0.15)',
  blue: 'var(--color-blue-500)',
  destructive: 'hsl(var(--destructive))',
  primary: 'hsl(var(--primary))',
  transparent: 'transparent',
} as const;

/** Visual activity state derived from a session's chat store entry. */
export type SessionBorderKind =
  | 'idle'
  | 'active'
  | 'pendingApproval'
  | 'streaming'
  | 'error'
  | 'unseen';

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
  active: 'Active session',
  pendingApproval: 'Awaiting your approval',
  streaming: 'Streaming response',
  error: 'Error — check session',
  unseen: 'New activity',
};

/**
 * Derive a session's border indicator from its live chat store state.
 *
 * Priority (highest first):
 * 1. **Pending approval** — beats everything, including active. A blocked session
 *    is the most actionable signal in the UI; hiding it under the active highlight
 *    would mean users miss approval requests while the session is focused.
 * 2. **Active** — currently selected session.
 * 3. **Streaming** — agent is generating output.
 * 4. **Error** — last turn failed.
 * 5. **Unseen** — background activity the user has not yet acknowledged.
 * 6. **Idle** — default.
 *
 * Pulse animations are suppressed when the user has requested reduced motion.
 *
 * @param sessionId - Session to observe in the chat store
 * @param isActive - Whether this session is currently focused in the UI
 */
export function useSessionBorderState(sessionId: string, isActive: boolean): SessionBorderState {
  const status = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.status ?? 'idle', [sessionId])
  );
  const sdkRunning = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.sdkState === 'running', [sessionId])
  );
  const hasUnseenActivity = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.hasUnseenActivity ?? false, [sessionId])
  );
  const hasPendingApproval = useSessionChatStore(
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
  const shouldReduceMotion = useReducedMotion();

  // Pending approval outranks active — the user must see this even on the focused row.
  if (hasPendingApproval) {
    return {
      kind: 'pendingApproval',
      color: BORDER_COLORS.amber,
      pulse: !shouldReduceMotion,
      dimColor: BORDER_COLORS.amberDim,
      label: LABELS.pendingApproval,
    };
  }
  if (isActive) {
    return {
      kind: 'active',
      color: BORDER_COLORS.primary,
      pulse: false,
      label: LABELS.active,
    };
  }
  if (sdkRunning || status === 'streaming') {
    return {
      kind: 'streaming',
      color: BORDER_COLORS.green,
      pulse: !shouldReduceMotion,
      dimColor: BORDER_COLORS.greenDim,
      label: LABELS.streaming,
    };
  }
  if (status === 'error') {
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
    color: BORDER_COLORS.transparent,
    pulse: false,
    label: LABELS.idle,
  };
}
