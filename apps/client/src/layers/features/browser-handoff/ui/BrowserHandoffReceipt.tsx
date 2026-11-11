import type { LocalBrowserHandoffOutcome } from '@dorkos/shared/local-browser';
import { cardAgentName } from '../lib/agent-name';

/** Props for {@link BrowserHandoffReceipt}. */
export interface BrowserHandoffReceiptProps {
  /** The agent's name the handoff carried, or null when it carried none. */
  agentName: string | null;
  /** How the handoff ended. */
  outcome: LocalBrowserHandoffOutcome;
}

/** The one line each ending leaves behind. */
function receiptLine(outcome: LocalBrowserHandoffOutcome, name: string): string {
  if (outcome === 'handed-back') return `${name} is carrying on.`;
  if (outcome === 'window-closed') return `The window closed. ${name} stopped here.`;
  return `Stopped. ${name} won’t carry on with this.`;
}

/**
 * What a handoff card becomes once it ends (DOR-3112): one quiet, neutral line and
 * no buttons, so the person sees what happened without anything left to answer.
 * Pure, so the Dev Playground can show each ending.
 */
export function BrowserHandoffReceipt({ agentName, outcome }: BrowserHandoffReceiptProps) {
  return (
    <p
      role="status"
      data-slot="browser-handoff-receipt"
      className="text-muted-foreground mb-2 rounded-xl border px-3 py-2 text-sm"
    >
      {receiptLine(outcome, cardAgentName(agentName))}
    </p>
  );
}
