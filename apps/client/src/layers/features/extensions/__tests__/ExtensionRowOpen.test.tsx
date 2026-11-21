/**
 * An open row leads with Open for an extension that registered a page, and
 * Open goes to that extension's home page. Purpose: until the Apps home lands,
 * this is the one place a person launches an app from Settings.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { EXTENSION_CLIENT_API_VERSION, type ExtensionRecordPublic } from '@dorkos/extension-api';
import { useExtensionRegistry } from '@/layers/shared/model';
import {
  clearUndeclaredSlots,
  noteUndeclaredSlot,
} from '@/layers/shared/lib/extension-undeclared-slots';

const openLink = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  openLink,
}));

import { ExtensionRow } from '../ui/ExtensionRow';

const unregister: Array<() => void> = [];

afterEach(() => {
  cleanup();
  for (const undo of unregister.splice(0)) undo();
  openLink.mockReset();
});

/**
 * A running app on today's browser API. Without `clientApiVersion` the row
 * reads it as built for the old API ("needs an update"): its screens never
 * run, so it could never register anywhere, and the row keeps its facts,
 * the undeclared-places note among them, behind Details.
 */
function makeExtension(id: string): ExtensionRecordPublic {
  return {
    id,
    manifest: {
      id,
      name: 'Ledger',
      version: '1.0.0',
      clientApiVersion: EXTENSION_CLIENT_API_VERSION,
    },
    status: 'active',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: true,
    shadowedBy: null,
    isolation: null,
  };
}

/** Register a page the way `api.registerPage` does. */
function registerPage(extensionId: string, path: string, title: string) {
  unregister.push(
    useExtensionRegistry.getState().register('pages', {
      id: `${extensionId}:${path}`,
      extensionId,
      path,
      title,
      menu: true,
      component: () => null,
    })
  );
}

function renderOpenRow(
  extension: ExtensionRecordPublic,
  props: {
    onSetRunApproval?: (id: string, approve: boolean) => void;
    updateAvailable?: boolean;
  } = {}
) {
  render(
    <ul>
      <ExtensionRow
        extension={extension}
        open
        onOpenChange={vi.fn()}
        onToggle={vi.fn()}
        isToggling={false}
        onSetRunApproval={props.onSetRunApproval ?? vi.fn()}
        isSettingApproval={false}
        onReload={vi.fn()}
        isReloading={false}
        updateAvailable={props.updateAvailable}
      />
    </ul>
  );
}

describe('ExtensionRow: Open', () => {
  it('leads the open row and goes to the extension’s home page', async () => {
    registerPage('ledger', 'reports', 'Reports');
    registerPage('ledger', '', 'Ledger');
    registerPage('other-app', '', 'Other');
    renderOpenRow(makeExtension('ledger'));

    const region = screen.getByRole('region', { name: 'Ledger' });
    const open = screen.getByRole('button', { name: 'Open' });
    // First thing in the open row.
    expect(region.firstElementChild).toBe(open);
    await userEvent.click(open);
    expect(openLink).toHaveBeenCalledWith('/x/ledger');
  });

  it('is not offered for an extension with no page', () => {
    registerPage('other-app', '', 'Other');
    renderOpenRow(makeExtension('ledger'));

    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
  });
});

describe('ExtensionRow: places its card did not list (DOR-4282)', () => {
  afterEach(() => clearUndeclaredSlots('ledger'));

  it('names each refused place in plain words and asks for an update', () => {
    noteUndeclaredSlot('ledger', 'command-palette.items');
    noteUndeclaredSlot('ledger', 'dialog');
    renderOpenRow(makeExtension('ledger'));

    expect(screen.getByTestId('extension-undeclared-slots-ledger')).toHaveTextContent(
      'Uses places its card didn’t list: ⌘K commands, dialogs. Ask its maker to update it.'
    );
  });

  it('names places only in DorkOS’s words, dropping a key the app made up', () => {
    // An app passes whatever slot string it likes; only known keys are named.
    noteUndeclaredSlot('ledger', '<img src=x onerror=alert(1)>');
    noteUndeclaredSlot('ledger', 'dialog');
    renderOpenRow(makeExtension('ledger'));

    const note = screen.getByTestId('extension-undeclared-slots-ledger');
    expect(note).toHaveTextContent('Uses a place its card didn’t list: dialogs.');
    expect(note.textContent).not.toContain('onerror');
    expect(note.querySelector('img')).toBeNull();
  });

  it('says nothing when the only refused key is one DorkOS does not know', () => {
    noteUndeclaredSlot('ledger', '<b>bogus</b>');
    renderOpenRow(makeExtension('ledger'));

    expect(screen.queryByTestId('extension-undeclared-slots-ledger')).not.toBeInTheDocument();
  });

  it('says nothing when every place it used was declared', () => {
    renderOpenRow(makeExtension('ledger'));

    expect(screen.queryByTestId('extension-undeclared-slots-ledger')).not.toBeInTheDocument();
  });
});

describe('ExtensionRow: places kept for an old approval (DOR-4282)', () => {
  it('says to update it when an update exists, and Update opens the Installed list', async () => {
    // Allowed but not declared: kept for an old approval.
    renderOpenRow(
      { ...makeExtension('ledger'), allowedSlots: ['right-panel', 'settings.tabs'] },
      { updateAvailable: true }
    );

    const line = screen.getByTestId('extension-place-grace-ledger');
    expect(line).toHaveTextContent('Update to keep this working.');
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(openLink).toHaveBeenCalledWith('/marketplace?view=installed');
  });

  // Purpose: no Update to press when there is no newer version.
  it('says its maker needs to update it when no update exists', () => {
    renderOpenRow({ ...makeExtension('ledger'), allowedSlots: ['right-panel'] });

    const line = screen.getByTestId('extension-place-grace-ledger');
    expect(line).toHaveTextContent('Its maker needs to update it. It keeps working until then.');
    expect(line).not.toHaveTextContent('Update to keep this working.');
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  });

  it('says nothing without grace', () => {
    renderOpenRow(makeExtension('ledger'));

    expect(screen.queryByTestId('extension-place-grace-ledger')).not.toBeInTheDocument();
  });
});

describe('ExtensionRow: new places a running app waits on (DOR-4282)', () => {
  /** Running on a yes that covers its panel tab, while it now also declares a page. */
  function withNewPage(): ExtensionRecordPublic {
    const ext = makeExtension('ledger');
    return {
      ...ext,
      manifest: { ...ext.manifest, contributions: { 'right-panel': true, pages: true } },
      allowedSlots: ['right-panel'],
    };
  }

  // Purpose: after Not now in the Inbox there is still a way to allow them,
  // read from the record, with no queue row at all.
  it('says new places wait, and Allow asks through the normal approve call', async () => {
    const onSetRunApproval = vi.fn();
    renderOpenRow(withNewPage(), { onSetRunApproval });

    expect(screen.getByTestId('extension-new-places-ledger')).toHaveTextContent(
      'Adds a page. Allow when ready.'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Allow Ledger’s new places' }));
    expect(onSetRunApproval).toHaveBeenCalledWith('ledger', true);
  });

  it('says nothing once every declared place is allowed', () => {
    renderOpenRow({ ...withNewPage(), allowedSlots: ['pages', 'right-panel'] });

    expect(screen.queryByTestId('extension-new-places-ledger')).not.toBeInTheDocument();
  });

  it('says nothing for an app that is not running on a yes', () => {
    renderOpenRow({ ...withNewPage(), approvedToRun: false });

    expect(screen.queryByTestId('extension-new-places-ledger')).not.toBeInTheDocument();
  });
});

describe('ExtensionRow: an update DorkOS has not checked yet (DOR-4282)', () => {
  // Purpose: no Allow while the next check has not read the changed files.
  it('says it is checking and offers no Allow', () => {
    renderOpenRow({ ...makeExtension('ledger'), approvedToRun: false, awaitingScan: true });

    expect(screen.getByTestId('extension-checking-update-ledger')).toHaveTextContent(
      'Ledger is paused until DorkOS checks its new files.'
    );
    expect(screen.queryByTestId('extension-approve-run-ledger')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('asks for an OK with Allow once the check is done', () => {
    renderOpenRow({ ...makeExtension('ledger'), approvedToRun: false });

    expect(screen.getByTestId('extension-approve-run-ledger')).toBeInTheDocument();
  });
});
