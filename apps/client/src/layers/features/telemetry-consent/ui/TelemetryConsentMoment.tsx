import { useState } from 'react';

import {
  Button,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/layers/shared/ui';
import {
  useUpdateConfig,
  TelemetryPayloadBlock,
  TelemetryPayloadToggle,
} from '@/layers/entities/config';

/**
 * First-run telemetry invitation, shown once as a moment on the moments rail
 * until the user makes an explicit choice. Every channel is off until they say
 * otherwise (ADR 260727-182651), so this asks rather than discloses, and tucks
 * the exact payload behind a "See what's sent" toggle — one click away, never a
 * wall of JSON. Declining is as easy as accepting; either choice records the
 * shared `userHasDecided` flag, which is what makes this moment ineligible from
 * then on. Both actions write every channel they cover, so a "yes" is not
 * silently narrower than it looks. The full contract lives at
 * https://dorkos.ai/telemetry.
 *
 * Two things it deliberately does not do. It has no "not now" button — closing
 * the dialog is that, and the rail asks again on a later launch. And it never
 * writes `telemetry.lastPromptedVersion`: the server owns that stamp, advancing
 * it at boot when it prints the first-run notice
 * (`services/core/telemetry-first-run.ts`). A client that also wrote it would be
 * racing the boot sequence for a field whose whole job is to record what that
 * sequence did.
 *
 * A failed write says so in place. The config PATCH can 500, and a consent
 * dialog that swallowed that would close over an answer nobody recorded — or,
 * worse, sit there looking answerable with the choice already lost. The error
 * line appears under the buttons, both stay live, and TanStack clears it the
 * moment a retry starts.
 */
export function TelemetryConsentMoment() {
  const updateConfig = useUpdateConfig();
  const [expanded, setExpanded] = useState(false);

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
    <>
      <DialogHeader>
        <DialogTitle>Share anonymous usage data?</DialogTitle>
        <DialogDescription>
          DorkOS sends us nothing unless you say so. Want to share a daily “I&apos;m alive” ping and
          install counts? Never your prompts, code, or files.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <TelemetryPayloadToggle open={expanded} onToggle={() => setExpanded((v) => !v)} />
          <a
            href="https://dorkos.ai/telemetry"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground text-xs font-medium underline underline-offset-2"
          >
            Full contract
          </a>
        </div>
        {expanded && <TelemetryPayloadBlock />}
      </div>

      <DialogFooter className="items-center gap-2 sm:justify-between">
        {updateConfig.isError ? (
          <p role="alert" className="text-destructive text-xs">
            Couldn&apos;t save your choice. Try again.
          </p>
        ) : (
          <span aria-hidden />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={decline} disabled={updateConfig.isPending}>
            No thanks
          </Button>
          <Button size="sm" onClick={share} disabled={updateConfig.isPending}>
            Share anonymously
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
