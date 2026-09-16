import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/layers/shared/ui';
import { formatMicro } from '../lib/micro';
import { useCloudNudge } from '../model/use-cloud-plan';

/**
 * The upgrade nudge — one comparison the service already worked out.
 *
 * Four rules, all of them load-bearing:
 *
 * 1. **It renders only what it is given.** The subtraction arrives reduced;
 *    nothing here multiplies, compares or infers. The suggested plan is named by
 *    the service's `suggestedPlanDisplayName` and identified by an opaque id the
 *    app never reads.
 * 2. **No payload, no nudge.** The route sits behind a server flag and answers
 *    404 until it is on, which arrives here as `available: false` and renders
 *    nothing — not an empty box, not a placeholder.
 * 3. **Dismissible, and the contract insists on it.** `dismissible` is a literal
 *    `true` on the wire; the close button is not optional decoration.
 * 4. **It never stands between the person and a top-up.** It is a strip ABOVE
 *    the surface, with no action of its own and nothing to click through — the
 *    one thing a nudge must not do is make paying harder than not paying.
 */
export function UpgradeNudge() {
  const { data } = useCloudNudge();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !data?.available) return null;

  const { nudge } = data;
  const saving = formatMicro(nudge.savingMicro);
  const spent = formatMicro(nudge.trailing30Micro);
  const price = formatMicro(nudge.suggestedPlanPriceMicro);
  if (saving === null || spent === null || price === null) return null;

  return (
    <div className="bg-muted/50 flex items-start justify-between gap-3 rounded-md border px-3 py-2">
      {/* Figures carry no currency symbol because the wire carries no currency
          code, so each one is named rather than dropped into a sentence where a
          bare number reads as an unfinished string. */}
      <p className="text-sm">
        Your last 30 days: {spent}. {nudge.suggestedPlanDisplayName}: {price}. Difference: {saving}.
      </p>
      {/* Read, not assumed. The contract pins `dismissible` to a literal `true`
          today, so a payload that ever said otherwise would be a contract
          change — and this renders what it was sent either way. */}
      {nudge.dismissible && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
