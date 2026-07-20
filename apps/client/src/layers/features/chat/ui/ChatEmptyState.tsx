/**
 * The empty chat session's message: the four mutually-exclusive things a
 * session with no messages can show, resolved in priority order via early
 * returns (never a nested ternary — see `conventions.md`).
 *
 *   1. A newborn agent's greeting failed → an honest, actionable line.
 *   2. A newborn agent is waking up (first light) → its face, name, and dots.
 *   3. DorkBot's one-time welcome → the shared-layout welcome card.
 *   4. Otherwise → the generic invitation to start typing.
 *
 * Purely presentational: the caller owns the store reads and derives the four
 * inputs, so this component is a dumb switch over already-resolved state.
 *
 * @module features/chat/ui/ChatEmptyState
 */
import { motion } from 'motion/react';
import type { AgentBirthRecord } from '@/layers/shared/model';
import { FirstLight } from './FirstLight';

/** Inputs for {@link ChatEmptyState}. */
export interface ChatEmptyStateProps {
  /**
   * The active session's birth record, or null. Drives the greeting-failed
   * line (when `greetingFailed` is set) — the failed newborn's honest message.
   */
  birthRecord: AgentBirthRecord | null;
  /**
   * The birth record when the newborn's opening turn is genuinely in flight
   * (first light), or null. Already gated on the fire latch and hydration by
   * the caller — presence alone means "show first light".
   */
  firstLightRecord: AgentBirthRecord | null;
  /** DorkBot's one-shot first-run welcome message, or null. */
  dorkbotFirstMessage: string | null;
  /** Clear the DorkBot welcome once its shared-layout animation settles. */
  onDorkbotWelcomeShown: () => void;
}

/**
 * The message shown when a chat session has no messages yet.
 *
 * @param props - The four resolved empty-state inputs (see {@link ChatEmptyStateProps}).
 */
export function ChatEmptyState({
  birthRecord,
  firstLightRecord,
  dorkbotFirstMessage,
  onDorkbotWelcomeShown,
}: ChatEmptyStateProps) {
  // A newborn agent's auto-first-turn greeting couldn't be delivered (M4): say
  // so honestly and point at what to do, rather than a blank screen or a dead
  // Retry button.
  if (birthRecord?.greetingFailed === true) {
    return (
      <div className="text-center" data-testid="greeting-failed-empty">
        <p className="text-muted-foreground text-base">
          {birthRecord.displayName} couldn&rsquo;t say hello just now
        </p>
        <p className="text-muted-foreground/60 mt-2 text-sm">Send a message to get started.</p>
      </div>
    );
  }

  // The newborn's opening turn is in flight (M4) — show it waking up.
  if (firstLightRecord) {
    return <FirstLight record={firstLightRecord} />;
  }

  // DorkBot's one-time welcome, handed off from the sidebar via a shared layout.
  if (dorkbotFirstMessage) {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <motion.div
          layoutId="dorkbot-first-message"
          className="bg-muted/50 w-full max-w-md rounded-lg border p-4"
          data-testid="dorkbot-welcome-message"
          onLayoutAnimationComplete={onDorkbotWelcomeShown}
        >
          <p className="text-muted-foreground text-sm">{dorkbotFirstMessage}</p>
        </motion.div>
        <p className="text-muted-foreground/60 text-sm">Type a message below to begin</p>
      </div>
    );
  }

  return (
    <div className="text-center">
      <p className="text-muted-foreground text-base">Start a conversation</p>
      <p className="text-muted-foreground/60 mt-2 text-sm">Type a message below to begin</p>
    </div>
  );
}
