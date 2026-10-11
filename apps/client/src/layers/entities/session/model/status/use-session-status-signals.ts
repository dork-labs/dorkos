/**
 * A session's live status facts, read from its projections, and the shared
 * border vocabulary (colours, kinds, labels) an agent row's hottest status is
 * drawn in.
 *
 * Three sources are merged (spec chat-stream-reconnection):
 *
 * 1. **Per-session stream store** — the seq-gated projection for sessions this
 *    client has hydrated (foreground + recently attached).
 * 2. **Global session-list store** — `session_status` lifecycle fan-outs on
 *    `/api/events`, covering sessions this client never attached (background
 *    work, other windows, other agents).
 * 3. **Legacy chat store** — the send-path/recovery state, kept as a source
 *    until the dual-pipeline retirement.
 *
 * @module entities/session/model/status/use-session-status-signals
 */
import { useCallback } from 'react';
import {
  sessionDisplayState,
  type SessionLifecycle,
  type SessionStatus,
} from '@dorkos/shared/session-stream';
import { sessionLimitDisplay, type SessionLimitDisplay } from '../../lib/session-limit-text';
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
  error: 'Error: check chat',
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
 * Every live fact about one session's status, before any of them is chosen.
 *
 * The border picks one of these in its own order (below); the desktop tab
 * strip picks in another (`pickTabStatus`, DOR-2820), because a tab says
 * "failed" and "paused" ahead of "working". Both read these same facts, so
 * neither can see a state the other misses.
 */
export interface SessionStatusSignals {
  /** A pending approval or question is waiting on a person. */
  needsYou: boolean;
  /** A turn is streaming right now. */
  working: boolean;
  /**
   * The session's usage limit, as the row's text reads it, or `null` when the
   * limit draws nothing (see {@link limitDisplayFor}).
   */
  limited: SessionLimitDisplay | null;
  /** The last turn failed. */
  failed: boolean;
  /** Background work settled while nobody was looking. */
  unseen: boolean;
}

/**
 * How a session's usage limit reads while `sessionDisplayState` says
 * `limited`, or `null` when it draws nothing: a `moved` session and a limit on
 * one model only (the same rule as the row's text, `sessionLimitDisplay`).
 */
function limitDisplayFor(
  status: Pick<SessionStatus, 'lifecycle' | 'limit'> | null | undefined
): SessionLimitDisplay | null {
  if (!status || sessionDisplayState(status) !== 'limited') return null;
  return sessionLimitDisplay(status.limit);
}

/**
 * Read a session's live status facts from its projections (stream store,
 * global list store, legacy chat store), unranked.
 *
 * @param sessionId - Session to observe
 * @param limitStatus - The session's live lifecycle and usage limit. Omit it
 *   and `limited` is always `null`.
 */
export function useSessionStatusSignals(
  sessionId: string,
  limitStatus?: Pick<SessionStatus, 'lifecycle' | 'limit'> | null
): SessionStatusSignals {
  const status = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.status ?? 'idle', [sessionId])
  );
  const sdkRunning = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.sdkState === 'running', [sessionId])
  );
  // Unseen background settles live in the LIST store (fed by the global stream),
  // so sessions this client never visited still light up.
  const unseen = useSessionListStore(useCallback((s) => sessionId in s.unseen, [sessionId]));
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

  const liveKind = streamKind ?? listKind;
  return {
    needsYou: legacyPendingApproval || liveKind === 'pendingApproval',
    working: sdkRunning || status === 'streaming' || liveKind === 'streaming',
    limited: limitDisplayFor(limitStatus),
    failed: status === 'error' || liveKind === 'error',
    unseen,
  };
}
