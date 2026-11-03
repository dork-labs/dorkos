/**
 * The disclosure verdicts of the experiment switches and the other plain on/off
 * doors (`config-disclosure.ts` composes them into {@link CONFIG_DISCLOSURE}).
 * Split out so the main table stays under the line limit; the verdicts and the
 * drift guard are unchanged.
 *
 * @module services/core/operator/config-disclosure-experiments
 */

/** Each switch's verdict: every one is a plain boolean or a public address. */
export const EXPERIMENT_SWITCH_DISCLOSURE = {
  'browser.enabled': 'expose',
  'computers.enabled': 'expose',
  // Whether chatting from the web is on (DOR-2946): a plain boolean. The hub's
  // address and the relay secret live in the relay's own file, never in config.
  'sessionRelay.enabled': 'expose',
  // Whether the Docs experiment is on (DOR-2993): a plain boolean.
  'docs.enabled': 'expose',
  // Whether agents may set a scheduled task's mode or approve one (DOR-3703): a plain boolean.
  'tasks.agentModeControl': 'expose',
  // Whether the spaces experiment is on (DOR-2740): a plain boolean, no host.
  'spaces.enabled': 'expose',
  // The official space's public link (spec `official-community-space` D4): a
  // public address, never a credential, and the same for every install.
  'spaces.official.url': 'expose',
  // Whether outside agents may reach the ones here over A2A. A plain boolean:
  // it names no credential and no host, and an agent that learns the gate is
  // shut is no closer to opening it — the write side is where that is decided.
  'a2a.enabled': 'expose',
} as const;
