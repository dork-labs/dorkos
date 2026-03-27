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

      <div className="text-center">
        <p className="text-foreground text-sm font-medium">Access DorkOS from any device</p>
        <p className="text-muted-foreground mx-auto mt-1 max-w-[280px] text-xs leading-relaxed">
          Create a secure tunnel to access your sessions from your phone, tablet, or any browser.
        </p>
      </div>

      <Button
        onClick={onGetStarted}
        className="w-full transition-transform duration-100 hover:scale-[1.01] active:scale-[0.98]"
      >
        Get started
      </Button>

      <p className="text-muted-foreground/60 text-center text-xs">Requires a free ngrok account</p>
    </div>
  );
}
