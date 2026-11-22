/**
 * The full text of an update approval card: every reinstall, where it is, from
 * which version to which, and everything its new version would run.
 *
 * A person approving an update approves new code: hook commands that run in
 * their sessions, scheduled jobs, and MCP servers that start in every session a
 * global plugin loads in. So this is the card's `detail`, the one field a
 * person reads in full, and every value is written out whole and escaped
 * (`JSON.stringify`) rather than shortened the way the summary sentence is: a
 * command cut at 80 characters is a command nobody read. When the whole list
 * cannot fit on a card, the caller refuses rather than cut it
 * ({@link UPDATE_DETAIL_MAX_LENGTH}).
 *
 * @module services/marketplace-mcp/update-approval-detail
 */
import { APPROVAL_DETAIL_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import { revealHiddenCharacters } from '@dorkos/shared/marketplace-schemas';
import { describePackageInFull } from '../marketplace/preview/extension-disclosure.js';
import type { ApprovableUpdate } from '../marketplace/flows/update-installed.js';

/** The longest detail a card stores; a longer list is refused, never cut. */
export const UPDATE_DETAIL_MAX_LENGTH = APPROVAL_DETAIL_MAX_LENGTH;

/**
 * Said under each app an update brings. An app's code runs only on a person's
 * yes to its exact files, so new code waits in Activity however an earlier
 * version was approved (DOR-4895). A source the person trusts outright
 * (`extensions.trustedSources`) runs without asking. An update that only adds
 * places brings no new code, keeps running and asks only for those places
 * (`places-only-update.ts`), which "any" leaves true.
 */
export const UPDATE_APP_WAITS =
  'Any new code waits for your OK in Activity, unless you trust its source.';

/**
 * The most apps an update says {@link UPDATE_APP_WAITS} under one by one. Past
 * it the line is said once for the package ({@link updateAppsWait}), so a
 * many-app update is not pushed past what a card can hold and refused.
 */
export const UPDATE_APP_NOTE_PER_APP_MAX = 3;

/**
 * {@link UPDATE_APP_WAITS}, said once for every app an update brings.
 *
 * @param count - How many apps it brings.
 */
export function updateAppsWait(count: number): string {
  return `All ${count.toLocaleString('en-US')} mini apps: any new code waits in Activity, unless you trust its source.`;
}

/**
 * The line said under each app of this update, or none when it brings too many
 * to say it each time.
 *
 * @param update - The reinstall.
 */
export function perAppWaitNote(update: ApprovableUpdate): string | undefined {
  const count = update.extensions?.length ?? 0;
  return count <= UPDATE_APP_NOTE_PER_APP_MAX ? UPDATE_APP_WAITS : undefined;
}

/**
 * The line said once for this update's apps, when there are too many to say it
 * under each.
 *
 * @param update - The reinstall.
 */
export function packageWaitNote(update: ApprovableUpdate): string | undefined {
  const count = update.extensions?.length ?? 0;
  return count > UPDATE_APP_NOTE_PER_APP_MAX ? updateAppsWait(count) : undefined;
}

/**
 * A value written out whole, quoted and escaped, with every hidden or
 * direction-changing character shown, so it cannot forge the text around it.
 */
const whole = (value: string): string => revealHiddenCharacters(JSON.stringify(value));

/**
 * Where one installation is, in words.
 *
 * @param update - The reinstall.
 */
export function placeOf(update: ApprovableUpdate): string {
  if (update.scope === 'global' || update.projectPath === undefined) return 'installed globally';
  const agent = update.agentName ? ` for ${whole(update.agentName)}` : '';
  return `installed in ${whole(update.projectPath)}${agent}`;
}

/**
 * When a plugin's own programs start, for this installation: a global plugin is
 * loaded into every session (`plugin-activation.ts`); a project's copy is
 * projected as files, and its MCP and language servers, monitors and `bin/`
 * commands are not among them.
 *
 * @param update - The reinstall.
 */
export function whenProgramsStart(update: ApprovableUpdate): string {
  return update.scope === 'global'
    ? 'in every chat'
    : 'declared, but not started for a project install';
}

/**
 * Every reinstall, one block each, in the order given.
 *
 * @param updates - The reinstalls a person is asked to approve.
 * @returns The card's detail text. May exceed {@link UPDATE_DETAIL_MAX_LENGTH};
 *   the caller refuses rather than store a cut list.
 */
export function describeUpdatesInFull(updates: readonly ApprovableUpdate[]): string {
  return updates
    .map((update) => {
      const once = packageWaitNote(update);
      return [
        `${whole(update.packageName)} (${update.type}, ${placeOf(update)}): ${whole(update.installedVersion)} → ${whole(update.latestVersion)}`,
        `  at ${whole(update.installPath)}`,
        ...describePackageInFull(
          update.disclosed,
          update.extensions,
          whenProgramsStart(update),
          perAppWaitNote(update)
        ),
        ...(once ? [`  ${once}`] : []),
      ].join('\n');
    })
    .join('\n\n');
}
