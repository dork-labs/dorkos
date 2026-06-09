import { ShieldX } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

interface PermissionDeniedChipProps {
  /** Name of the tool that was denied (e.g. `'Bash'`). */
  toolName: string;
  /** Discriminator for why the call was denied — `'classifier'` gets classifier-specific copy. */
  reasonType?: string;
  /** Human-readable reason from the deciding component, when available. */
  reason?: string;
  /** The rejection message returned to the model — fallback when `reason` is absent. */
  message: string;
}

/**
 * Read-only chip in the message stream marking a tool call denied before
 * execution by the auto-mode safety classifier.
 *
 * Distinct from a user denial (which uses the destructive ToolApproval flow):
 * this is a passive, system-issued record with no actions and no re-approval
 * path. The muted shield styling signals "automated block" rather than "error".
 */
export function PermissionDeniedChip({
  toolName,
  reasonType,
  reason,
  message,
}: PermissionDeniedChipProps) {
  const isClassifier = reasonType === 'classifier';
  const detail = reason || message;
  const label = isClassifier ? `Blocked by auto-mode classifier: ${detail}` : `Blocked: ${detail}`;

  return (
    <div
      data-testid="permission-denied-chip"
      data-reason-type={reasonType}
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
        <p className="text-muted-foreground mt-0.5 font-mono text-xs">{toolName}</p>
      </div>
    </div>
  );
}
