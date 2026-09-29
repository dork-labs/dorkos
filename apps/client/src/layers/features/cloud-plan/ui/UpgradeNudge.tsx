import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/layers/shared/ui';
import { formatCreditsWithMoney, formatMoney } from '@dork-labs/cloud-api/display';
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
 *
 * Its figures are rendered by `@dork-labs/cloud-api/display` in the unit the
 * nudge served: the last 30 days are a charge in credits with their money value
 * beside them, and the plan price and the difference are money, so the
 * sentence's subtraction reads in one unit. A nudge that names no unit renders
 * nothing — a comparison without its figures is not a comparison.
 */
export function UpgradeNudge() {
  const { data } = useCloudNudge();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !data?.available) return null;

  const { nudge } = data;
  const unit = nudge.denomination;
  const spent = formatCreditsWithMoney(nudge.trailing30Micro, unit, 'charge');
  const price = formatMoney(nudge.suggestedPlanPriceMicro, unit);
  const saving = formatMoney(nudge.savingMicro, unit);
  if (saving === null || spent === null || price === null) return null;

  return (
    <div className="bg-muted/50 flex items-start justify-between gap-3 rounded-md border px-3 py-2">
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
