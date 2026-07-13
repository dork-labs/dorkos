import { FieldCard, FieldCardContent, SwitchSettingRow } from '@/layers/shared/ui';
import { useConfig, useUpdateConfig, HEARTBEAT_PAYLOAD_EXAMPLE } from '@/layers/entities/config';

/**
 * Privacy & Data settings tab. Live per-channel control over the first-party
 * outbound telemetry channels, plus the exact heartbeat payload shown verbatim
 * so the user can read every field. Every toggle also records the shared
 * `telemetry.userHasDecided` gate, so flipping any switch here counts as an
 * explicit choice and the first-run consent banner never reappears.
 *
 * Nothing is enabled by default; each channel is off until the user turns it on.
 * The full contract lives at https://dorkos.ai/telemetry.
 */
export function PrivacyTab() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();

  const telemetry = config?.telemetry;

  /** Patch one channel and record that the user has made a telemetry choice. */
  const setChannel = (channel: 'install' | 'heartbeat' | 'errorReporting', value: boolean) => {
    updateConfig.mutate({ telemetry: { [channel]: value, userHasDecided: true } });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Privacy &amp; Data</h3>
        <p className="text-muted-foreground text-xs">
          DorkOS is private by default. Nothing about how you use it leaves your machine unless you
          turn it on here. No prompts, code, file paths, or session content are ever sent.{' '}
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
            label="Share an anonymous weekly heartbeat"
            description="Send one small anonymous ping about once a week so we can count active installs. Payload shown below."
            checked={telemetry?.heartbeat ?? false}
            onCheckedChange={(v) => setChannel('heartbeat', v)}
            disabled={updateConfig.isPending}
          />
          <SwitchSettingRow
            label="Share crash reports"
            description="Send a cleaned-up crash report when something breaks. Needs a SENTRY_DSN set; the error message text is never included."
            checked={telemetry?.errorReporting ?? false}
            onCheckedChange={(v) => setChannel('errorReporting', v)}
            disabled={updateConfig.isPending}
          />
        </FieldCardContent>
      </FieldCard>

      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          The exact weekly heartbeat, word for word. This is the whole payload.
        </p>
        <pre className="text-muted-foreground bg-muted/40 max-w-full overflow-x-auto rounded-md border p-3 text-xs">
          <code>{HEARTBEAT_PAYLOAD_EXAMPLE}</code>
        </pre>
      </div>
    </div>
  );
}
