import { useCallback } from 'react';
import { useReducedMotion } from 'motion/react';
import { useSessionChatStore } from './session-chat-store';
import type { SessionBorderKind, SessionBorderState } from './use-session-border-state';

const BORDER_COLORS = {
  green: 'rgb(34, 197, 94)',
  greenDim: 'rgba(34, 197, 94, 0.15)',
  amber: 'rgb(245, 158, 11)',
  amberDim: 'rgba(245, 158, 11, 0.15)',
  transparent: 'transparent',
  /** Barely-visible resting color so idle borders aren't fully invisible. */
  idle: 'rgba(128, 128, 128, 0.08)',
} as const;

const LABELS: Record<SessionBorderKind, string> = {
  idle: 'Idle',
  active: 'Active session',
  pendingApproval: 'Awaiting your approval',
  streaming: 'Streaming response',
  error: 'Error — check session',
  unseen: 'New activity',
};

/** Priority ranking for border states (higher = hotter). */
const PRIORITY: Record<SessionBorderKind, number> = {
  idle: 0,
  unseen: 1,
  error: 2,
  streaming: 3,
  active: 4,
  pendingApproval: 5,
};

/**
 * Derive the "hottest" border state across all sessions for an agent.
 *
 * Scans the session chat store for the given session IDs and returns the
 * highest-priority status. Useful for showing aggregate agent status in
 * the dashboard sidebar when sessions are collapsed.
 *
 * @param sessionIds - Session IDs to check (from the agent's session list)
 */
export function useAgentHottestStatus(sessionIds: string[]): SessionBorderState {
  const shouldReduceMotion = useReducedMotion();

  const hottest = useSessionChatStore(
    useCallback(
      (s) => {
        let result: SessionBorderKind = 'idle';
        for (const id of sessionIds) {
          const session = s.sessions[id];
          if (!session) continue;

          // Check pending approval (highest priority — early return)
          if (
            session.sdkState === 'requires_action' ||
            session.messages.some((m) =>
              m.toolCalls?.some((tc) => tc.interactiveType && tc.status === 'pending')
            )
          ) {
            return 'pendingApproval' as const;
          }

          // Check streaming
          if (session.sdkState === 'running' || session.status === 'streaming') {
            if (PRIORITY.streaming > PRIORITY[result]) result = 'streaming';
          }

          // Check error
          if (session.status === 'error') {
            if (PRIORITY.error > PRIORITY[result]) result = 'error';
          }

          // Check unseen
          if (session.hasUnseenActivity) {
            if (PRIORITY.unseen > PRIORITY[result]) result = 'unseen';
          }
        }
        return result;
      },
      [sessionIds]
    )
  );

  return toBorderState(hottest, !shouldReduceMotion);
}

function toBorderState(kind: SessionBorderKind, allowPulse: boolean): SessionBorderState {
  switch (kind) {
    case 'pendingApproval':
      return {
        kind,
        color: BORDER_COLORS.amber,
        pulse: allowPulse,
        dimColor: BORDER_COLORS.amberDim,
        label: LABELS.pendingApproval,
      };
    case 'streaming':
      return {
        kind,
        color: BORDER_COLORS.green,
        pulse: allowPulse,
        dimColor: BORDER_COLORS.greenDim,
        label: LABELS.streaming,
      };
    case 'error':
      return { kind, color: 'hsl(var(--destructive))', pulse: false, label: LABELS.error };
    case 'unseen':
      return { kind, color: 'var(--color-blue-500)', pulse: false, label: LABELS.unseen };
    default:
      return { kind: 'idle', color: BORDER_COLORS.idle, pulse: false, label: LABELS.idle };
  }
}
