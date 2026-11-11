import { useBrowserHandoff } from '../model/use-browser-handoff';
import { BrowserHandoffCardView } from './BrowserHandoffCardView';
import { BrowserHandoffReceipt } from './BrowserHandoffReceipt';

/**
 * The same card, in the Inbox, for whichever handoff is open. It carries Continue
 * and Stop task, so a person can answer with the chat closed. Once one it showed
 * ends, it leaves the same one-line receipt as the chat's card.
 */
export function BrowserHandoffInboxItem() {
  const {
    handoff,
    ended,
    step,
    canShowWindow,
    sharedProfile,
    busy,
    error,
    continueAgent,
    signIn,
    openWindow,
    showWindow,
    stopTask,
  } = useBrowserHandoff();
  if (!handoff && ended?.outcome)
    return (
      <div data-slot="browser-handoff-inbox-item" className="mt-2">
        <BrowserHandoffReceipt agentName={ended.agentName} outcome={ended.outcome} />
      </div>
    );
  if (!handoff || !step) return null;
  return (
    <div data-slot="browser-handoff-inbox-item" className="mt-2">
      <BrowserHandoffCardView
        site={handoff.site}
        agentName={handoff.agentName}
        agentFolder={handoff.agentFolder}
        step={step}
        canShowWindow={canShowWindow}
        sharedProfile={sharedProfile}
        busy={busy}
        error={error}
        onContinue={() => void continueAgent()}
        onSignIn={signIn}
        onOpenWindow={openWindow}
        onShowWindow={showWindow}
        onStop={() => void stopTask()}
      />
    </div>
  );
}
