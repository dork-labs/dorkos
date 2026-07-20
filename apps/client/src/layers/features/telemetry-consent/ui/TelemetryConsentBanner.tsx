import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { Banner, Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useConfig, useUpdateConfig, TelemetryPayloadBlock } from '@/layers/entities/config';

/**
 * First-run telemetry disclosure, shown app-wide until the user makes an explicit
 * choice. DorkOS shares a small anonymous heartbeat and marketplace install
 * counts by default (Tier 1, opt-out), so this discloses that default in one
 * line and tucks the exact payload behind a "See what's sent" toggle — one click
 * away, never a wall of JSON. Turning it off is as easy as keeping it on; either
 * choice records the shared `userHasDecided` flag so the disclosure never
 * reappears. The full contract lives at https://dorkos.ai/telemetry.
 */
export function TelemetryConsentBanner() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const [expanded, setExpanded] = useState(false);

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
    <Banner
      variant="neutral"
      detailsOpen={expanded}
      details={<TelemetryPayloadBlock />}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={turnOff} disabled={updateConfig.isPending}>
            Turn off
          </Button>
          <Button size="sm" onClick={keepSharing} disabled={updateConfig.isPending}>
            Keep sharing
          </Button>
        </>
      }
    >
      <span className="text-muted-foreground">
        DorkOS shares a little anonymous data — a daily “I&apos;m alive” ping and install counts.
        Never your prompts, code, or files.{' '}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-0.5 rounded-sm font-medium underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2"
        >
          See what&apos;s sent
          <ChevronDown
            aria-hidden
            className={cn('size-3 transition-transform duration-200', expanded && 'rotate-180')}
          />
        </button>{' '}
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
