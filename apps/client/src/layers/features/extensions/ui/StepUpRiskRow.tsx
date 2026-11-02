import type { StepUpExtensionRisk } from '@dorkos/shared/step-up';
import { useMoveExtensionOut } from '@/layers/entities/extension';

interface StepUpRiskRowProps {
  /** Why it keeps confirming off. */
  risk: StepUpExtensionRisk;
  /** The extension's id. */
  id: string;
  /** Its name, for the toast. */
  name: string;
  /** Turn it off: the card's own toggle. */
  onTurnOff: () => void;
  /** Whether the toggle is busy. */
  isToggling: boolean;
}

/**
 * Why this mini app keeps "Confirm it's you" off, and the fix (DOR-3234,
 * Must 3). A mini app in an agent's folder moves out; a changed one is turned
 * off, or approved again on its approval card.
 */
export function StepUpRiskRow({ risk, id, name, onTurnOff, isToggling }: StepUpRiskRowProps) {
  const move = useMoveExtensionOut();
  const agent = risk.agentName ?? 'an agent';
  const busy = move.isPending || isToggling;
  return (
    <div
      className="text-status-warning-fg flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
      data-testid={`extension-step-up-risk-${id}`}
    >
      <p>
        {risk.reason === 'agent-folder'
          ? `${agent} can edit this, so confirming is off.`
          : 'Changed since you approved it, so confirming is off.'}
      </p>
      {risk.reason === 'agent-folder' ? (
        <button
          type="button"
          onClick={() => move.mutate({ id, name })}
          disabled={busy}
          className="text-muted-foreground hover:text-foreground focus-ring rounded-sm text-xs underline underline-offset-2 disabled:opacity-50"
        >
          Move out of {agent}’s folder
        </button>
      ) : (
        <button
          type="button"
          onClick={onTurnOff}
          disabled={busy}
          className="text-muted-foreground hover:text-foreground focus-ring rounded-sm text-xs underline underline-offset-2 disabled:opacity-50"
        >
          Turn off
        </button>
      )}
    </div>
  );
}
