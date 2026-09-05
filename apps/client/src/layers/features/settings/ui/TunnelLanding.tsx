import { Button } from '@/layers/shared/ui';
import { TunnelOnboarding } from './TunnelOnboarding';

interface TunnelLandingProps {
  onGetStarted: () => void;
}

/** Landing page shown when no ngrok token is configured. Illustration + single CTA. */
export function TunnelLanding({ onGetStarted }: TunnelLandingProps) {
  return (
    <div data-testid="tunnel-landing" className="space-y-6 py-2">
      <TunnelOnboarding />

      {/* One headline, not two: `TunnelOnboarding` above already says "Access
          DorkOS from any device" under the illustration, and this block used to
          repeat it verbatim a few pixels below. */}
      <p className="text-muted-foreground mx-auto max-w-[280px] text-center text-xs leading-relaxed">
        Create a secure tunnel to reach your sessions from your phone, tablet, or any browser.
      </p>

      {/* The press comes from the Button primitive now, and the 1% hover grow
          is gone: nothing else in the app inflates under a pointer. */}
      <Button onClick={onGetStarted} className="w-full">
        Get started
      </Button>

      <p className="text-muted-foreground/60 mx-auto max-w-[280px] text-center text-xs">
        One-time setup, about 2 minutes: paste a free ngrok token, then create your owner login if
        you don&apos;t have one yet.
      </p>
    </div>
  );
}
