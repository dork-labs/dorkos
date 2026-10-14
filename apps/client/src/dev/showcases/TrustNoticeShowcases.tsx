import { useState } from 'react';
import { Button, Dialog, DialogContent } from '@/layers/shared/ui';
import { TrustNoticeMoment } from '@/layers/features/trust-notice';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** The notice inside the same dialog the moments rail opens it in. */
function RailDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Open the notice
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <TrustNoticeMoment onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The one-time trust notice (spec `trusted-by-default-flip` §5.8). A fresh
 * install meets it on the launch after its first run, so it sits beside the
 * onboarding screens. Both buttons write through the playground transport.
 */
export function TrustNoticeShowcases() {
  return (
    <PlaygroundSection
      title="TrustNoticeMoment"
      description="Shown once on the moments rail to a Trusted install: agents now work without asking. Got it marks it seen; Keep asking me switches to Careful first."
    >
      <ShowcaseLabel>Inline</ShowcaseLabel>
      <ShowcaseDemo>
        {/* A closed Dialog root gives the title and description their context,
            so the body renders in place without the overlay. */}
        <Dialog>
          <div className="bg-background grid max-w-lg gap-4 rounded-lg border p-6">
            <TrustNoticeMoment onClose={() => {}} />
          </div>
        </Dialog>
      </ShowcaseDemo>
      <ShowcaseLabel>As the moments rail opens it</ShowcaseLabel>
      <ShowcaseDemo>
        <RailDemo />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
