import { useCallback, useState } from 'react';
import { Zap } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import {
  Button,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  PermissionModeScopeNote,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { configKeys, useConfig, useUpdateConfig } from '@/layers/entities/config';
import { useSetOpenMesh } from '@/layers/entities/mesh';

/** Props for {@link FullPowerDoor}. */
export interface FullPowerDoorProps {
  /**
   * The one heading that differs by host — the modal opens with "DorkOS runs at
   * full power", the onboarding stage with "Choose your power level". Everything
   * below the heading is identical so the two surfaces can never drift.
   */
  heading: string;
  /**
   * Close the surrounding dialog. Called after a definitive answer (unlock,
   * keep-asking, customize) — never on a partial failure, where the door stays
   * up to report what happened.
   */
  onClose: () => void;
  /**
   * Open the surface that holds the whole power picture — Settings → Runtimes
   * today, the Control Center once it lands. Called by "Customize…" after the
   * supervised decision is recorded. This is the one seam the Control Center PR
   * re-points; the door itself is destination-agnostic.
   */
  onCustomize: () => void;
}

/** Turn a failed config write into one sentence a person can act on. */
function describeWriteFailure(err: unknown): string {
  return (err instanceof Error && err.message) || 'Could not save that. Try again.';
}

/** The full-power promise, one line each, in plain words. */
const FULL_POWER_POINTS: ReadonlyArray<{ lead: string; rest: string }> = [
  { lead: 'Runs without asking.', rest: 'Agents do the work instead of waiting for your OK.' },
  { lead: 'Agents talk to each other.', rest: 'Across every project, not just within one.' },
  { lead: 'Approvals stick.', rest: 'Say yes once and it stays yes.' },
  {
    lead: 'Scheduled runs use your power level.',
    rest: 'Timed runs act with the same freedom as everything else.',
  },
];

/**
 * The one consent door — the single surface that turns on full power.
 *
 * It renders inside a dialog the host owns (the moments rail for existing users,
 * the onboarding stage for new ones); the host supplies only the heading and the
 * two callbacks, so the copy and the write sequence live here and cannot drift
 * between the two surfaces.
 *
 * ## What "Unlock full power" writes (invariant A1)
 *
 * Full power is consent-gated, so nothing here flips silently — this is the
 * surface whose ACCEPT does the flipping. Accept is two steps in order:
 *
 * 1. **One** `PATCH /api/config` carrying the acknowledgement, both decision
 *    fields, the stop, and — when Require login is on — standing grants,
 *    together. The acknowledgement must ride in the SAME request as
 *    `runtimes.defaultTrustStop: 'autonomy'`: the server refuses that stop
 *    without a recorded acknowledgement (`428 AUTONOMY_ACK_REQUIRED`), so two
 *    requests would race and the stop could land first and bounce. This mirrors
 *    `confirmAutonomy` in `features/settings/model/use-trust-stop-writes` — which
 *    cannot be imported across feature model boundaries, so the one-patch shape
 *    is re-created and pinned by a test here.
 * 2. `PUT /api/mesh/topology/access` `* → * allow`, via `useSetOpenMesh`.
 *
 * ## Standing grants ride only when Require login is on
 *
 * `approvals.standingGrants` is one of the server's `REQUIRES_LOGIN_CONFIG_PATHS`
 * (`config-write-policy.ts`): the config route refuses it with `403` while
 * Require login is off, because without a login DorkOS cannot tell the operator
 * from an agent, so the flag would be pre-armable. The whole atomic PATCH is
 * refused as one, so unconditionally sending `standingGrants: true` would 403 the
 * entire accept on the default install (login off) and unlock nothing. Standing
 * grants are also INERT without login (`standingGrantsLicensed()` needs
 * `auth.enabled`), so the honest, contract-respecting shape is to include them
 * only when login is on — exactly the condition under which the Control Center
 * lets the switch move. Everything else full power turns on still applies with
 * login off.
 *
 * **Partial failure is reported, never rolled back.** If the mesh open fails
 * after the config write landed, the config flips are real and they stay — the
 * door says so plainly and offers a retry. Silently reverting a consent the
 * person just gave is worse than one honest sentence. If the config write fails,
 * the mesh call never fires.
 *
 * ## Keep asking me first / Customize…
 *
 * Both record `{ fullPowerDecidedAt, fullPowerChoice: 'supervised' }` and nothing
 * else — no stop, no grants, no mesh. Customize… then opens the power surface so
 * the person can pick specifics; moving to full power later from there is a
 * normal, supported path. Dismissing the dialog (the X) writes nothing, and the
 * moment re-arbitrates on the next launch.
 */
export function FullPowerDoor({ heading, onClose, onCustomize }: FullPowerDoorProps) {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const setOpenMesh = useSetOpenMesh();
  const queryClient = useQueryClient();

  // Standing grants are login-gated on the server and inert without login, so
  // they ride the accept only when Require login is on (see the docblock).
  const loginOn = config?.auth?.enabled === true;

  const [submitting, setSubmitting] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [meshFailed, setMeshFailed] = useState(false);

  const busy = submitting || updateConfig.isPending || setOpenMesh.isPending;

  // Invalidate the whole `config` PREFIX, not just this surface's key: the
  // status bar, the sidebar badges and `useFeatureEnabled` read config off a
  // broader key set, and the server applies the default live, so every reader
  // has to move with the write.
  const refreshConfigReaders = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: configKeys.all });
  }, [queryClient]);

  const accept = useCallback(async () => {
    setConfigError(null);
    setMeshFailed(false);
    setSubmitting(true);
    const now = new Date().toISOString();
    try {
      // Step 1 — the acknowledgement rides WITH the stop. One request, not two.
      // Standing grants are appended only with login on (see the docblock).
      await updateConfig.mutateAsync({
        ui: {
          autonomyAcknowledgedAt: now,
          fullPowerDecidedAt: now,
          fullPowerChoice: 'full',
        },
        runtimes: { defaultTrustStop: 'autonomy' },
        ...(loginOn ? { approvals: { standingGrants: true } } : {}),
      });
    } catch (err) {
      // Step 2 never fires when step 1 fails.
      setConfigError(describeWriteFailure(err));
      setSubmitting(false);
      return;
    }
    refreshConfigReaders();
    try {
      // Step 2 — open the mesh. Its own hook does the optimistic flip and the
      // rollback of the mesh cache; a failure here does NOT undo step 1.
      await setOpenMesh.mutateAsync(true);
    } catch {
      setMeshFailed(true);
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    onClose();
  }, [loginOn, updateConfig, setOpenMesh, refreshConfigReaders, onClose]);

  const recordSupervised = useCallback(async (): Promise<boolean> => {
    setConfigError(null);
    setSubmitting(true);
    try {
      await updateConfig.mutateAsync({
        ui: { fullPowerDecidedAt: new Date().toISOString(), fullPowerChoice: 'supervised' },
      });
    } catch (err) {
      setConfigError(describeWriteFailure(err));
      setSubmitting(false);
      return false;
    }
    refreshConfigReaders();
    setSubmitting(false);
    return true;
  }, [updateConfig, refreshConfigReaders]);

  const decline = useCallback(async () => {
    if (await recordSupervised()) onClose();
  }, [recordSupervised, onClose]);

  const customize = useCallback(async () => {
    if (await recordSupervised()) {
      onCustomize();
      onClose();
    }
  }, [recordSupervised, onCustomize, onClose]);

  const retryMesh = useCallback(async () => {
    setSubmitting(true);
    try {
      await setOpenMesh.mutateAsync(true);
    } catch {
      setSubmitting(false);
      return;
    }
    setMeshFailed(false);
    setSubmitting(false);
    onClose();
  }, [setOpenMesh, onClose]);

  if (meshFailed) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Full power is on</DialogTitle>
          <DialogDescription>
            Almost everything is set. One thing didn&apos;t finish.
          </DialogDescription>
        </DialogHeader>
        <p role="alert" className="text-muted-foreground text-sm">
          Your agents can&apos;t message each other across projects yet — that step didn&apos;t go
          through. Nothing was undone: full power stays on, and you can open this any time from
          Settings.
        </p>
        <DialogFooter className="items-center gap-2 sm:justify-end">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button size="sm" onClick={retryMesh} disabled={busy}>
            Try again
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle data-testid="full-power-door">{heading}</DialogTitle>
        <DialogDescription>
          Unlock full power and DorkOS stops asking before it acts. Here&apos;s what that turns on:
        </DialogDescription>
      </DialogHeader>

      <ul className="space-y-2 text-sm">
        {FULL_POWER_POINTS.map((point) => (
          <li key={point.lead} className="flex items-start gap-2">
            {/* The same success token the dial caption, status strip and
                session row read full power in (`trust-tone.ts`), so the door's
                green never drifts from theirs. */}
            <Zap className="text-status-success mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <span className="font-medium">{point.lead}</span> <span>{point.rest}</span>
            </span>
          </li>
        ))}
      </ul>

      <PermissionModeScopeNote mode="bypassPermissions" />

      <div>
        <Button
          variant="link"
          size="sm"
          className="text-muted-foreground h-auto p-0"
          onClick={customize}
          disabled={busy}
        >
          Customize… — pick the pieces yourself in Settings
        </Button>
      </div>

      <DialogFooter className="items-center gap-2 sm:justify-between">
        {configError ? (
          <p role="alert" className="text-destructive text-xs">
            {configError}
          </p>
        ) : (
          <span aria-hidden />
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={decline} disabled={busy}>
            Keep asking me first
          </Button>
          <Button
            size="sm"
            onClick={accept}
            disabled={busy}
            // Full power is the reward, so the CTA fills with the success token
            // rather than the neutral primary — the same green the dial reads at
            // its top stop. `text-status-success-bg` is that token's tint, which
            // flips near-white in light and near-black in dark, so the label
            // stays legible on the fill in both themes without a raw colour.
            className={cn(
              'bg-status-success text-status-success-bg',
              'hover:bg-status-success/90 focus-visible:ring-status-success/40'
            )}
          >
            <Zap aria-hidden />
            Unlock full power
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
