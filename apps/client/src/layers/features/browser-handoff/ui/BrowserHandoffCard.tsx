import { useBrowserHandoff } from '../model/use-browser-handoff';
import { BrowserHandoffCardView } from './BrowserHandoffCardView';
import { BrowserHandoffReceipt } from './BrowserHandoffReceipt';
import { BrowserHandoffSlot } from './BrowserHandoffSlot';

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
  const card =
    sessionId && handoff && step
      ? {
          key: handoff.id,
          node: (
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
          ),
        }
      : null;
  const receipt =
    sessionId && ended?.outcome
      ? {
          key: `${ended.id}-ended`,
          node: <BrowserHandoffReceipt agentName={ended.agentName} outcome={ended.outcome} />,
        }
      : null;
  return <BrowserHandoffSlot card={card} receipt={receipt} />;
}
