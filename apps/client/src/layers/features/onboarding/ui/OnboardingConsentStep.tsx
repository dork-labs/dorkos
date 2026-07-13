import { useCallback } from 'react';
import { Button } from '@/layers/shared/ui';
import { useUpdateConfig, HEARTBEAT_PAYLOAD_EXAMPLE } from '@/layers/entities/config';

interface OnboardingConsentStepProps {
  /** Called once the telemetry choice has been recorded (proceeds to Complete). */
  onComplete: () => void;
}

/**
 * Onboarding telemetry consent step. Presents the same choice as the standalone
 * banner: share anonymous data (weekly heartbeat + marketplace install events,
 * with the exact payload shown verbatim) or decline. Either choice records the
 * shared `telemetry.userHasDecided` gate so the banner never reappears, then
 * advances to the completion screen. A failed write still advances — a telemetry
 * hiccup must never trap the user in onboarding.
 */
export function OnboardingConsentStep({ onComplete }: OnboardingConsentStepProps) {
  const updateConfig = useUpdateConfig();

  const choose = useCallback(
    (accept: boolean) => {
      updateConfig.mutate(
        { telemetry: { install: accept, heartbeat: accept, userHasDecided: true } },
        { onSettled: () => onComplete() }
      );
    },
    [updateConfig, onComplete]
  );

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto py-4">
      <div className="max-w-md space-y-2 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Share anonymous usage data?</h2>
        <p className="text-muted-foreground text-sm">
          DorkOS never phones home unless you say yes. Turn this on and it sends a small anonymous
          ping about once a week, plus anonymous marketplace install events. No prompts, code, file
          paths, or session content ever leave your machine. You can change your mind anytime in
          settings.{' '}
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

      <pre className="text-muted-foreground bg-muted/40 max-w-md overflow-x-auto rounded-md border p-3 text-xs">
        <code>{HEARTBEAT_PAYLOAD_EXAMPLE}</code>
      </pre>

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => choose(false)} disabled={updateConfig.isPending}>
          No thanks
        </Button>
        <Button onClick={() => choose(true)} disabled={updateConfig.isPending}>
          Share anonymous data
        </Button>
      </div>
    </div>
  );
}
