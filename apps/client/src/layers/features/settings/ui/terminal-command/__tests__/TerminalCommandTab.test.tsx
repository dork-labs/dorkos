/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalCommandBridge, TerminalCommandStatus } from '@/layers/shared/lib';
import { settingsTabsFor } from '@/layers/shared/lib';
import { TerminalCommandTab } from '../TerminalCommandTab';

const ADVICE = {
  path: '~/.local/bin/dorkos',
  shellFile: '~/.zshrc',
  line: "alias dorkos='~/.local/bin/dorkos'",
};

function bridge(status: TerminalCommandStatus, overrides: Partial<TerminalCommandBridge> = {}) {
  return {
    status: vi.fn(async () => status),
    install: vi.fn(
      async () => ({ state: 'installed', path: ADVICE.path }) as TerminalCommandStatus
    ),
    remove: vi.fn(async () => ({ state: 'not-installed' }) as TerminalCommandStatus),
    ...overrides,
  };
}

const text = () => document.body.textContent ?? '';

describe('TerminalCommandTab', () => {
  it('state 1: offers Install, with no admin password', async () => {
    render(<TerminalCommandTab bridge={bridge({ state: 'not-installed' })} />);
    expect(await screen.findByRole('button', { name: /^Install/ })).toBeTruthy();
    expect(text()).toContain('Use dorkos from Terminal. No admin password needed.');
  });

  it('state 2: says where it is, offers Remove, and shows no line to add', async () => {
    render(<TerminalCommandTab bridge={bridge({ state: 'installed', path: ADVICE.path })} />);
    expect(await screen.findByRole('button', { name: /^Remove/ })).toBeTruthy();
    expect(text()).toContain('Installed at ~/.local/bin/dorkos.');
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('state 3: names the person’s shell file and the alias line, with Copy', async () => {
    render(<TerminalCommandTab bridge={bridge({ state: 'not-found', ...ADVICE })} />);
    await screen.findByRole('button', { name: 'Copy' });
    expect(text()).toContain('Installed, but Terminal can’t find it yet.');
    expect(text()).toContain('Add this line to ~/.zshrc, then open a new Terminal window.');
    expect(text()).toContain("alias dorkos='~/.local/bin/dorkos'");
  });

  it('state 4: names the other dorkos and its version, with the same line', async () => {
    render(
      <TerminalCommandTab
        bridge={bridge({
          state: 'shadowed',
          ...ADVICE,
          otherPath: '/opt/made-up/bin/dorkos',
          otherVersion: '0.99.1',
        })}
      />
    );
    await screen.findByRole('button', { name: 'Copy' });
    expect(text()).toContain(
      'Terminal finds another dorkos first, at /opt/made-up/bin/dorkos (0.99.1).'
    );
  });

  it('state 4 without a version leaves the brackets out', async () => {
    render(
      <TerminalCommandTab
        bridge={bridge({
          state: 'shadowed',
          ...ADVICE,
          otherPath: 'npx dorkos',
          otherVersion: null,
        })}
      />
    );
    await screen.findByRole('button', { name: 'Copy' });
    expect(text()).toContain('at npx dorkos.');
    expect(text()).not.toContain('()');
  });

  it('state 5: a failed install says why in plain words and offers Try again', async () => {
    const fake = bridge(
      { state: 'not-installed' },
      {
        install: vi.fn(async () =>
          Promise.reject(new Error('another file is already at ~/.local/bin/dorkos.'))
        ),
      }
    );
    render(<TerminalCommandTab bridge={fake} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Install/ }));
    expect(await screen.findByRole('button', { name: /^Try again/ })).toBeTruthy();
    expect(text()).toContain('Couldn’t install: another file is already at ~/.local/bin/dorkos.');
    fireEvent.click(screen.getByRole('button', { name: /^Try again/ }));
    await waitFor(() => expect(fake.install).toHaveBeenCalledTimes(2));
  });

  it('installs, then shows what the app found', async () => {
    const fake = bridge({ state: 'not-installed' });
    render(<TerminalCommandTab bridge={fake} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Install/ }));
    expect(await screen.findByRole('button', { name: /^Remove/ })).toBeTruthy();
    expect(fake.install).toHaveBeenCalledTimes(1);
  });

  it('asks the app fresh each time it opens', async () => {
    const fake = bridge({ state: 'not-installed' });
    const { unmount } = render(<TerminalCommandTab bridge={fake} />);
    await screen.findByRole('button', { name: /^Install/ });
    unmount();
    render(<TerminalCommandTab bridge={fake} />);
    await screen.findByRole('button', { name: /^Install/ });
    expect(fake.status).toHaveBeenCalledTimes(2);
  });

  it('outside the Mac app, offers nothing to press', async () => {
    render(<TerminalCommandTab bridge={null} />);
    await screen.findByText('The Terminal command comes with the Mac app.');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('the Terminal command tab', () => {
  it('shows only in the desktop app, and never on a hub', () => {
    const ids = (isHub: boolean, desktop: boolean) =>
      settingsTabsFor(isHub, desktop).map((tab) => tab.id);
    expect(ids(false, true)).toContain('terminal-command');
    expect(ids(false, false)).not.toContain('terminal-command');
    expect(ids(true, true)).not.toContain('terminal-command');
  });
});
