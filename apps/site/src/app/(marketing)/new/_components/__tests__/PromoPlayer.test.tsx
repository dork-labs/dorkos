/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PROMO_CAPTIONS, PROMO_CUTS, PHONE_CUT_QUERY } from '../promo-cuts';
import { PromoPlayer } from '../PromoPlayer';

/**
 * Answer `matchMedia` for one query only, so a test can put the component on a
 * phone or a laptop and nothing else changes.
 */
function onPhone(phone: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === PHONE_CUT_QUERY ? phone : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

let play: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom has no media pipeline; `play()` is unimplemented and throws.
  play = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
    writable: true,
    configurable: true,
    value: play,
  });
  onPhone(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function pressPlay(): void {
  fireEvent.click(screen.getByRole('button', { name: /play the video/i }));
}

describe('PromoPlayer before the press', () => {
  it('shows the still and no video at all', () => {
    const { container } = render(<PromoPlayer />);

    expect(screen.getByRole('button', { name: /play the video/i })).toBeTruthy();
    expect(container.querySelector('video')).toBeNull();
  });

  it('offers both stills to the browser and lets it pick one', () => {
    const { container } = render(<PromoPlayer />);

    const source = container.querySelector('source');
    const img = container.querySelector('img');
    expect(source?.getAttribute('media')).toBe(PHONE_CUT_QUERY);
    expect(source?.getAttribute('srcset')).toBe(PROMO_CUTS.tall.poster);
    expect(img?.getAttribute('src')).toBe(PROMO_CUTS.wide.poster);
    expect(img?.getAttribute('alt')).toBeTruthy();
  });
});

describe('PromoPlayer after the press', () => {
  it('loads the landscape cut on a laptop, and only that cut', () => {
    const { container } = render(<PromoPlayer />);
    pressPlay();

    const video = container.querySelector('video');
    expect(video?.getAttribute('src')).toBe(PROMO_CUTS.wide.src);
    expect(video?.getAttribute('poster')).toBe(PROMO_CUTS.wide.poster);
    expect(container.querySelectorAll('video')).toHaveLength(1);
  });

  it('loads the vertical cut on a phone', () => {
    onPhone(true);
    const { container } = render(<PromoPlayer />);
    pressPlay();

    const video = container.querySelector('video');
    expect(video?.getAttribute('src')).toBe(PROMO_CUTS.tall.src);
    expect(video?.getAttribute('poster')).toBe(PROMO_CUTS.tall.poster);
  });

  it('plays inline with sound, under the visitor’s own control', () => {
    const { container } = render(<PromoPlayer />);
    pressPlay();

    const video = container.querySelector('video');
    expect(video?.hasAttribute('playsinline')).toBe(true);
    expect(video?.hasAttribute('controls')).toBe(true);
    expect(video?.hasAttribute('muted')).toBe(false);
    expect(video?.hasAttribute('autoplay')).toBe(false);
    expect(video?.getAttribute('preload')).toBe('none');
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('carries English captions, switched off until asked for', () => {
    const { container } = render(<PromoPlayer />);
    pressPlay();

    const track = container.querySelector('track');
    expect(track?.getAttribute('kind')).toBe('captions');
    expect(track?.getAttribute('src')).toBe(PROMO_CAPTIONS);
    expect(track?.getAttribute('srclang')).toBe('en');
    expect(track?.getAttribute('label')).toBe('English');
    expect(track?.hasAttribute('default')).toBe(false);
  });
});
