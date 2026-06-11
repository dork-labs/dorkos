import { useCallback } from 'react';
import { useReducedMotion } from 'motion/react';
import { useSessionChatStore } from './session-chat-store';
import { useSessionStreamStore } from './session-stream-store';
import { useSessionListStore } from './session-list-store';
import {
  borderKindFromLifecycle,
  type SessionBorderKind,
  type SessionBorderState,
} from './use-session-border-state';

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
  pendingApproval: 'Awaiting your approval',
  streaming: 'Working',
  error: 'Error — check session',
  unseen: 'New activity',
};

/** Priority ranking for border states (higher = hotter). */
const PRIORITY: Record<SessionBorderKind, number> = {
  idle: 0,
  unseen: 1,
  error: 2,
  streaming: 3,
  pendingApproval: 4,
};

/** Fold a candidate kind into the running hottest result. */
function hotter(result: SessionBorderKind, candidate: SessionBorderKind | null): SessionBorderKind {
  if (candidate && PRIORITY[candidate] > PRIORITY[result]) return candidate;
  return result;
}

/**
 * Derive the "hottest" border state across all sessions for an agent.
 *
 * Merges three sources and returns the highest-priority status (same merge as
 * {@link useSessionBorderState}, scanned across many sessions):
 *
 * 1. **Legacy chat store** — send-path/recovery state for `sessionIds`.
 * 2. **Per-session stream store** — hydrated sessions among `sessionIds`.
 * 3. **Global session-list store** — `session_status` lifecycle fan-outs, by
 *    id AND by `agentPath` cwd match. The cwd match is what lets a COLLAPSED
 *    agent row light up: the sidebar only fetches session metadata for the
 *    active agent (`sessionIds` is empty otherwise), but the status fan-out
 *    carries every live session's cwd regardless.
 *
 * @param sessionIds - Session IDs to check (from the agent's session list)
 * @param agentPath - The agent's working directory; enables fleet-wide cwd matching
 */
export function useAgentHottestStatus(
  sessionIds: string[],
  agentPath?: string
): SessionBorderState {
  const shouldReduceMotion = useReducedMotion();

  const legacyHottest = useSessionChatStore(
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
            result = hotter(result, 'streaming');
          }

          // Check error
          if (session.status === 'error') {
            result = hotter(result, 'error');
          }

          // Check unseen
          if (session.hasUnseenActivity) {
            result = hotter(result, 'unseen');
          }
        }
        return result;
      },
      [sessionIds]
    )
  );

  const streamHottest = useSessionStreamStore(
    useCallback(
      (s) => {
        let result: SessionBorderKind = 'idle';
        for (const id of sessionIds) {
          const entry = s.sessions[id];
          if (!entry) continue;
          if (entry.pendingInteractions.length > 0) return 'pendingApproval' as const;
          result = hotter(result, borderKindFromLifecycle(entry.status?.lifecycle));
        }
        return result;
      },
      [sessionIds]
    )
  );

  const listHottest = useSessionListStore(
    useCallback(
      (s) => {
        let result: SessionBorderKind = 'idle';
        for (const id of sessionIds) {
          result = hotter(result, borderKindFromLifecycle(s.statuses[id]?.lifecycle));
        }
        if (agentPath) {
          for (const [id, cwd] of Object.entries(s.statusCwds)) {
            if (cwd !== agentPath) continue;
            result = hotter(result, borderKindFromLifecycle(s.statuses[id]?.lifecycle));
          }
        }
        return result;
      },
      [sessionIds, agentPath]
    )
  );

  const hottest = hotter(hotter(legacyHottest, streamHottest), listHottest);
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
