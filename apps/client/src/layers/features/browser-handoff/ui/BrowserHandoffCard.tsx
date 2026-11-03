import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useBrowserHandoff } from '../model/use-browser-handoff';
import { BrowserHandoffCardView } from './BrowserHandoffCardView';

/** Props for {@link BrowserHandoffCard}. */
export interface BrowserHandoffCardProps {
  /** The chat this card sits in. It shows only that chat's handoff. */
  sessionId: string | null;
}

/** The live handoff card for a chat. Draws nothing unless that chat's agent is waiting on a person. */
export function BrowserHandoffCard({ sessionId }: BrowserHandoffCardProps) {
  const {
    handoff,
    step,
    canShowWindow,
    movesToOwnWindow,
    sharedProfile,
    busy,
    error,
    continueAgent,
    signIn,
    showWindow,
    stopTask,
  } = useBrowserHandoff(sessionId);
  const reducedMotion = useReducedMotion();
  return (
    <AnimatePresence>
      {sessionId && handoff && step && (
        // The same entrance and exit as the composer's background task bar.
        <motion.div
          key={handoff.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
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
            onShowWindow={showWindow}
            onStop={() => void stopTask()}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
