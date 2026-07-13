import { Button } from '@/layers/shared/ui';
import { useConfig, useUpdateConfig, HEARTBEAT_PAYLOAD_EXAMPLE } from '@/layers/entities/config';

/**
 * First-run telemetry disclosure. Surfaced app-wide until the user makes an
 * explicit choice. DorkOS shares a small anonymous heartbeat and marketplace
 * install counts by default (Tier 1, opt-out), so this banner discloses that
 * default and shows the exact payload rather than asking permission. Turning it
 * off is as easy as keeping it on. Either choice records the shared
 * `userHasDecided` flag so the disclosure never reappears.
 *
 * The full contract lives at https://dorkos.ai/telemetry.
 */
export function TelemetryConsentBanner() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();

  if (config?.telemetry?.userHasDecided) return null;

  const turnOff = () => {
    updateConfig.mutate({
      telemetry: { install: false, heartbeat: false, userHasDecided: true },
    });
  };

  const keepSharing = () => {
    updateConfig.mutate({
      telemetry: { install: true, heartbeat: true, userHasDecided: true },
    });
  };

  return (
    <div
      role="region"
      aria-label="Telemetry disclosure"
      className="border-border bg-muted/40 flex flex-col gap-3 border-b px-4 py-3"
    >
      <div className="min-w-0 space-y-1">
        <h2 className="text-sm font-semibold">DorkOS shares a little anonymous data</h2>
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
      <pre className="text-muted-foreground bg-background/60 max-w-full overflow-x-auto rounded-md border p-3 text-xs">
        <code>{HEARTBEAT_PAYLOAD_EXAMPLE}</code>
      </pre>
      <div className="flex flex-shrink-0 gap-2">
        <Button variant="outline" size="sm" onClick={turnOff} disabled={updateConfig.isPending}>
          Turn off
        </Button>
        <Button size="sm" onClick={keepSharing} disabled={updateConfig.isPending}>
          Keep sharing
        </Button>
      </div>
    </div>
  );
}
