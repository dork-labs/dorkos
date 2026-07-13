import { FieldCard, FieldCardContent, SwitchSettingRow } from '@/layers/shared/ui';
import { useConfig, useUpdateConfig, HEARTBEAT_PAYLOAD_EXAMPLE } from '@/layers/entities/config';

/**
 * Privacy & Data settings tab. Live per-channel control over the first-party
 * outbound telemetry channels, plus the exact heartbeat payload shown verbatim
 * so the user can read every field. Every toggle also records the shared
 * `telemetry.userHasDecided` gate, so flipping any switch here counts as an
 * explicit choice and the first-run consent notice never reappears.
 *
 * Post Tier 1 flip (ADR 260713-143958): the three anonymous channels (install
 * counts, daily heartbeat, feature-usage events) are ON by default, gated on a
 * first-run notice before anything sends, and anonymous by construction. Crash
 * reports stay opt-in. The full contract lives at https://dorkos.ai/telemetry.
 */
export function PrivacyTab() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();

  const telemetry = config?.telemetry;

  /** Patch one channel and record that the user has made a telemetry choice. */
  const setChannel = (
    channel: 'install' | 'heartbeat' | 'errorReporting' | 'usage',
    value: boolean
  ) => {
    updateConfig.mutate({ telemetry: { [channel]: value, userHasDecided: true } });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Privacy &amp; Data</h3>
        <p className="text-muted-foreground text-xs">
          DorkOS shares a little anonymous data by default so we can count active installs and see
          which features get used. It is anonymous by construction: no prompts, code, file paths, or
          session content are ever sent, and nothing sends before the first-run notice. Crash
          reports are separate and stay off until you turn them on.{' '}
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

      <FieldCard>
        <FieldCardContent>
          <SwitchSettingRow
            label="Share anonymous install counts"
            description="Send anonymous marketplace install events so we can rank packages and spot broken installs."
            checked={telemetry?.install ?? false}
            onCheckedChange={(v) => setChannel('install', v)}
            disabled={updateConfig.isPending}
          />
          <SwitchSettingRow
            label="Share an anonymous daily heartbeat"
            description="Send one small anonymous ping about once a day so we can count active installs. Payload shown below."
            checked={telemetry?.heartbeat ?? false}
            onCheckedChange={(v) => setChannel('heartbeat', v)}
            disabled={updateConfig.isPending}
          />
          <SwitchSettingRow
            label="Share anonymous feature-usage events"
            description="Send a few named events like app start and new session so we can see which features get used. Counts only, never prompts, code, file paths, or session content."
            checked={telemetry?.usage ?? false}
            onCheckedChange={(v) => setChannel('usage', v)}
            disabled={updateConfig.isPending}
          />
          <SwitchSettingRow
            label="Share crash reports"
            description="Send a cleaned-up crash report to dorkos.ai when something breaks. Scrubbed first: no error messages, no file paths, no code. Off until you turn it on."
            checked={telemetry?.errorReporting ?? false}
            onCheckedChange={(v) => setChannel('errorReporting', v)}
            disabled={updateConfig.isPending}
          />
        </FieldCardContent>
      </FieldCard>

      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          The exact daily heartbeat, word for word. This is the whole payload.
        </p>
        <pre className="text-muted-foreground bg-muted/40 max-w-full overflow-x-auto rounded-md border p-3 text-xs">
          <code>{HEARTBEAT_PAYLOAD_EXAMPLE}</code>
        </pre>
      </div>
    </div>
  );
}
