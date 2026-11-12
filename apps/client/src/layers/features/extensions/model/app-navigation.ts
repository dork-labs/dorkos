/**
 * Where an app may send the person (DOR-3293): core routes, its own pages,
 * and a page of an app it lists in `capabilities.http.apps` with
 * `navigate: true`, by the item's path alone.
 *
 * One answer for both the API's `navigate` and the frame bridge, which hands
 * the refusal back to the app instead of failing silently. The other app's
 * manifest comes from DorkOS's own records ({@link runningAppManifest}).
 *
 * @module features/extensions/model/app-navigation
 */
import {
  decideAppNavigate,
  type AppNavigateResultRefusal,
  type CrossAppManifest,
} from '@dorkos/extension-api';
import { internalRoutePath } from '@/layers/shared/lib/link-navigation';
import {
  EXTENSION_PAGE_PREFIX,
  parseExtensionPagePath,
} from '@/layers/shared/lib/extension-page-path';
import { runningAppManifest } from '../frame/running-apps';

/** What the app's maker reads when a navigation is refused. */
const REFUSAL_TEXT: Record<AppNavigateResultRefusal, string> = {
  'not-declared':
    'List that app in capabilities.http.apps as { "id": …, "navigate": true } to open its pages.',
  self: 'Open your own pages without naming another app.',
  'target-unavailable': 'That app is not installed or not turned on.',
  'not-an-item-path':
    'Link to the item’s page only: no query, hash or encoded characters, at most 8 parts.',
  'unknown-route': 'DorkOS has no page at that address.',
  'no-gesture': 'Open another app’s page only right after a click or key press in your app.',
};

/** Where to go, and whether it is another app's page, or why not. */
export type AppNavigation =
  | { ok: true; to: string; otherApp: boolean }
  | { ok: false; reason: AppNavigateResultRefusal; message: string };

/** A refusal with its sentence. */
export const refuseNavigation = (reason: AppNavigateResultRefusal): AppNavigation => ({
  ok: false,
  reason,
  message: REFUSAL_TEXT[reason],
});

/**
 * Check one address an app asked to open.
 *
 * @param caller - The app's manifest, from DorkOS's records.
 * @param path - The address, exactly as the app wrote it.
 * @param opts.otherApps - Whether a page of another app may be opened at all.
 *   Only the app's own screens may; a decision's answer from its server may not.
 * @returns The router path, or why it was refused.
 */
export function resolveAppNavigation(
  caller: CrossAppManifest,
  path: string,
  opts: { otherApps: boolean }
): AppNavigation {
  const to = internalRoutePath(path);
  if (to === null) return refuseNavigation('unknown-route');
  const pathname = new URL(to, 'http://x.invalid').pathname;
  if (!pathname.startsWith(EXTENSION_PAGE_PREFIX)) return { ok: true, to, otherApp: false };
  const page = parseExtensionPagePath(pathname);
  if (page === null) return refuseNavigation('unknown-route');
  if (page.extensionId === caller.id) return { ok: true, to, otherApp: false };
  // Another app's page (spec `flow-multiproject` invariant 11, widened only here).
  if (!opts.otherApps) return refuseNavigation('not-declared');
  const prefix = `${EXTENSION_PAGE_PREFIX}${page.extensionId}`;
  // The string as written, so nothing the URL parser tidies away (a `..`, a
  // stray `?`) decides where the person lands.
  if (to !== path || !path.startsWith(prefix)) return refuseNavigation('not-an-item-path');
  const decision = decideAppNavigate({
    caller,
    target: runningAppManifest(page.extensionId),
    targetId: page.extensionId,
    itemPath: path.slice(prefix.length),
  });
  return decision.ok ? { ok: true, to, otherApp: true } : refuseNavigation(decision.reason);
}
