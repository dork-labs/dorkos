import { ExternalLink } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useAccountExport } from '../model/use-billing-page';
import { useCloudPlan } from '../model/use-cloud-plan';
import { BillingNoticeView } from './BillingNoticeView';

/**
 * Ask for a copy of everything the DorkOS account holds, and say where it
 * stands: being prepared (asking again later gets the link), ready with its
 * download, or why it could not be asked for.
 *
 * Self-contained: it owns its own request and renders nothing with no cloud
 * account.
 *
 * @param props.heading - The line above it; the delete dialog asks "Want a copy first?".
 */
export function ExportAccountData({ heading = 'Your data' }: { heading?: string }) {
  const { data } = useCloudPlan();
  const { state, request, download } = useAccountExport();
  if (!data?.available) return null;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{heading}</p>
      {state.kind === 'requested' ? (
        state.export.downloadUrl !== null ? (
          <div className="space-y-2">
            <p className="text-sm">Your export is ready.</p>
            <Button type="button" size="sm" variant="outline" onClick={download}>
              Download your data
              <ExternalLink className="size-3.5" aria-hidden />
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p role="status" className="text-sm">
              Your export is being prepared. Try again in a few minutes to get the link.
            </p>
            <Button type="button" size="sm" variant="outline" onClick={request}>
              Try again
            </Button>
          </div>
        )
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={state.kind === 'requesting'}
          aria-busy={state.kind === 'requesting'}
          onClick={request}
        >
          {state.kind === 'requesting' ? 'Asking…' : 'Export your account data'}
        </Button>
      )}
      {state.kind === 'failed' && <BillingNoticeView notice={state.notice} />}
    </div>
  );
}
