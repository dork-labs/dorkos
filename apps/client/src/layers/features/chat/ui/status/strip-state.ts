/**
 * What the chat status strip is showing, and the pure rule that decides it.
 *
 * No React here on purpose: the priority stack is the interesting part, and it is
 * cheaper to reason about — and to test — as one function over one input object.
 *
 * @module features/chat/ui/status/strip-state
 */
import { Info } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { IndicatorTheme } from './inference-themes';
import type { SystemStatusState, OperationProgressState } from '../../model/chat-types';

/** Discriminated union representing all possible states of the chat status strip. */
export type StripState =
  | { type: 'waiting'; waitingType: 'approval' | 'question'; elapsed: string }
  | {
      type: 'operation-progress';
      message: string;
      determinate: boolean;
      percent: number | null;
    }
  | { type: 'system-message'; message: string; icon: LucideIcon }
  | {
      type: 'streaming';
      verb: string;
      verbKey: string;
      elapsed: string;
      tokens: string;
      icon: string;
      iconAnimation: string | null;
      isBypassVerb: boolean;
    }
  | { type: 'complete'; elapsed: string; tokens: string }
  | { type: 'idle' };

/** Input shape for the deriveStripState pure function. */
export interface StripStateInput {
  status: 'idle' | 'streaming' | 'error';
  isWaitingForUser: boolean;
  waitingType: 'approval' | 'question';
  operationProgress: OperationProgressState | null;
  systemStatus: SystemStatusState | null;
  elapsed: string;
  verb: string;
  verbKey: string;
  tokens: string;
  theme: IndicatorTheme;
  isBypassVerb: boolean;
  showComplete: boolean;
  lastElapsed: string;
  lastTokens: string;
}

/** Format a token count for display (e.g. 3200 -> "~3.2k tokens"). */
export function formatTokens(count: number): string {
  if (count >= 1000) {
    return `~${(count / 1000).toFixed(1)}k tokens`;
  }
  return `~${Math.round(count)} tokens`;
}

/**
 * Derive the active strip state from raw session inputs. Pure function — no React.
 *
 * Priority stack (first match wins):
 * 1. waiting-for-user — user action required to continue
 * 2. operation-progress — a long-running operation (e.g. compaction) is running
 * 3. system-message — runtime operational event (e.g. a hook), informational
 * 4. streaming — normal inference in progress
 * 5. complete — post-stream summary, auto-dismisses
 * 6. idle — nothing to show
 *
 * @param input - Everything the priority stack reads.
 */
export function deriveStripState(input: StripStateInput): StripState {
  // Priority 1: Waiting for user
  if (input.status === 'streaming' && input.isWaitingForUser) {
    return { type: 'waiting', waitingType: input.waitingType, elapsed: input.elapsed };
  }

  // Priority 2: Operation progress (compaction) — the structured, runtime-agnostic
  // progress treatment (DOR-110), shown regardless of streaming status. The
  // producer supplies the label copy, so there is no status string to match.
  if (input.operationProgress) {
    const { message, determinate, percent } = input.operationProgress;
    return {
      type: 'operation-progress',
      message: message ?? 'Working…',
      determinate,
      percent: percent ?? null,
    };
  }

  // Priority 3: System message (shown regardless of streaming status)
  if (input.systemStatus) {
    return {
      type: 'system-message',
      message: input.systemStatus.message,
      icon: Info,
    };
  }

  // Priority 4: Streaming
  if (input.status === 'streaming') {
    return {
      type: 'streaming',
      verb: input.verb,
      verbKey: input.verbKey,
      elapsed: input.elapsed,
      tokens: input.tokens,
      icon: input.isBypassVerb ? '\u2620' : input.theme.icon,
      iconAnimation: input.isBypassVerb ? null : input.theme.iconAnimation,
      isBypassVerb: input.isBypassVerb,
    };
  }

  // Priority 5: Complete (auto-dismisses)
  if (input.showComplete) {
    return { type: 'complete', elapsed: input.lastElapsed, tokens: input.lastTokens };
  }

  // Priority 6: Idle
  return { type: 'idle' };
}
