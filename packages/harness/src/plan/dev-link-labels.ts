/**
 * How a projection says it comes from a dev link (DOR-2696, spec
 * `marketplace-dev-link` §5): the marker line in a generated command wrapper,
 * the key on a managed hook group, and the `(dev link: <folder>)` label on
 * every planned action. Labels only: ownership stays with
 * `GENERATED_COMMAND_MARKER` and `_dorkosHarness`, so when the dev link goes,
 * the next sync rewrites or sweeps its projections exactly as for any package.
 *
 * @module plan/dev-link-labels
 */
import type { ProjectionAction } from './types.js';
import type { InstalledPlugin } from '../sources/installed.js';

/**
 * The marker on every projection of a package that runs from a registered dev
 * link (DOR-2696): a second comment line in each generated command wrapper,
 * `<!-- dorkos:dev-link <folder> -->`, beside `GENERATED_COMMAND_MARKER`.
 * A label, never an ownership predicate: the generated marker still decides
 * what the sweep may prune, so a wrapper keeps its owner when the dev link goes
 * and its next sync rewrites it without this line.
 */
export const DEV_LINK_MARKER = 'dorkos:dev-link';

/**
 * The key a managed hook group carries beside `_dorkosHarness`
 * when its package runs from a registered dev link: the folder it runs from.
 * Like {@link DEV_LINK_MARKER}, a label only; ownership stays with the sentinel.
 */
export const MANAGED_HOOK_DEV_LINK_KEY = '_dorkosDevLink';

/**
 * How every surface labels a projection of a dev-linked package: the plan's
 * note on each of its actions, the drop list, `dorkos harness sync` and the
 * harness status page all print this, so they say one thing.
 *
 * @param folder - The working folder the dev link points at.
 * @returns `(dev link: <folder>)`.
 */
export function devLinkLabel(folder: string): string {
  return `(dev link: ${folder})`;
}

/**
 * The dev-link marker line for a generated command wrapper. A folder whose name
 * holds `-->` would otherwise close the comment early and leak the rest of its
 * name into the command text, so that sequence is escaped.
 *
 * @param folder - The working folder the dev link points at.
 * @returns `<!-- dorkos:dev-link <folder> -->`.
 */
export function devLinkMarkerLine(folder: string): string {
  return `<!-- ${DEV_LINK_MARKER} ${folder.split('-->').join('--&gt;')} -->`;
}

/**
 * A generated wrapper's marker lines: the generated marker, followed by the
 * dev-link marker when the package runs from a dev link.
 *
 * @param generatedLine - The wrapper's `GENERATED_COMMAND_MARKER` line.
 * @param devLink - The dev link's folder, or `undefined` for an installed copy.
 * @returns The line or lines to insert.
 */
export function withDevLinkMarker(generatedLine: string, devLink: string | undefined): string {
  return devLink === undefined ? generatedLine : `${generatedLine}\n${devLinkMarkerLine(devLink)}`;
}

/**
 * Label every action planned from a dev-linked package: the folder on
 * {@link ProjectionAction.devLink}, and {@link devLinkLabel} appended to its
 * note. Actions of an installed copy pass through untouched.
 *
 * @param actions - Actions planned from one package.
 * @param plugin - That package.
 * @returns The same actions, labelled when the package runs from a dev link.
 */
export function labelDevLinkActions(
  actions: ProjectionAction[],
  plugin: Pick<InstalledPlugin, 'devLink'>
): ProjectionAction[] {
  const folder = plugin.devLink?.path;
  if (folder === undefined) return actions;
  const label = devLinkLabel(folder);
  for (const action of actions) {
    action.devLink = folder;
    action.reason = action.reason === undefined ? label : `${action.reason} ${label}`;
  }
  return actions;
}
