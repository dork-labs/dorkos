import { FieldCard, FieldCardContent, MoreDetails, SwitchSettingRow } from '@/layers/shared/ui';
import { useConfig, useUpdateConfig, TelemetryPayloadDisclosure } from '@/layers/entities/config';

/**
 * Privacy & Data settings tab. Live per-channel control over the first-party
 * outbound telemetry channels, plus the exact heartbeat payload shown verbatim
 * so the user can read every field. Every toggle also records the shared
 * `telemetry.userHasDecided` gate, so flipping any switch here counts as an
 * explicit choice and the first-run consent notice never reappears.
 *
 * Post Tier 1 flip (ADR 260713-143958): the three anonymous channels (install
 * counts, daily heartbeat, feature-usage events) are OFF until you turn them on, gated on a
 * first-run notice before anything sends, and anonymous by construction. Crash
 * reports stay opt-in. The full contract lives at https://dorkos.ai/telemetry.
 */
export function PrivacyTab() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();

  const telemetry = config?.telemetry;

  /** Patch one channel and record that the user has made a telemetry choice. */
  const setChannel = (
    channel: 'install' | 'heartbeat' | 'errorReporting' | 'usage' | 'aiMetadata',
    value: boolean
  ) => {
    updateConfig.mutate({ telemetry: { [channel]: value, userHasDecided: true } });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        {/* No heading here: the Settings dialog draws the panel's own "Privacy
            & Data" header. This is the explainer that sits under it. */}
        <p className="text-muted-foreground text-xs">
          Nothing is shared unless a switch below is on.{' '}
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
        <MoreDetails className="text-xs">
          <p>
            The three count switches are anonymous. They never send prompts, code or file paths.
          </p>
          <p>The counts never send before the first-run notice.</p>
          <p>Crash reports and AI run data are separate. Both start off.</p>
        </MoreDetails>
      </div>

      <FieldCard>
        <FieldCardContent>
          <SwitchSettingRow
            label="Share anonymous install counts"
            description="Counts marketplace installs, to rank packages and spot broken ones."
            checked={telemetry?.install ?? false}
            onCheckedChange={(v) => setChannel('install', v)}
            disabled={updateConfig.isPending}
          />
          <SwitchSettingRow
            label="Share an anonymous daily heartbeat"
            description="One anonymous ping a day, to count active installs. Exact payload below."
            checked={telemetry?.heartbeat ?? false}
            onCheckedChange={(v) => setChannel('heartbeat', v)}
            disabled={updateConfig.isPending}
          />
          <SwitchSettingRow
            label="Share anonymous feature-usage events"
            description="Counts events like app start, to see which features get used."
            checked={telemetry?.usage ?? false}
            onCheckedChange={(v) => setChannel('usage', v)}
            disabled={updateConfig.isPending}
          />
          <SwitchSettingRow
            label="Share AI run metadata"
            description="Model, tokens, time and cost per turn. Never your prompts, code or conversations."
            checked={telemetry?.aiMetadata ?? false}
            onCheckedChange={(v) => setChannel('aiMetadata', v)}
            disabled={updateConfig.isPending}
          />
          <SwitchSettingRow
            label="Share crash reports"
            description="A scrubbed report to dorkos.ai when something breaks. No error messages, paths or code."
            checked={telemetry?.errorReporting ?? false}
            onCheckedChange={(v) => setChannel('errorReporting', v)}
            disabled={updateConfig.isPending}
          />
        </FieldCardContent>
      </FieldCard>

      <TelemetryPayloadDisclosure />
    </div>
  );
}
