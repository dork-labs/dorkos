import { cn } from '@/layers/shared/lib';
import { HEARTBEAT_PAYLOAD_EXAMPLE } from '../lib/telemetry-payload';

/**
 * The exact heartbeat payload rendered verbatim in a monospace block with a
 * plain-language caption. This is the single source of the payload's on-screen
 * markup, shared by every telemetry surface (consent banner, onboarding step,
 * privacy settings) so what leaves the machine reads the same everywhere.
 *
 * @param className - Optional classes for the outer wrapper.
 */
export function TelemetryPayloadBlock({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <pre className="text-muted-foreground bg-background/60 max-w-full overflow-x-auto rounded-md border p-3 text-xs">
        <code>{HEARTBEAT_PAYLOAD_EXAMPLE}</code>
      </pre>
      <p className="text-muted-foreground text-xs">
        This is the whole thing. Nothing else is sent.
      </p>
    </div>
  );
}
