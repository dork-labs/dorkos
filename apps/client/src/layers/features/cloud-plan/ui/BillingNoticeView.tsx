import { ExternalLink } from 'lucide-react';
import { openExternalLink } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import type { BillingNotice } from '../model/use-billing-page';

/**
 * Why a billing page did not open: the service's own words, with its own
 * link when it gave one, or one plain sentence of ours.
 *
 * The link opens straight from the click, so no browser counts it as a pop-up.
 *
 * @param props.notice - What to say, or `null` for nothing.
 */
export function BillingNoticeView({ notice }: { notice: BillingNotice | null }) {
  if (notice === null) return null;
  if ('message' in notice) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {notice.message}
      </p>
    );
  }
  const { title, detail, requiredPlanDisplayName, actionUrl, actionLabel } = notice.problem;
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 space-y-1 rounded-md border px-3 py-2"
    >
      {/* Every word below is the service's. */}
      <p className="text-sm font-medium">{title}</p>
      {detail !== undefined && <p className="text-sm">{detail}</p>}
      {requiredPlanDisplayName !== undefined && (
        <p className="text-muted-foreground text-sm">This needs {requiredPlanDisplayName}.</p>
      )}
      {actionUrl !== undefined && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => openExternalLink(actionUrl)}
        >
          {actionLabel ?? 'Open your account'}
          <ExternalLink className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  );
}
