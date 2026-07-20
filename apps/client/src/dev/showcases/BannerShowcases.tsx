import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Banner, Button } from '@/layers/shared/ui';

const SAMPLE_DETAILS = (
  <pre className="text-muted-foreground bg-background/60 max-w-full overflow-x-auto rounded-md border p-3 text-xs">
    <code>{'{\n  "event": "example",\n  "count": 3\n}'}</code>
  </pre>
);

/** Banner showcases: the four severity variants, a dismissible banner, and the collapsible details region. */
export function BannerShowcases() {
  const [dismissed, setDismissed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);

  return (
    <PlaygroundSection
      title="Banner"
      description="Full-width banner for a standing condition. One shows at a time via the app banner slot; success is a toast, never a banner."
    >
      <ShowcaseLabel>Variants</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full overflow-hidden rounded-md border">
          <Banner variant="critical">Runtime crashed — restart to keep working.</Banner>
          <Banner variant="warning">
            All permissions bypassed — the agent can execute any tool without approval.
          </Banner>
          <Banner variant="info">A new version is ready to install.</Banner>
          <Banner variant="neutral">DorkOS shares a little anonymous data.</Banner>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Dismissible (only when onDismiss is given)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full space-y-3">
          <div className="overflow-hidden rounded-md border">
            {dismissed ? (
              <div className="text-muted-foreground px-4 py-2 text-xs">Banner dismissed.</div>
            ) : (
              <Banner variant="info" onDismiss={() => setDismissed(true)}>
                You can dismiss this one.
              </Banner>
            )}
          </div>
          {dismissed && (
            <Button variant="outline" size="sm" onClick={() => setDismissed(false)}>
              Reset
            </Button>
          )}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Collapsible details + actions</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full overflow-hidden rounded-md border">
          <Banner
            variant="neutral"
            detailsOpen={detailsOpen}
            details={SAMPLE_DETAILS}
            actions={
              <>
                <Button variant="outline" size="sm">
                  Turn off
                </Button>
                <Button size="sm">Keep sharing</Button>
              </>
            }
          >
            An anonymous heartbeat is on.{' '}
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              aria-expanded={detailsOpen}
              className="text-foreground rounded-sm font-medium underline underline-offset-2"
            >
              See what&apos;s sent
            </button>
          </Banner>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
