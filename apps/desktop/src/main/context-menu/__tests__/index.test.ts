import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { applyContextMenu, buildContextMenuTemplate, type ContextMenuTarget } from '../index';
import { createWindow, isWebLink } from '../../window-manager';
import { resetWindowStateModule } from '../../window-state';
import {
  BrowserWindow as MockBrowserWindow,
  clipboard,
  lastBuiltMenu,
  Menu,
  resetElectronMock,
  session,
  shell,
} from '../../__tests__/electron-mock';

/**
 * The desktop shell's right-click menu (DOR-1297). Until it existed, Electron
 * showed nothing at all on a right-click — no copy/paste on an input, no "Copy
 * Link Address" on an anchor, no spelling suggestions.
 *
 * The template builder is tested as the pure function it is, and every item
 * that does something is CLICKED rather than merely found by label: "a menu has
 * a Copy Link Address row" and "that row puts the href on the clipboard" are
 * different claims.
 */

/** A right-click on empty page background — no field, no link, no selection. */
function target(overrides: Partial<ContextMenuTarget> = {}): ContextMenuTarget {
  return {
    isEditable: false,
    editFlags: {},
    linkURL: '',
    selectionText: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    ...overrides,
  };
}

/** The labels and roles of a template, in order, for readable whole-menu assertions. */
function shape(template: Electron.MenuItemConstructorOptions[]): string[] {
  return template.map((item) => item.label ?? item.role ?? item.type ?? '?');
}

/** Click the item with `label`, failing loudly rather than silently passing if it is absent. */
function click(template: Electron.MenuItemConstructorOptions[], label: string): void {
  const item = template.find((entry) => entry.label === label);
  if (!item?.click) throw new Error(`no clickable item labelled "${label}" in ${shape(template)}`);
  item.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
}

/** A stand-in renderer for the builder's spelling actions. */
function fakeWebContents(): WebContents & {
  replaceMisspelling: ReturnType<typeof vi.fn>;
} {
  return {
    replaceMisspelling: vi.fn(),
    session: session.defaultSession,
  } as unknown as WebContents & { replaceMisspelling: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  resetElectronMock();
  resetWindowStateModule();
});

describe('buildContextMenuTemplate', () => {
  it('offers the standard editing items over an editable field', () => {
    const template = buildContextMenuTemplate(
      fakeWebContents(),
      target({ isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true } }),
      isWebLink
    );

    expect(shape(template)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'separator',
      'selectAll',
    ]);
  });

  it('greys out what Chromium says the field cannot do', () => {
    const template = buildContextMenuTemplate(
      fakeWebContents(),
      target({
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: true, canUndo: false },
      }),
      isWebLink
    );

    const byRole = new Map(template.map((item) => [item.role, item.enabled]));
    expect(byRole.get('cut')).toBe(false);
    expect(byRole.get('copy')).toBe(false);
    expect(byRole.get('undo')).toBe(false);
    expect(byRole.get('paste')).toBe(true);
  });

  it('offers a lone Copy over a selection that is not editable', () => {
    const template = buildContextMenuTemplate(
      fakeWebContents(),
      target({ selectionText: "a turn's output", editFlags: { canCopy: true } }),
      isWebLink
    );

    expect(shape(template)).toEqual(['copy']);
  });

  it('shows nothing on empty page background rather than an all-greyed menu', () => {
    expect(buildContextMenuTemplate(fakeWebContents(), target(), isWebLink)).toEqual([]);
    // Whitespace is not a selection.
    expect(
      buildContextMenuTemplate(fakeWebContents(), target({ selectionText: '  \n ' }), isWebLink)
    ).toEqual([]);
  });

  it('opens and copies a link, through the shell rule the window guards use', () => {
    const template = buildContextMenuTemplate(
      fakeWebContents(),
      target({ linkURL: 'https://dorkos.ai/docs' }),
      isWebLink
    );

    expect(shape(template)).toEqual(['Open Link in Browser', 'Copy Link Address']);

    click(template, 'Open Link in Browser');
    expect(shell.openExternal).toHaveBeenCalledWith('https://dorkos.ai/docs');

    click(template, 'Copy Link Address');
    expect(clipboard.writeText).toHaveBeenCalledWith('https://dorkos.ai/docs');
  });

  it('keeps both sections, separated, on a link inside an editable field', () => {
    // A contenteditable composer holding an anchor: Chromium reports
    // `isEditable` AND a `linkURL`, and both sections have something to say.
    const template = buildContextMenuTemplate(
      fakeWebContents(),
      target({
        isEditable: true,
        linkURL: 'https://dorkos.ai/docs',
        editFlags: { canCut: true, canCopy: true, canPaste: true },
      }),
      isWebLink
    );

    expect(shape(template)).toEqual([
      'Open Link in Browser',
      'Copy Link Address',
      'separator',
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'separator',
      'selectAll',
    ]);

    // The link items are the ones that act on the anchor, not on the field.
    click(template, 'Copy Link Address');
    expect(clipboard.writeText).toHaveBeenCalledWith('https://dorkos.ai/docs');
  });

  it('offers no link items for a scheme the shell would refuse to open', () => {
    const template = buildContextMenuTemplate(
      fakeWebContents(),
      target({ linkURL: 'file:///Users/someone/.ssh/id_rsa', selectionText: 'id_rsa' }),
      isWebLink
    );

    expect(shape(template)).toEqual(['copy']);
  });

  it('lists spelling suggestions and applies the one that is clicked', () => {
    const webContents = fakeWebContents();
    const template = buildContextMenuTemplate(
      webContents,
      target({
        isEditable: true,
        misspelledWord: 'reciept',
        dictionarySuggestions: ['receipt', 'recipe'],
      }),
      isWebLink
    );

    expect(shape(template).slice(0, 5)).toEqual([
      'receipt',
      'recipe',
      'separator',
      'Add to Dictionary',
      'separator',
    ]);

    click(template, 'recipe');
    expect(webContents.replaceMisspelling).toHaveBeenCalledWith('recipe');

    click(template, 'Add to Dictionary');
    expect(session.defaultSession.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('reciept');
  });

  it('still explains itself when the dictionary has no correction to offer', () => {
    const template = buildContextMenuTemplate(
      fakeWebContents(),
      target({ isEditable: true, misspelledWord: 'dorkos', dictionarySuggestions: [] }),
      isWebLink
    );

    expect(template[0]).toMatchObject({ label: 'No spelling suggestions', enabled: false });
    expect(shape(template)).toContain('Add to Dictionary');
  });
});

describe('applyContextMenu', () => {
  it('pops the built menu up over its own window', async () => {
    const win = new MockBrowserWindow();
    applyContextMenu(win as unknown as BrowserWindow, isWebLink);

    await win.webContents.emit('context-menu', {}, target({ isEditable: true }));

    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(lastBuiltMenu()?.popup).toHaveBeenCalledWith({ window: win });
  });

  it('pops nothing up when there is nothing to show', async () => {
    const win = new MockBrowserWindow();
    applyContextMenu(win as unknown as BrowserWindow, isWebLink);

    await win.webContents.emit('context-menu', {}, target());

    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
  });

  it('does not popup over a window that was destroyed mid-click', async () => {
    const win = new MockBrowserWindow();
    applyContextMenu(win as unknown as BrowserWindow, isWebLink);
    win.isDestroyed.mockReturnValue(true);

    await win.webContents.emit('context-menu', {}, target({ isEditable: true }));

    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
  });
});

describe('createWindow — the right-click menu is installed', () => {
  it('registers the handler on every window it makes', async () => {
    createWindow();
    const win = MockBrowserWindow.instances[0];

    expect(win.webContents.on).toHaveBeenCalledWith('context-menu', expect.any(Function));

    // And it is the real one: a right-click in a text field shows a menu.
    await win.webContents.emit('context-menu', {}, target({ isEditable: true }));
    expect(lastBuiltMenu()?.popup).toHaveBeenCalledWith({ window: win });
  });
});
