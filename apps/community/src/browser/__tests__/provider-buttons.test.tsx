// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunityWireAuthOptions } from '@dorkos/shared/community-wire';
import { ProviderButtons } from '../sign-up/ProviderButtons.js';

afterEach(cleanup);

const ALL: CommunityWireAuthOptions = {
  google: true,
  github: true,
  oidc: { label: 'DorkOS', mark: 'dorkos' },
  minimumAge: null,
};

/** The mark drawn inside the named button. */
function markOf(name: string) {
  return screen
    .getByRole('button', { name })
    .querySelector('[data-mark]')
    ?.getAttribute('data-mark');
}

describe('the provider sign-in buttons', () => {
  it("shows each provider's own mark, so the buttons read as sign-in buttons", () => {
    // Purpose: fails on the old text-only buttons, or if a provider gets another's mark.
    render(<ProviderButtons providers={ALL} disabled={false} onChoose={() => {}} />);
    expect(markOf('Continue with Google')).toBe('google');
    expect(markOf('Continue with GitHub')).toBe('github');
    expect(markOf('Continue with DorkOS')).toBe('dorkos');
  });

  it('shows a neutral key for any other single sign-on, never the DorkOS mark', () => {
    // Purpose: fails if a host's own issuer borrows the DorkOS mark without naming it, or if a
    // response from an older server (no mark at all) breaks the button.
    render(
      <ProviderButtons
        providers={{
          ...ALL,
          google: false,
          github: false,
          oidc: { label: 'Team SSO', mark: null },
        }}
        disabled={false}
        onChoose={() => {}}
      />
    );
    expect(markOf('Continue with Team SSO')).toBe('key');
    cleanup();
    const older = { ...ALL, oidc: { label: 'Team SSO' } } as unknown as CommunityWireAuthOptions;
    render(<ProviderButtons providers={older} disabled={false} onChoose={() => {}} />);
    expect(markOf('Continue with Team SSO')).toBe('key');
  });

  it('keeps every mark out of the accessible name and starts the chosen provider', () => {
    // Purpose: fails if a mark adds words a screen reader would read, or a button starts the
    // wrong provider.
    const onChoose = vi.fn();
    render(<ProviderButtons providers={ALL} disabled={false} onChoose={onChoose} />);
    for (const button of screen.getAllByRole('button'))
      expect(button.querySelector('[data-mark]')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Continue with GitHub' }));
    expect(onChoose).toHaveBeenCalledWith('github');
  });

  it('shows nothing when the host offers no provider', () => {
    // Purpose: fails if an empty stack leaves a gap or a stray button.
    const { container } = render(
      <ProviderButtons
        providers={{ google: false, github: false, oidc: null, minimumAge: null }}
        disabled={false}
        onChoose={() => {}}
      />
    );
    expect(container.innerHTML).toBe('');
  });
});
