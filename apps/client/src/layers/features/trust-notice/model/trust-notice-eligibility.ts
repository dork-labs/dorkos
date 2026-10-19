import type { ServerConfig } from '@dorkos/shared/types';
import { trustPosture } from '@dorkos/shared/permissions';

/**
 * Whether the one-time trust notice should be offered (spec
 * `trusted-by-default-flip` §5.8).
 *
 * True when config has loaded, onboarding is over (finished or dismissed), the
 * notice has not been seen (`ui.trustNoticeSeenAt` is null), this browser is
 * not on Wi-Fi, and the install runs Trusted. A Careful install already asked
 * agents to ask first, so the notice has nothing to tell it; the upgrade migration stamps those installs
 * too, and this check keeps the two in agreement if the stamp is ever missing.
 *
 * The moments rail's own rules (nothing over onboarding, nothing in the launch
 * the first run ended in, one moment per launch) are the host's, not repeated
 * here.
 *
 * @param config - The server config, or `undefined` while it loads.
 */
export function isTrustNoticeEligible(config: ServerConfig | undefined): boolean {
  if (!config) return false;
  const onboardingOver =
    config.onboarding?.completedAt != null || config.onboarding?.dismissedAt != null;
  if (!onboardingOver) return false;
  if (config.ui?.trustNoticeSeenAt != null) return false;
  // Held while this browser is on Wi-Fi (DOR-3037), where every turn still asks
  // first, so "agents now work without asking" would be untrue. Never offered
  // means never marked seen: it shows on the first visit from this computer.
  // The same read as `useOnWifi`, taken from the config this rule is given.
  if (config.callerRoute === 'wifi') return false;
  return trustPosture(config.permissions?.preset) === 'trusted';
}
