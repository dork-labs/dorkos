import { useBrowserHandoff } from '../model/use-browser-handoff';
import { BrowserHandoffCardView } from './BrowserHandoffCardView';

/**
 * The same card, in the Inbox, for whichever handoff is open. It carries Continue
 * and Stop task, so a person can answer with the chat closed.
 */
export function BrowserHandoffInboxItem() {
  const { handoff, step, canShowWindow, busy, error, continueAgent, signIn, showWindow, stopTask } =
    useBrowserHandoff();
  if (!handoff || !step) return null;
  return (
    <div data-slot="browser-handoff-inbox-item" className="mt-2">
      <BrowserHandoffCardView
        site={handoff.site}
        agentName={handoff.agentName}
        agentFolder={handoff.agentFolder}
        step={step}
        canShowWindow={canShowWindow}
        busy={busy}
        error={error}
        onContinue={() => void continueAgent()}
        onSignIn={signIn}
        onShowWindow={showWindow}
        onStop={() => void stopTask()}
      />
    </div>
  );
}
