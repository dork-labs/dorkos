/**
 * @vitest-environment jsdom
 */
/**
 * The standing row for a memory backend DorkOS is not actually using.
 *
 * The rule deciding WHEN this banner is eligible lives in the descriptor
 * (`model/use-app-banners.tsx`, covered by `use-app-banners.test.tsx` — the
 * `configuredId !== activeId` gate and the leak-proofing regression test live
 * there, not here, since this component's own props carry no `benchReason` to
 * leak in the first place). What is pinned here is the half a person actually
 * meets: it names the backend, branches its wording on `benched`, reads as a
 * warning rather than a flat note, and cannot be dismissed away — the same
 * things the unattended-autonomy banner's own test pins for its own tone.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { MemoryProviderBenchedBanner } from '../ui/MemoryProviderBenchedBanner';

// motion reads matchMedia (reduced-motion) which jsdom does not implement.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(cleanup);

describe('MemoryProviderBenchedBanner', () => {
  it('names a backend that faulted as having stopped answering', () => {
    render(<MemoryProviderBenchedBanner configuredId="acme-memory" benched />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'The acme-memory memory backend stopped answering. DorkOS switched to its own local memory until you restart.'
    );
  });

  it('names a backend that never registered without claiming it faulted', () => {
    render(<MemoryProviderBenchedBanner configuredId="acme-memory" benched={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      "The acme-memory memory backend isn't installed or didn't register. DorkOS switched to its own local memory until you restart."
    );
    // "Stopped answering" claims a fault that never happened for this case.
    expect(screen.getByRole('status')).not.toHaveTextContent('stopped answering');
  });

  it('is a warning in both cases — an operator did not choose either outcome', () => {
    render(<MemoryProviderBenchedBanner configuredId="acme-memory" benched />);
    expect(screen.getByRole('status')).toHaveAttribute('data-variant', 'warning');
    cleanup();
    render(<MemoryProviderBenchedBanner configuredId="acme-memory" benched={false} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-variant', 'warning');
  });

  it('cannot be dismissed — the condition is standing, not an announcement', () => {
    render(<MemoryProviderBenchedBanner configuredId="acme-memory" benched />);
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it('never shows a raw failure — only what an operator chose', () => {
    render(<MemoryProviderBenchedBanner configuredId="acme-memory" benched />);
    // The component's props (`configuredId`, `benched`) carry nothing raw to
    // leak in the first place — this is a control, not the leak-proofing test
    // itself. See `use-app-banners.test.tsx` for the one that actually drives
    // a `benchReason` through the real wiring.
    expect(screen.getByRole('status')).not.toHaveTextContent('unreachable');
  });
});
