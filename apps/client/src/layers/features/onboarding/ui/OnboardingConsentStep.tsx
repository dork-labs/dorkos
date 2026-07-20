import { useCallback } from 'react';
import { Button } from '@/layers/shared/ui';
import { useUpdateConfig, TelemetryPayloadDisclosure } from '@/layers/entities/config';

interface OnboardingConsentStepProps {
  /** Called once the telemetry choice has been recorded (proceeds to Complete). */
  onComplete: () => void;
}

/**
 * Onboarding telemetry disclosure step. Presents the same opt-out framing as the
 * standalone banner: DorkOS shares a small anonymous heartbeat and marketplace
 * install counts by default, shown here verbatim, and the user can keep sharing
 * or turn it off. Either choice records the shared `telemetry.userHasDecided`
 * gate so the disclosure never reappears, then advances to the completion
 * screen. A failed write still advances — a telemetry hiccup must never trap the
 * user in onboarding.
 */
export function OnboardingConsentStep({ onComplete }: OnboardingConsentStepProps) {
  const updateConfig = useUpdateConfig();

  const choose = useCallback(
    (share: boolean) => {
      updateConfig.mutate(
        { telemetry: { install: share, heartbeat: share, userHasDecided: true } },
        { onSettled: () => onComplete() }
      );
    },
    [updateConfig, onComplete]
  );

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto py-4">
      <div className="max-w-md space-y-2 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">
          DorkOS shares a little anonymous data
        </h2>
        <p className="text-muted-foreground text-sm">
          To see roughly how many people run DorkOS, it sends a small anonymous heartbeat once a day
          plus anonymous marketplace install counts. Here is exactly what is in it. No prompts,
          code, file paths, or session content ever leave your machine. Turn it off any time.{' '}
          <a
            href="https://dorkos.ai/telemetry"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            Read the full contract
          </a>
          .
        </p>
      </div>

      <TelemetryPayloadDisclosure className="max-w-md text-center" />

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => choose(false)} disabled={updateConfig.isPending}>
          Turn off
        </Button>
        <Button onClick={() => choose(true)} disabled={updateConfig.isPending}>
          Keep sharing
        </Button>
      </div>
    </div>
  );
}
