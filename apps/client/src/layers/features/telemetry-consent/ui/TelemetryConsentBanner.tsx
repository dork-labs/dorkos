import { useState } from 'react';

import { Banner, Button } from '@/layers/shared/ui';
import {
  useConfig,
  useUpdateConfig,
  TelemetryPayloadBlock,
  TelemetryPayloadToggle,
} from '@/layers/entities/config';

/**
 * First-run telemetry invitation, shown app-wide until the user makes an
 * explicit choice. Every channel is off until they say otherwise (ADR
 * 260727-182651), so this asks rather than discloses, and tucks the exact
 * payload behind a "See what's sent" toggle — one click away, never a wall of
 * JSON. Declining is as easy as accepting; either choice records the shared
 * `userHasDecided` flag so the invitation never reappears. Both actions write
 * every channel they cover, so a "yes" is not silently narrower than it looks.
 * The full contract lives at https://dorkos.ai/telemetry.
 */
export function TelemetryConsentBanner() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const [expanded, setExpanded] = useState(false);

  if (config?.telemetry?.userHasDecided) return null;

  const decline = () => {
    updateConfig.mutate({
      telemetry: { install: false, heartbeat: false, usage: false, userHasDecided: true },
    });
  };

  const share = () => {
    updateConfig.mutate({
      telemetry: { install: true, heartbeat: true, usage: true, userHasDecided: true },
    });
  };

  return (
    <Banner
      variant="neutral"
      detailsOpen={expanded}
      details={<TelemetryPayloadBlock />}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={decline} disabled={updateConfig.isPending}>
            No thanks
          </Button>
          <Button size="sm" onClick={share} disabled={updateConfig.isPending}>
            Share anonymously
          </Button>
        </>
      }
    >
      <span className="text-muted-foreground">
        DorkOS sends us nothing unless you say so. Want to share a daily “I&apos;m alive” ping and
        install counts? Never your prompts, code, or files.{' '}
        <TelemetryPayloadToggle open={expanded} onToggle={() => setExpanded((v) => !v)} />{' '}
        <a
          href="https://dorkos.ai/telemetry"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground font-medium underline underline-offset-2"
        >
          Full contract
        </a>
      </span>
    </Banner>
  );
}
