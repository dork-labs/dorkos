import { ShieldX } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

interface PermissionDeniedChipProps {
  /** Name of the tool that was denied (e.g. `'Bash'`). */
  toolName: string;
  /** Discriminator for why the call was denied — `'classifier'` and `'asyncAgent'` get their own copy. */
  reasonType?: string;
  /** Human-readable reason from the deciding component, when available. */
  reason?: string;
  /** The rejection message returned to the model — fallback when `reason` is absent. */
  message: string;
  /**
   * The runtime's id for the helper that made the call, when it was not the main
   * agent. Present, it turns the chip from "something was blocked" into "THIS
   * helper was blocked", which for a backgrounded helper is the only place the
   * loss is ever named.
   */
  agentId?: string;
}

/**
 * How much of a runtime's opaque helper id to show.
 *
 * Enough to tell two helpers in one turn apart, short enough to read as a label
 * rather than a wall. The id means nothing outside the run that minted it, so
 * there is nothing to look it up in and no reason to print all of it.
 */
const AGENT_ID_DISPLAY_LENGTH = 8;

/**
 * Read-only chip in the message stream marking a tool call denied before
 * execution — by the auto-mode safety classifier, a deny rule, or because the
 * helper that asked was running in the background with nobody to ask.
 *
 * Distinct from a user denial (which uses the destructive ToolApproval flow):
 * this is a passive, system-issued record with no actions and no re-approval
 * path. The muted shield styling signals "automated block" rather than "error".
 *
 * The background case (`reasonType === 'asyncAgent'`) is why the chip says who
 * as well as what. A helper the agent sends off to work on its own writes its
 * refusals into its own notes, which nobody reads — so this line in the main
 * conversation is the only warning that a piece of the work never happened.
 */
export function PermissionDeniedChip({
  toolName,
  reasonType,
  reason,
  message,
  agentId,
}: PermissionDeniedChipProps) {
  const detail = reason || message;
  const isClassifier = reasonType === 'classifier';
  const isBackgroundHelper = reasonType === 'asyncAgent';
  // Named when the runtime said who; "a background helper" only when it did not
  // and the reason itself proves one was involved. Never invented otherwise —
  // an unattributed denial happened on the main thread.
  const who =
    agentId !== undefined
      ? `Helper ${agentId.slice(0, AGENT_ID_DISPLAY_LENGTH)}`
      : isBackgroundHelper
        ? 'A background helper'
        : null;
  const by = isClassifier ? ' by the auto-mode classifier' : '';
  const label =
    who !== null
      ? `${who} was blocked from using ${toolName}${by}: ${detail}`
      : isClassifier
        ? `Blocked by auto-mode classifier: ${detail}`
        : `Blocked: ${detail}`;

  return (
    <div
      data-testid="permission-denied-chip"
      data-reason-type={reasonType}
      data-agent-id={agentId}
      className={cn(
        'my-2 flex items-start gap-2 rounded-md border px-3 py-2',
        'text-foreground border-amber-500/30 bg-amber-500/5'
      )}
    >
      <ShieldX
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        {isBackgroundHelper ? (
          <p className="text-muted-foreground mt-0.5 text-xs">
            Helpers running in the background can&rsquo;t ask you to approve anything, so this was
            turned down for you. Run this step yourself, or ask the agent to do it in the
            foreground.
          </p>
        ) : null}
        <p className="text-muted-foreground mt-0.5 font-mono text-xs">{toolName}</p>
      </div>
    </div>
  );
}
