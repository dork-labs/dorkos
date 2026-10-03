/**
 * The link flow, drawn inside whatever surface started it.
 *
 * @module features/cloud-link/ui/CloudLinkInline
 */
import { RefreshCw } from 'lucide-react';
import { Button, Spinner } from '@/layers/shared/ui';
import { useCloudLink } from '../model/use-cloud-link';
import { PendingLinkCode } from './PendingLinkCode';

/** Props for {@link CloudLinkInline}. */
export interface CloudLinkInlineProps {
  /**
   * The surface this is drawn in, as it named itself when it started the link
   * (`start({ origin })`). A code waiting for approval shows on every surface,
   * because there is only ever one; an expired or turned-down link shows its
   * way on only where it was started.
   */
  origin: string;
}

const RECOVERY = {
  expired: { title: 'Your code expired', action: 'Get a new code' },
  denied: { title: 'Link request denied', action: 'Try again' },
} as const;

/**
 * Show the one link in flight where the person is, so they never have to go to
 * Settings to finish it: the code and its approval page while it waits, and a
 * new code when it expired or was turned down. Renders nothing otherwise, so a
 * surface can mount it unconditionally beside its own button.
 *
 * Every copy of this reads the same flow ({@link useCloudLink}), so the code
 * here and the code in Settings › DorkOS account are one code: approving it
 * anywhere finishes it everywhere, and the surface that started it carries on.
 */
export function CloudLinkInline({ origin }: CloudLinkInlineProps) {
  const link = useCloudLink();
  const { view } = link;

  if (view.kind === 'pending') {
    return (
      <div data-testid="cloud-link-inline">
        <PendingLinkCode key={view.userCode} view={view} cancel={link.cancel} relinking={false} />
      </div>
    );
  }

  const own = link.origin === origin;
  const recovery =
    (view.kind === 'expired' || view.kind === 'denied') && own ? RECOVERY[view.kind] : null;
  const error = own || link.origin === null ? link.startError : null;
  if (!recovery && !error) return null;

  return (
    <div className="space-y-2" data-testid="cloud-link-inline">
      {recovery && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">{recovery.title}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void link.restart()}
            disabled={link.starting}
          >
            {link.starting ? (
              <Spinner className="mr-1.5" />
            ) : (
              <RefreshCw className="mr-1.5 size-3.5" />
            )}
            {recovery.action}
          </Button>
        </div>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
