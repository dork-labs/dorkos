/**
 * The Owner-only front-door settings: the `operator-only` config paths that
 * decide who can reach DorkOS and how far it reaches, which accounts and keys
 * it holds, and which code it runs (F4 part 3, DOR-2969; ADR 261015-125850).
 *
 * `operator-only` (`config-write-policy.ts`) keeps agents away from a setting.
 * This narrower set also keeps people away who are not at this computer: a
 * signed-in owner on Wi-Fi or a tunnel can still change ordinary settings, but
 * one of these only in the app on the computer DorkOS runs on, so a device
 * reached from outside can never widen its own reach. `PATCH /api/config` runs
 * `refuseFrontDoorChange` (`lib/caller-authority.ts`) on a patch touching any
 * of them, the bar every front-door route runs.
 *
 * The set is DERIVED, not listed: every path in the `reach`, `credentials` and
 * `code` stakes of `OPERATOR_ONLY_STAKES`, minus {@link FRONT_DOOR_EXEMPT}. A
 * new path filed under one of those stakes is a front-door setting until
 * somebody exempts it with a reason, and `__tests__/front-door-settings.test.ts`
 * fails on any path that is neither.
 *
 * @module services/core/operator/front-door-settings
 */
import { OPERATOR_ONLY_STAKES, type OperatorOnlyStake } from './config-write-policy.js';

/** The stakes whose settings are front-door settings, and how a refusal names each. */
export const FRONT_DOOR_STAKES: Readonly<Partial<Record<OperatorOnlyStake, string>>> = {
  reach: 'who can reach DorkOS',
  credentials: 'the accounts and keys DorkOS uses',
  // Which code runs here, and which outside tools it attaches: the package
  // sources half of the front door.
  code: 'which code DorkOS runs',
};

/**
 * Paths in those stakes that a signed-in owner may still change from another
 * device, each with why: none of them widens reach, holds a key, or adds code.
 */
export const FRONT_DOOR_EXEMPT: Readonly<Record<string, string>> = {
  'cloud.instanceName': 'A label for this computer on the account page.',
  'cloud.linkedAccountLabel': 'A label for the linked account.',
  'cloud.credits.defaults': 'A spending choice, held to the owner bar by its own routes.',
  'cloud.credits.offer': 'A spending choice, held to the owner bar by its own routes.',
  'cloud.credits.agents': 'A spending choice, held to the owner bar by its own routes.',
  'cloud.credits.linkedTo': 'A spending choice, held to the owner bar by its own routes.',
  'heartbeats.triageOnCredits': 'A spending choice, held to the owner bar in this route.',
  'onboarding.firstRunPath': 'A record of first-run progress, written by the app.',
  'onboarding.completedAt': 'A record of first-run progress, written by the app.',
  'onboarding.dismissedAt': 'A record of first-run progress, written by the app.',
  'onboarding.priorRuntime': 'A record of first-run progress, written by the app.',
  'runtimes.claudeCode.accounts[].label': "An account's name in the app.",
  'runtimes.claudeCode.accounts[].color': "An account's colour in the app.",
  'runtimes.claudeCode.defaultAccountColor': "The default account's colour in the app.",
  'runtimes.claudeCode.dismissedFolders': 'Hides a suggestion; adds no account.',
  'extensions.dismissedApprovals': 'Dismisses a card; turns nothing on.',
  'harness.refusedHooks': 'Refusing a hook only narrows what runs.',
  'connectors.rawMcpServers[].slug': "A tool server's name; its address is front-door.",
  'connectors.rawMcpServers[].displayName': "A tool server's label; its address is front-door.",
};

/** Every path the front-door stakes cover, before exemptions. */
export const FRONT_DOOR_STAKE_PATHS: readonly string[] = OPERATOR_ONLY_STAKES.filter(
  (group) => FRONT_DOOR_STAKES[group.stake] !== undefined
).flatMap((group) => group.paths);

/** The front-door config paths, as `findOperatorOnlyPaths` names them. */
export const FRONT_DOOR_CONFIG_PATHS: ReadonlySet<string> = new Set(
  FRONT_DOOR_STAKE_PATHS.filter((path) => !(path in FRONT_DOOR_EXEMPT))
);

/**
 * The front-door paths among a patch's `operator-only` paths.
 *
 * @param paths - The patch's `operator-only` policy paths.
 * @returns The ones that are front-door settings, in order.
 */
export function frontDoorPathsOf(paths: readonly string[]): string[] {
  return paths.filter((path) => FRONT_DOOR_CONFIG_PATHS.has(path));
}

/**
 * What a refusal calls the kind of setting a path is, from its stake.
 *
 * @param path - A front-door path.
 * @returns The words for its kind, like "who can reach DorkOS".
 */
export function frontDoorSubjectOf(path: string): string {
  const group = OPERATOR_ONLY_STAKES.find((g) => g.paths.includes(path));
  return (group && FRONT_DOOR_STAKES[group.stake]) ?? 'how DorkOS is set up';
}
