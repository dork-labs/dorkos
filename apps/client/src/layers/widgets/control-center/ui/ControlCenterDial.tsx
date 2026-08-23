import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { CANONICAL_TRUST_STOPS, TrustDial } from '@/layers/shared/ui';
import { useConfig } from '@/layers/entities/config';
import { useRuntimeCapabilities } from '@/layers/entities/runtime';
import { AutonomyConfirmDialog } from '@/layers/features/status';
import { useTrustStopWrites } from '@/layers/features/settings';

/**
 * The Control Center's global Trust Dial — where new sessions start, changed
 * through the one consent-gated write path Settings uses.
 *
 * It writes through {@link useTrustStopWrites} (a widget importing a feature
 * hook is the allowed direction) and renders the shared
 * {@link AutonomyConfirmDialog} off the hook's `pendingAutonomy`, exactly as the
 * Runtimes tab does. Moving to Full autonomy without a standing acknowledgement
 * raises that dialog — existing behaviour the hook owns; nothing here
 * re-implements or bypasses it.
 *
 * The dial is the ONE runtime-neutral dial, so it is rendered from the canonical
 * stops rather than a runtime's modes: its value is the stop itself, and the
 * caption reads green at Full autonomy because that is the product's headline
 * capability, not a mistake (`trust-tone`).
 */
export function ControlCenterDial() {
  const { data: config } = useConfig();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const trust = useTrustStopWrites();

  const defaults = config?.executionDefaults;
  const defaultRuntime = defaults?.runtime ?? 'claude-code';
  const defaultModes = capabilityMap?.capabilities[defaultRuntime]?.permissionModes;
  // A stored `null` resolves to the default runtime's own starting mode — the
  // same chain Settings → Runtimes resolves, so the two dials agree.
  const runtimeDefaultStop: PermissionStop =
    defaultModes?.values.find((m) => m.id === defaultModes.default)?.stop ?? 'ask';
  const globalStop: PermissionStop = defaults?.trustStop ?? runtimeDefaultStop;

  return (
    <section className="flex flex-col gap-2" data-testid="control-center-dial">
      <div>
        <p className="text-sm font-medium">Power</p>
        <p className="text-muted-foreground text-xs">
          Where new sessions start. Conversations already running keep their own setting.
        </p>
      </div>

      <TrustDial
        mode={globalStop}
        descriptors={CANONICAL_TRUST_STOPS}
        onChangeMode={(next) => trust.changeTrustStop(null, next as PermissionStop)}
      />

      {trust.writeError && (
        <p className="text-destructive px-1 text-xs" role="alert">
          {trust.writeError}
        </p>
      )}

      {/* One dialog, one contract — the same door Settings shows. No "remember"
          checkbox: agreeing here IS the standing record the server requires. */}
      <AutonomyConfirmDialog
        descriptor={trust.pendingAutonomy?.descriptor ?? null}
        canRemember={false}
        consentNote="Every new session will start here, and DorkOS will remember that you have read this."
        onCancel={trust.cancelAutonomy}
        onConfirm={trust.confirmAutonomy}
      />
    </section>
  );
}
