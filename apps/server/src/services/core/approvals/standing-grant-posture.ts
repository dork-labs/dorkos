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
 * ## `PATCH /api/config` is NOT the only write path
 *
 * `dorkos config set approvals.standingGrants false` and `dorkos config reset`
 * write `~/.dork/config.json` OUT OF PROCESS (`packages/cli/src/config-commands.ts`)
 * and reach nothing in this module. The capability surface genuinely cannot write
 * these (both leaves are `operator-only`); the CLI can, and deliberately, because
 * it has to work with no server running.
 *
 * Since DOR-1247, `config set` does go through the shared guarded write
 * (`operator/config-write.ts`) rather than straight to `ConfigManager.setDot`, so
 * it now runs the same policy and leaves the same audit line as the cockpit. That
 * changed nothing here: `LOCAL_OPERATOR_AUTHORITY` deliberately clears the login
 * bar precisely so the protective direction — switching this OFF — keeps working
 * with no server up, and the guarded write still runs in the CLI's process, where
 * the store below does not exist. `config reset` is the one that still writes
 * directly, and it can only move settings to their shipped defaults.
 *
 * So the functions here cover only the writes this process performs. Two more
 * things cover the rest, and it takes all three:
 *
 * - The gate reads the switch FRESH on every gated call, so nothing is honored
 *   while the switch is off. That leaves only the off-then-on round trip.
 * - Boot runs {@link revokeStandingGrantsIfPostureForbids} (`index.ts`), so
 *   "no permission is live unless BOTH settings license one" holds across a
 *   restart — including a CLI write to `auth.enabled`, the half the first version
 *   of that sweep missed.
 * - The **posture floor** closes the round trip itself (DOR-520). Any write that
 *   takes either setting away stamps `approvals.standingGrantsVoidBefore`, and
 *   `ApprovalGrantService` refuses every permission granted at or before it. The
 *   stamp is written by `ConfigManager`, which is the one seam BOTH processes
 *   travel, so the CLI records the narrowing even though it ends nothing itself.
 *
 * ## What is still open, stated plainly
 *
 * The floor rests on every writer going through `ConfigManager`. Two things get
 * around that, and both are the same shape — config content that DorkOS did not
 * write:
 *
 * - **A hand edit.** A person who edits `~/.dork/config.json` in a text editor,
 *   including through `dorkos config edit`, which hands them the raw file,
 *   narrows the posture without stamping anything. An off-then-on round trip done
 *   that way still wakes permissions up inside one server lifetime.
 * - **A restored backup.** A config file copied back from a snapshot carries
 *   whatever floor it had when it was taken, which can be older than the one it
 *   replaces — or absent. Restoring a file is not a write this seam can see, and
 *   `config-write-policy.ts` already names the same class of problem for the
 *   settings themselves.
 *
 * In both cases a restart re-establishes the invariant only if the settings are
 * still narrowed when it happens.
 *
 * Closing that too would need the server to watch the config file, which is a
 * weaker guarantee than it sounds: a watcher only fires while the server is
 * running and only where the platform's file events are reliable, whereas the
 * floor is durable and survives the server being down for the entire round trip.
 * A watcher would be an addition to the floor, never a replacement for it.
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
