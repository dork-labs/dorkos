/**
 * Keep standing permissions from outliving the posture that justified them
 * (spec `agent-approval-settings` §3.0, §3.7).
 *
 * Two settings license a standing permission to exist: `auth.enabled`, because a
 * session cookie is the only thing that tells the person in the cockpit from an
 * agent on the same machine, and `approvals.standingGrants`, the master switch.
 * When either is switched off, every live permission ends immediately — and BOTH
 * paths that enforce that check both settings, which is not a detail. The boot
 * sweep first read only the master switch, so turning login off through the CLI left
 * permissions live and honored; the login half is the one §3.0 calls load-bearing,
 * so the half-covered version was worse than none.
 *
 * The alternative — leaving rows dormant and honoring them again if the setting
 * comes back — is the thing this module exists to prevent. A permission granted
 * while login was on would wake up under a posture that can no longer justify it,
 * and nobody would have decided that.
 *
 * ## Why a boot-wired seam rather than injection
 *
 * `PATCH /api/config` is a module-level router with no construction seam to pass a
 * service through. This mirrors `initCapabilityTierGate`, for the same reason and
 * with the same fail-quiet behavior: an unwired seam revokes nothing and says so in
 * the log rather than throwing inside a config write.
 *
 * ## `PATCH /api/config` is NOT the only write path, and the gap is real
 *
 * An earlier version of this comment said it was. It is not: `dorkos config set
 * approvals.standingGrants false` and `dorkos config reset` write
 * `~/.dork/config.json` directly through `ConfigStore.setDot`
 * (`packages/cli/src/config-commands.ts`), out of process, and reach nothing here.
 * The capability surface genuinely cannot write these (both leaves are
 * `operator-only`); the CLI can, and deliberately, because it has to work with no
 * server running.
 *
 * So a CLI round trip — switch off, switch back on — would leave permissions live
 * and wake them up, which is exactly the failure this module exists to prevent.
 * Two things narrow it, and neither closes it:
 *
 * - The gate reads the switch FRESH on every gated call, so nothing is honored
 *   while the switch is off. The window is only the off-then-on round trip.
 * - Boot runs {@link revokeStandingGrantsIfPostureForbids} (`index.ts`), so the
 *   invariant "no permission is live unless BOTH settings license one" holds across
 *   a restart — including a CLI write to `auth.enabled`, which is the half the first
 *   version of that sweep missed.
 *
 * What is left is an off-then-on round trip inside one server lifetime with no
 * gated call in between. Closing that needs the server to watch the config file
 * rather than only its own write path, which is a change to how config reaches the
 * server and is not being improvised here.
 *
 * @module services/core/approvals/standing-grant-posture
 */
import { logger } from '../../../lib/logger.js';
import type { ApprovalGrantService } from './approval-grant-service.js';

/** The two settings that license a standing permission to exist. */
export interface StandingGrantPosture {
  /** Whether local login is on, which is what makes a cookie possible. */
  loginEnabled: boolean;
  /** Whether standing permissions may exist at all. */
  standingGrants: boolean;
}

/** Boot-wired store. Undefined in a boot that never built one. */
let grants: ApprovalGrantService | undefined;

/**
 * Wire the standing-permission store so a posture change can end live
 * permissions. Called once at boot.
 *
 * @param service - The store built at boot.
 */
export function initStandingGrantPosture(service: ApprovalGrantService): void {
  grants = service;
}

/** Drop the wired store. Test-only seam, mirroring `resetCapabilityTierGate`. */
export function resetStandingGrantPosture(): void {
  grants = undefined;
}

/**
 * End every live standing permission when a config change takes away what
 * licensed them.
 *
 * Narrowing only: switching either setting ON grants nothing and revokes
 * nothing, because a permission is always a fresh human decision.
 *
 * @param before - The posture as it was before the write.
 * @param after - The posture as it is after the write.
 * @returns How many permissions were ended. Zero when nothing narrowed.
 */
export function revokeStandingGrantsIfPostureNarrowed(
  before: StandingGrantPosture,
  after: StandingGrantPosture
): number {
  const narrowed =
    (before.loginEnabled && !after.loginEnabled) ||
    (before.standingGrants && !after.standingGrants);
  if (!narrowed) return 0;
  return endAll('after a settings change');
}

/**
 * End every live permission when the CURRENT posture does not license one at all.
 *
 * The sibling above compares two postures and therefore only fires on a write it
 * can see. This one asks a question that needs no history: given how the settings
 * stand right now, may a permission exist? Boot calls it, which is what makes the
 * invariant survive a write this process never saw — `dorkos config set` edits
 * `~/.dork/config.json` directly and out of process, so it reaches no seam.
 *
 * Both settings are checked, not just the master switch. Getting that wrong is the
 * defect this function was extracted to fix: the first version read only
 * `approvals.standingGrants`, so turning `auth.enabled` off through the CLI left
 * permissions live AND still honored by the gate, which is the half §3.0 calls
 * load-bearing.
 *
 * @param posture - How the two settings stand right now.
 * @returns How many permissions were ended. Zero when the posture allows them.
 */
export function revokeStandingGrantsIfPostureForbids(posture: StandingGrantPosture): number {
  if (posture.loginEnabled && posture.standingGrants) return 0;
  return endAll('because standing permissions are not switched on');
}

/**
 * End every live permission, or say why nothing happened.
 *
 * @param why - How the log line explains itself, for the operator reading it.
 * @returns How many permissions were ended.
 */
function endAll(why: string): number {
  if (!grants) {
    logger.warn('[Approvals] Standing permissions should have ended, but the store is not wired');
    return 0;
  }

  const ended = grants.revokeAll();
  if (ended > 0) {
    logger.info(`[Approvals] Ended ${ended} standing permission(s) ${why}`);
  }
  return ended;
}
