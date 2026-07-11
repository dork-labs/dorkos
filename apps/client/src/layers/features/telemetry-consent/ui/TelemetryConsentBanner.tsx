import { Button } from '@/layers/shared/ui';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';

/**
 * Example of the exact weekly heartbeat payload, shown verbatim so the user can
 * read every field before choosing. Kept in lockstep with the server payload in
 * `services/core/heartbeat-reporter.ts` and the public /telemetry page.
 */
const HEARTBEAT_PAYLOAD_EXAMPLE = `{
  "instanceId": "a1b2c3d4-...",   // random, not you
  "dorkosVersion": "0.46.0",
  "os": "darwin-arm64",
  "runtimesConfigured": ["claude-code", "codex"],
  "tunnelEnabled": false,
  "cloudLinked": false,
  "counts": { "agents": 4, "tasks": 2, "relayAdapters": 1 }
}`;

/**
 * First-run telemetry consent banner. Surfaced app-wide until the user makes an
 * explicit choice. Everything is off until they opt in — the banner never
 * auto-enables anything. Choosing either option records the shared
 * `userHasDecided` flag so no telemetry prompt reappears.
 *
 * Opting in turns on two anonymous channels to dorkos.ai: the weekly heartbeat
 * (payload shown verbatim below) and marketplace install events. Opting out
 * leaves both off. The full contract lives at https://dorkos.ai/telemetry.
 */
export function TelemetryConsentBanner() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();

  if (config?.telemetry?.userHasDecided) return null;

  const decline = () => {
    updateConfig.mutate({
      telemetry: { install: false, heartbeat: false, userHasDecided: true },
    });
  };

  const accept = () => {
    updateConfig.mutate({
      telemetry: { install: true, heartbeat: true, userHasDecided: true },
    });
  };

  return (
    <div
      role="region"
      aria-label="Telemetry consent"
      className="border-border bg-muted/40 flex flex-col gap-3 border-b px-4 py-3"
    >
      <div className="min-w-0 space-y-1">
        <h2 className="text-sm font-semibold">Share anonymous usage data?</h2>
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
      <pre className="text-muted-foreground bg-background/60 max-w-full overflow-x-auto rounded-md border p-3 text-xs">
        <code>{HEARTBEAT_PAYLOAD_EXAMPLE}</code>
      </pre>
      <div className="flex flex-shrink-0 gap-2">
        <Button variant="outline" size="sm" onClick={decline} disabled={updateConfig.isPending}>
          No thanks
        </Button>
        <Button size="sm" onClick={accept} disabled={updateConfig.isPending}>
          Share anonymous data
        </Button>
      </div>
    </div>
  );
}
