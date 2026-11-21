/**
 * The places in DorkOS an app may show itself, as `extension.json` declares
 * them in `contributions` (DOR-4282).
 *
 * The map is binding: DorkOS shows an app only in the places it declares, and
 * the approval card names each one. A registration in a place the manifest
 * does not declare is refused (the app sees a console warning and nothing is
 * drawn), and an update that declares a new place asks the person again.
 *
 * @module @dorkos/extension-api/contribution-slots
 */
import type { ExtensionPointId } from './extension-api.js';

/**
 * Every key `contributions` may set to `true`, in the order an approval card
 * lists them. The seven {@link ExtensionPointId} slots, plus:
 *
 * - `pages`: `registerPage`, a page of its own at `/x/<id>/…`.
 * - `canvas`: `openCanvas`, documents it opens on the canvas.
 * - `inbox`: `ctx.inbox` on the server, cards it raises in the Inbox.
 *
 * Any other key is ignored.
 */
export const EXTENSION_CONTRIBUTION_KEYS = [
  'pages',
  'right-panel',
  'dashboard.sections',
  'settings.tabs',
  'status-bar',
  'command-palette.items',
  'dialog',
  'sidebar.footer',
  'canvas',
  'inbox',
] as const satisfies readonly (ExtensionPointId | 'pages' | 'canvas' | 'inbox')[];

/** One place an app may declare in `contributions`. */
export type ExtensionContributionKey = (typeof EXTENSION_CONTRIBUTION_KEYS)[number];

/**
 * Each place in plain words, with its article, as the approval card and the
 * install preview name it ("This adds a page and ⌘K commands").
 */
export const CONTRIBUTION_WORDS: Readonly<Record<ExtensionContributionKey, string>> = {
  pages: 'a page',
  'right-panel': 'a panel tab',
  'dashboard.sections': 'an Activity section',
  'settings.tabs': 'a Settings page',
  'status-bar': 'a status bar item',
  'command-palette.items': '⌘K commands',
  dialog: 'dialogs',
  'sidebar.footer': 'a sidebar item',
  canvas: 'canvas documents',
  inbox: 'Inbox cards',
};

/**
 * The only places an app approved before places were recorded may keep
 * showing without declaring them, until its files change (DOR-4282): a panel
 * tab and a Settings page, which its old card named, and a page, only when
 * the card text saved with that yes said so. DorkOS decides which of these
 * one app keeps; the app's screen honours no other, so ⌘K, dialogs, the
 * status bar, the Inbox and the canvas always need declaring.
 */
export const GRACE_CONTRIBUTION_KEYS = [
  'pages',
  'right-panel',
  'settings.tabs',
] as const satisfies readonly ExtensionContributionKey[];

/**
 * Whether `key` is one of {@link EXTENSION_CONTRIBUTION_KEYS}.
 *
 * @param key - A key from a manifest or a stored approval.
 */
export function isContributionKey(key: string): key is ExtensionContributionKey {
  return (EXTENSION_CONTRIBUTION_KEYS as readonly string[]).includes(key);
}

/**
 * Whether a manifest declares one place: its `contributions[key]` is exactly
 * `true`. Anything else, including a missing map, declares nothing.
 *
 * @param manifest - The manifest, or the part of it that holds `contributions`.
 * @param key - The place.
 */
export function declaresContribution(
  manifest: { contributions?: Record<string, boolean> } | undefined,
  key: ExtensionContributionKey
): boolean {
  return manifest?.contributions?.[key] === true;
}

/**
 * The places a manifest declares, in card order, unknown keys left out.
 *
 * @param manifest - The manifest, or the part of it that holds `contributions`.
 */
export function declaredContributions(
  manifest: { contributions?: Record<string, boolean> } | undefined
): ExtensionContributionKey[] {
  return EXTENSION_CONTRIBUTION_KEYS.filter((key) => declaresContribution(manifest, key));
}

/**
 * Places in plain words, in card order, for any list of keys. Unknown keys
 * are left out, so a stored or echoed list can never put its own words on a
 * card.
 *
 * @param keys - Place keys, in any order.
 */
export function contributionWords(keys: readonly string[]): string[] {
  return EXTENSION_CONTRIBUTION_KEYS.filter((key) => keys.includes(key)).map(
    (key) => CONTRIBUTION_WORDS[key]
  );
}
