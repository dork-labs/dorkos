/**
 * The buddy branch of the disc (DOR-3065): off draws exactly what it always drew,
 * on swaps the face and keeps the state in words.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setBlockBuddiesEnabled } from '@/layers/shared/lib';
import { IdentityAvatar } from '../identity-avatar';

const SEED = '01M50ZCM5KZF236JGK50H6HFJM';

function disc(): HTMLElement {
  return screen.getByTestId('disc');
}

async function on(): Promise<void> {
  act(() => setBlockBuddiesEnabled(true));
  // The package arrives by dynamic import, once for the whole file.
  await waitFor(() =>
    expect(document.querySelector('[data-slot="block-buddy"] svg')).not.toBeNull()
  );
}

afterEach(() => {
  cleanup();
  act(() => setBlockBuddiesEnabled(false));
});

describe('with the experiment off', () => {
  it('draws the same markup with or without a seed', () => {
    const { container: without } = render(
      <IdentityAvatar kind="agent" color="#336699" emoji="🦊" status="working" />
    );
    const { container: withSeed } = render(
      <IdentityAvatar kind="agent" color="#336699" emoji="🦊" status="working" buddySeed={SEED} />
    );
    expect(withSeed.innerHTML).toBe(without.innerHTML);
    expect(withSeed.querySelector('[data-face]')?.getAttribute('data-face')).toBe('🦊');
  });
});

describe('with the experiment on', () => {
  it('draws the buddy in place of the emoji, the fill and the Bot badge', async () => {
    render(
      <IdentityAvatar data-testid="disc" kind="agent" color="#336699" emoji="🦊" buddySeed={SEED} />
    );
    await on();
    expect(disc().getAttribute('data-face')).toBe('buddy');
    expect(disc().textContent).not.toContain('🦊');
    expect(disc().style.backgroundColor).toBe('');
    expect(disc().querySelector('[data-slot="identity-badge"]')).toBeNull();
    expect(disc().style.getPropertyValue('--identity-color')).toMatch(/^hsl\(/);
  });

  it('says the state in words and draws no corner dot', async () => {
    render(
      <IdentityAvatar
        data-testid="disc"
        kind="agent"
        color="#336699"
        emoji="🦊"
        buddySeed={SEED}
        status="needs-you"
      />
    );
    await on();
    expect(disc().querySelector('[data-slot="identity-status-dot"]')).toBeNull();
    expect(disc().querySelector('.sr-only')?.textContent).toBeTruthy();
  });

  it('keeps a photo, because a photo is a choice', async () => {
    render(<IdentityAvatar kind="agent" color="#336699" emoji="🦊" buddySeed={SEED} />);
    await on();
    cleanup();
    render(
      <IdentityAvatar
        data-testid="disc"
        kind="agent"
        color="#336699"
        emoji="🦊"
        buddySeed={SEED}
        imageUrl="/photo.png"
      />
    );
    expect(disc().getAttribute('data-face')).toBe('photo');
  });

  it('leaves people and seedless agents alone', async () => {
    render(<IdentityAvatar kind="agent" color="#336699" emoji="🦊" buddySeed={SEED} />);
    await on();
    render(<IdentityAvatar data-testid="disc" kind="human" color="#336699" buddySeed={SEED} />);
    expect(disc().getAttribute('data-face')).not.toBe('buddy');
    cleanup();
    render(<IdentityAvatar data-testid="disc" kind="agent" color="#336699" emoji="🦊" />);
    expect(disc().getAttribute('data-face')).toBe('🦊');
  });
});
