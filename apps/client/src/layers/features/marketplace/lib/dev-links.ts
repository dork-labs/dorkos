/**
 * Pure helpers for how a dev link reads in the app (DOR-2696): the status
 * line under an Installed row, the "Reloaded 4s ago" time, and what unlinking
 * says it did. Kept out of the components so each wording is tested once.
 *
 * @module features/marketplace/lib/dev-links
 */
import type {
  DevLinkReloadedEvent,
  DevLinkStatus,
  DevUnlinkResult,
  InstalledDevLink,
  InstalledPackage,
} from '@dorkos/shared/marketplace-schemas';

/** What the status line under a dev-linked row says. */
export type DevLinkRowStatus =
  | { kind: 'folder-missing' }
  | { kind: 'link-missing' }
  | { kind: 'link-replaced' }
  | { kind: 'reload-failed'; at: string; headline: string; details: string[] }
  | { kind: 'reloaded'; at: string }
  | { kind: 'watching' };

/**
 * The server's sentence for one extension that didn't build after an edit
 * (`dev-link-watcher.ts`: "`<id>` didn't build: `<error>`"). Read to name the
 * extension in the headline; any other sentence still shows under Details.
 */
const DID_NOT_BUILD = /^(\S+) didn't build:/;

/**
 * The headline for a reload that hit errors: names the extension when exactly
 * one didn't build, otherwise says it plainly. The full sentences go under
 * Details.
 *
 * @param errors - The event's own sentences, one per thing that didn't reload.
 */
export function reloadFailureHeadline(errors: readonly string[]): string {
  const match = errors.length === 1 ? DID_NOT_BUILD.exec(errors[0]!) : null;
  return match
    ? `Couldn’t reload: ${match[1]} has a build error.`
    : 'Couldn’t reload your last edit.';
}

/**
 * What the status line says for a dev-linked row. A link that isn't in force
 * says so first; otherwise the newest reload this app heard about wins over the
 * listing's `lastReloadAt`, because only the event says whether it failed.
 *
 * @param devLink - The row's dev-link fields.
 * @param reload - The last reload event this app received for it, if any.
 * @param lastReloadAt - When the server says it last reloaded, if it has.
 */
export function devLinkRowStatus(
  devLink: InstalledDevLink,
  reload: DevLinkReloadedEvent | undefined,
  lastReloadAt: string | undefined
): DevLinkRowStatus {
  if (devLink.state !== 'active') return { kind: devLink.state };
  const eventIsNewest =
    reload !== undefined && (lastReloadAt === undefined || reload.at >= lastReloadAt);
  if (eventIsNewest && reload.errors && reload.errors.length > 0) {
    return {
      kind: 'reload-failed',
      at: reload.at,
      headline: reloadFailureHeadline(reload.errors),
      details: reload.errors,
    };
  }
  const at = eventIsNewest ? reload.at : lastReloadAt;
  return at ? { kind: 'reloaded', at } : { kind: 'watching' };
}

/**
 * "Reloaded just now", "Reloaded 4s ago", "Reloaded 3m ago", "Reloaded 2h ago",
 * then a date. Seconds matter here: a person saves and looks for the change.
 *
 * @param at - When it reloaded. ISO 8601.
 * @param now - The current time, in milliseconds.
 */
export function formatReloadedAgo(at: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(at).getTime()) / 1000));
  if (seconds < 2) return 'Reloaded just now';
  if (seconds < 60) return `Reloaded ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Reloaded ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Reloaded ${hours}h ago`;
  return `Reloaded ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** Which dev link an installed row is: its scope and project, for unlink. */
export function devLinkScopeOf(installation: InstalledPackage): {
  scope: 'global' | 'project';
  projectPath?: string;
} {
  return installation.agentPath
    ? { scope: 'project', projectPath: installation.agentPath }
    : { scope: 'global' };
}

/**
 * The listing's entry for an installed row, matched by name, scope and project.
 *
 * @param links - Every dev link, as the listing reports them.
 * @param installation - The installed row.
 */
export function findDevLinkStatus(
  links: readonly DevLinkStatus[] | undefined,
  installation: InstalledPackage
): DevLinkStatus | undefined {
  const { scope, projectPath } = devLinkScopeOf(installation);
  return links?.find(
    (link) =>
      link.name === installation.name &&
      link.scope === scope &&
      (scope === 'global' || link.projectPath === projectPath)
  );
}

/** What the unlink toast says: a title and, when needed, one more line. */
export interface UnlinkOutcomeCopy {
  /** The toast's title. */
  title: string;
  /** A second line, for what didn't go as planned. */
  description?: string;
}

/**
 * What unlinking did, said without overstating it. Only `restored:
 * 'installed'` means the installed copy is running again; a set-aside copy that
 * couldn't come back, or something else found in the link's place, is named.
 *
 * @param name - The package's display name.
 * @param result - What the server says unlink did.
 */
export function unlinkOutcomeCopy(name: string, result: DevUnlinkResult): UnlinkOutcomeCopy {
  if (result.restored === 'installed') return { title: `${name} runs from the installed copy.` };
  if (result.parkedLeftAt) {
    return {
      title: `${name} unlinked. Its installed copy couldn’t come back.`,
      description: `It’s still set aside at ${result.parkedLeftAt}.`,
    };
  }
  if (result.leftInPlace) {
    return {
      title: `${name} unlinked.`,
      description: 'Something else was in its place. It was left as it is.',
    };
  }
  return { title: `${name} removed.` };
}
