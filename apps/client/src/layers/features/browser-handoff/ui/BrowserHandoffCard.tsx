import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { receiptSwapTransition } from '../lib/receipt-swap';
import { useBrowserHandoff } from '../model/use-browser-handoff';
import { BrowserHandoffCardView } from './BrowserHandoffCardView';
import { BrowserHandoffReceipt } from './BrowserHandoffReceipt';

/** Props for {@link BrowserHandoffCard}. */
export interface BrowserHandoffCardProps {
  /** The chat this card sits in. It shows only that chat's handoff. */
  sessionId: string | null;
}

/**
 * The live handoff card for a chat. Draws nothing unless that chat's agent is waiting
 * on a person, or a handoff it showed has just ended and leaves its one-line receipt.
 */
export function BrowserHandoffCard({ sessionId }: BrowserHandoffCardProps) {
  const {
    handoff,
    ended,
    step,
    canShowWindow,
    movesToOwnWindow,
    sharedProfile,
    busy,
    error,
    continueAgent,
    signIn,
    openWindow,
    showWindow,
    stopTask,
  } = useBrowserHandoff(sessionId);
  const reducedMotion = useReducedMotion();
  const swap = receiptSwapTransition(reducedMotion);
  return (
    <AnimatePresence>
      {sessionId && handoff && step && (
        // The same entrance as the composer's background task bar. On the way out its
        // height collapses as the receipt fades in, so the composer settles, not jumps.
        <motion.div
          key={handoff.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, height: 0, transition: swap }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden"
        >
          <BrowserHandoffCardView
            site={handoff.site}
            agentName={handoff.agentName}
            agentFolder={handoff.agentFolder}
            step={step}
            canShowWindow={canShowWindow}
            movesToOwnWindow={movesToOwnWindow}
            sharedProfile={sharedProfile}
            busy={busy}
            error={error}
            onContinue={() => void continueAgent()}
            onSignIn={signIn}
            onOpenWindow={openWindow}
            onShowWindow={showWindow}
            onStop={() => void stopTask()}
          />
        </motion.div>
      )}
      {sessionId && !handoff && ended?.outcome && (
        <motion.div
          key={`${ended.id}-ended`}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={swap}
          className="overflow-hidden"
        >
          <BrowserHandoffReceipt agentName={ended.agentName} outcome={ended.outcome} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
