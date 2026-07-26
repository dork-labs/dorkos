/**
 * The two settings that shape a standing permission, read from the live user
 * config (spec `agent-approval-settings` §3.1, §3.3).
 *
 * `approvals.standingGrants` says whether permissions may exist at all;
 * `approvals.trustWindowMinutes` says how long a new one lasts. Two consumers read
 * them and they must not disagree: the tier gate, which honors a permission, and
 * the grant route, which creates one.
 *
 * ## Read fresh, every time
 *
 * Nothing here caches. A person can switch the master switch off between two
 * invocations, and the guarantee they expect is that the very next call asks again
 * — not that it asks again once something restarts. So the gate calls this per
 * gated invocation, which costs one `conf` read of an in-memory store.
 *
 * The window is read at CREATION only, and never again. A permission's expiry is
 * computed once and stored, so shortening the window later does not shorten
 * permissions that already exist, and lengthening it does not extend them. That is
 * the same property as "expiry never slides on use", seen from the settings side.
 *
 * @module services/core/approvals/standing-grant-settings
 */
import { DEFAULT_TRUST_WINDOW_MINUTES } from '@dorkos/shared/config-schema';

import { configManager } from '../config-manager.js';
import type { StandingGrantPosture } from './standing-grant-posture.js';

/** The two settings that shape a standing permission. */
export interface StandingGrantSettings {
  /** Whether standing permissions may exist at all. */
  enabled: boolean;
  /** How long a new permission lasts, in minutes, counted from the moment of the grant. */
  windowMinutes: number;
}

/**
 * Read both settings as they stand right now.
 *
 * The schema defaults both leaves, so a config that has been through it always has
 * them. The fallbacks here cover the one case that is not that — a store read
 * before the schema populated it — and they fall back to OFF and to the documented
 * default window, never to something more permissive.
 *
 * @returns The settings as stored.
 */
export function readStandingGrantSettings(): StandingGrantSettings {
  const approvals = configManager.get('approvals');
  return {
    enabled: approvals?.standingGrants === true,
    windowMinutes: approvals?.trustWindowMinutes ?? DEFAULT_TRUST_WINDOW_MINUTES,
  };
}

/**
 * Both settings that license a standing permission to exist, as stored right now.
 *
 * Deliberately separate from {@link readStandingGrantSettings}, which answers a
 * narrower question — "may the gate honor one" — and reads only the master switch.
 * This one answers "may one EXIST", which needs `auth.enabled` as well, because a
 * permission with no account behind it is a claim DorkOS cannot evaluate (§3.0).
 *
 * The two were conflated once, and the bug is worth recording: the boot sweep used
 * the narrower reader, so `dorkos config set auth.enabled false` left permissions
 * live and a restart did not clear them — the login half, which §3.0 calls the
 * load-bearing one. Anything asking "should this permission exist at all" must use
 * this function.
 *
 * @returns The posture as stored.
 */
export function readStandingGrantPosture(): StandingGrantPosture {
  return {
    loginEnabled: configManager.get('auth')?.enabled === true,
    standingGrants: configManager.get('approvals')?.standingGrants === true,
  };
}
