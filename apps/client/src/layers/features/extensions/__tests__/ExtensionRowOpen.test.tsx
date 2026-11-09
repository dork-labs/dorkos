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
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { useExtensionRegistry } from '@/layers/shared/model';

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

function makeExtension(id: string): ExtensionRecordPublic {
  return {
    id,
    manifest: { id, name: 'Ledger', version: '1.0.0' },
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

function renderOpenRow(extension: ExtensionRecordPublic) {
  render(
    <ul>
      <ExtensionRow
        extension={extension}
        open
        onOpenChange={vi.fn()}
        onToggle={vi.fn()}
        isToggling={false}
        onSetRunApproval={vi.fn()}
        isSettingApproval={false}
        onReload={vi.fn()}
        isReloading={false}
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
