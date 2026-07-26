import { useConfig } from '@/layers/entities/config';
import { DEFAULT_TRUST_WINDOW_MINUTES } from '@dorkos/shared/config-schema';

/** Whether standing permissions can be used here, and for how long each one lasts. */
export interface StandingGrantPolicy {
  /** True only when a permission could actually be created right now. */
  canGrant: boolean;
  /** The master switch, on its own. */
  standingGrantsEnabled: boolean;
  /** Whether Require login is on, which is what makes a permission possible at all. */
  loginEnabled: boolean;
  /** How long a new permission would last, in minutes. */
  windowMinutes: number;
}

/**
 * The two settings that decide whether "stop asking about this" is offered, read
 * from the live config (spec `agent-approval-settings` §3.0, §3.1).
 *
 * ## Why login is part of the answer
 *
 * Creating a permission needs a session cookie, and with Require login off there
 * is no cookie for anyone — so DorkOS cannot tell the person in the cockpit from
 * an agent running as the same user, and "trust this agent" is not a statement it
 * can evaluate. The server refuses either way; this is what keeps the UI from
 * offering a button that would be refused.
 *
 * The two flags stay separate rather than collapsing into {@link canGrant} alone,
 * because the surfaces answer different questions with them. The card asks "may I
 * offer this?" and uses `canGrant`. Settings asks "why can they not have this?"
 * and needs to know which of the two is missing, since only one of them has a fix
 * button next to it.
 *
 * While the config is still loading both read false, so nothing offers a
 * permission it might turn out not to be able to create.
 */
export function useStandingGrantPolicy(): StandingGrantPolicy {
  const { data: config } = useConfig();
  const standingGrantsEnabled = config?.approvals?.standingGrants ?? false;
  const loginEnabled = config?.auth?.enabled ?? false;
  return {
    canGrant: standingGrantsEnabled && loginEnabled,
    standingGrantsEnabled,
    loginEnabled,
    windowMinutes: config?.approvals?.trustWindowMinutes ?? DEFAULT_TRUST_WINDOW_MINUTES,
  };
}
