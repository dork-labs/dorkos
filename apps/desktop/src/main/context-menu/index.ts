import { clipboard, Menu, shell } from 'electron';
import type { BrowserWindow, ContextMenuParams, Event, WebContents } from 'electron';

/**
 * The right-click menu the desktop shell shows over the cockpit.
 *
 * A browser gives every page a native context menu for free. Electron does
 * not: Chromium hands the embedder a `context-menu` event and shows nothing of
 * its own, so **an app that registers no handler has no right-click at all** —
 * no copy/paste on an input, no "Copy Link Address" on an anchor, no spelling
 * suggestions. That is what the desktop app shipped with until this file
 * (DOR-1297).
 *
 * Hand-rolled rather than `electron-context-menu` for two reasons: the whole
 * policy is the ~60 lines below, and the shell's one rule about what may leave
 * for the system browser already lives in `window-manager.ts` — a library would
 * have brought its own answer to that question.
 *
 * **The cockpit's own menus still win.** Chromium only raises this event when
 * the page did not call `preventDefault()` on its `contextmenu` DOM event, and
 * every DorkOS row menu is a Radix context menu, which does exactly that on its
 * trigger. So a right-click on a room row opens the app's menu and this one
 * never fires; a right-click on a text field, an anchor or a transcript reaches
 * here because nothing in the renderer claimed it.
 *
 * @module main/context-menu/index
 */

/**
 * What Chromium says about the thing that was right-clicked.
 *
 * A structural narrowing of Electron's `ContextMenuParams` — the six fields the
 * menu is built from — so {@link buildContextMenuTemplate} can be called with a
 * plain object in tests instead of a 30-field fixture. A real `ContextMenuParams`
 * satisfies it.
 */
export interface ContextMenuTarget {
  /** Whether the click landed in an editable field (input, textarea, contenteditable). */
  isEditable: boolean;
  /** Chromium's per-command availability for the focused field. */
  editFlags: Partial<ContextMenuParams['editFlags']>;
  /** The href of the anchor that was clicked, or `''`. */
  linkURL: string;
  /** The text currently selected, or `''`. */
  selectionText: string;
  /** The misspelled word under the cursor, or `''` when the spellchecker is happy. */
  misspelledWord: string;
  /** Corrections the spellchecker offers for {@link ContextMenuTarget.misspelledWord}. */
  dictionarySuggestions: string[];
}

/** Nothing worth showing a menu for — see {@link buildContextMenuTemplate}. */
const EMPTY_MENU: Electron.MenuItemConstructorOptions[] = [];

/** The spelling section: the corrections themselves, then "Add to Dictionary". */
function spellingItems(
  webContents: WebContents,
  target: ContextMenuTarget
): Electron.MenuItemConstructorOptions[] {
  if (!target.misspelledWord) return EMPTY_MENU;
  const suggestions: Electron.MenuItemConstructorOptions[] = target.dictionarySuggestions.map(
    (suggestion) => ({
      label: suggestion,
      click: () => webContents.replaceMisspelling(suggestion),
    })
  );
  // A word the dictionary flags but has no correction for still gets a row, so
  // the menu explains itself instead of opening on "Add to Dictionary" alone.
  if (suggestions.length === 0) {
    suggestions.push({ label: 'No spelling suggestions', enabled: false });
  }
  return [
    ...suggestions,
    { type: 'separator' },
    {
      label: 'Add to Dictionary',
      click: () => webContents.session.addWordToSpellCheckerDictionary(target.misspelledWord),
    },
  ];
}

/**
 * The link section. `isWebLink` decides what may leave for the system browser,
 * so only an `http(s)` anchor offers to open there — the same rule the window's
 * link guards apply, asked of the same function.
 */
function linkItems(
  target: ContextMenuTarget,
  isWebLink: (url: string) => boolean
): Electron.MenuItemConstructorOptions[] {
  if (!target.linkURL || !isWebLink(target.linkURL)) return EMPTY_MENU;
  return [
    { label: 'Open Link in Browser', click: () => void shell.openExternal(target.linkURL) },
    { label: 'Copy Link Address', click: () => clipboard.writeText(target.linkURL) },
  ];
}

/**
 * The editing section: the standard six over an editable field, or a lone
 * "Copy" over a selection that cannot be edited.
 *
 * Roles rather than hand-written clicks, so each item carries the platform's
 * own label conventions and keyboard shortcut. `enabled` comes from Chromium's
 * `editFlags` — a role does not grey itself out, and a "Paste" that pastes
 * nothing into a read-only field is worse than one that is visibly unavailable.
 */
function editingItems(target: ContextMenuTarget): Electron.MenuItemConstructorOptions[] {
  const flags = target.editFlags;
  if (!target.isEditable) {
    return target.selectionText.trim()
      ? [{ role: 'copy', enabled: flags.canCopy ?? true }]
      : EMPTY_MENU;
  }
  return [
    { role: 'undo', enabled: flags.canUndo ?? true },
    { role: 'redo', enabled: flags.canRedo ?? true },
    { type: 'separator' },
    { role: 'cut', enabled: flags.canCut ?? true },
    { role: 'copy', enabled: flags.canCopy ?? true },
    { role: 'paste', enabled: flags.canPaste ?? true },
    { type: 'separator' },
    { role: 'selectAll', enabled: flags.canSelectAll ?? true },
  ];
}

/**
 * Build the menu for one right-click, or an empty template when there is
 * nothing useful to offer.
 *
 * Empty is a real answer and the common one: right-clicking the background of a
 * page — no field, no link, no selection — shows nothing, rather than a menu
 * whose every item is greyed out. (Chromium's own would offer Back/Forward/
 * Reload there; a single-page app with no navigation chrome has no use for them,
 * and "Reload" in particular is a trap next to a streaming turn.)
 *
 * Exported for its tests: the sections are decided here, and popping the menu
 * up ({@link applyContextMenu}) is the only part that needs a real Chromium.
 *
 * @param webContents - The renderer that was clicked; spelling corrections are
 *   applied back through it.
 * @param target - What Chromium says was under the cursor.
 * @param isWebLink - The shell's rule for what may open in the system browser
 *   (`window-manager.ts`'s `isWebLink`), injected the way the permission policy
 *   takes its origin test — one answer to "is this an outbound link?", not a
 *   second one that could drift.
 */
export function buildContextMenuTemplate(
  webContents: WebContents,
  target: ContextMenuTarget,
  isWebLink: (url: string) => boolean
): Electron.MenuItemConstructorOptions[] {
  const sections = [
    spellingItems(webContents, target),
    linkItems(target, isWebLink),
    editingItems(target),
  ].filter((section) => section.length > 0);

  return sections.flatMap((section, index) =>
    index === 0 ? section : [{ type: 'separator' as const }, ...section]
  );
}

/**
 * Give `win` its right-click menu. Called once per window, from `createWindow`
 * alongside the link and permission policies.
 *
 * @param win - The window to attach to.
 * @param isWebLink - See {@link buildContextMenuTemplate}.
 */
export function applyContextMenu(win: BrowserWindow, isWebLink: (url: string) => boolean): void {
  win.webContents.on('context-menu', (_event: Event, params: ContextMenuParams) => {
    if (win.isDestroyed()) return;
    const template = buildContextMenuTemplate(win.webContents, params, isWebLink);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}
