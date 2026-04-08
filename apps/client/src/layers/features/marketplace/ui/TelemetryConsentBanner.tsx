import { Button } from '@/layers/shared/ui';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';

/**
 * Telemetry consent banner — surfaced above the Dork Hub package grid until
 * the user makes an explicit choice. Default state is opt-out; the banner
 * never auto-enables telemetry. Once the user clicks either button the
 * `userHasDecided` flag is persisted and the banner stops appearing.
 *
 * Privacy contract: https://dorkos.ai/marketplace/privacy
 */
export function TelemetryConsentBanner() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();

  if (config?.telemetry?.userHasDecided) return null;

  const handleDecline = () => {
    updateConfig.mutate({ telemetry: { enabled: false, userHasDecided: true } });
  };

  const handleAccept = () => {
    updateConfig.mutate({ telemetry: { enabled: true, userHasDecided: true } });
  };

  return (
    <div
      role="region"
      aria-label="Marketplace telemetry consent"
      className="border-border bg-muted/40 mb-6 flex flex-col gap-4 rounded-xl border p-5 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-semibold">Help improve the marketplace</h3>
        <p className="text-muted-foreground text-sm">
          Send anonymous install events to dorkos.ai so we can rank packages and fix install
          failures. No PII. Random per-install ID. Off unless you opt in.{' '}
          <a
            href="https://dorkos.ai/marketplace/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            Privacy contract
          </a>
          .
        </p>
      </div>
      <div className="flex flex-shrink-0 gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDecline}
          disabled={updateConfig.isPending}
        >
          No thanks
        </Button>
        <Button size="sm" onClick={handleAccept} disabled={updateConfig.isPending}>
          Send anonymous events
        </Button>
      </div>
    </div>
  );
}
