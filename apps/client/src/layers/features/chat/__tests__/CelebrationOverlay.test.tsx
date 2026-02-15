/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import type { CelebrationEvent } from '@/layers/shared/lib';

vi.mock('motion/react', () => ({
  motion: {
    div: React.forwardRef(({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>, ref: React.Ref<HTMLDivElement>) =>
      React.createElement('div', { ...props, ref }, children)
    ),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/layers/shared/lib', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/lib');
  return {
    ...actual,
    fireConfetti: vi.fn().mockResolvedValue(vi.fn()),
    RADIAL_GLOW_STYLE: { background: 'radial-gradient(circle, gold, transparent)' },
  };
});

import { CelebrationOverlay } from '../ui/CelebrationOverlay';
import { fireConfetti } from '@/layers/shared/lib';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CelebrationOverlay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders nothing when celebration is null', () => {
    const { container } = render(
      <CelebrationOverlay celebration={null} onComplete={vi.fn()} />
    );
    expect(container.querySelector('[aria-hidden]')).toBeNull();
  });

  it('renders nothing for mini celebration', () => {
    const mini: CelebrationEvent = { level: 'mini', taskId: '1', timestamp: Date.now() };
    const { container } = render(
      <CelebrationOverlay celebration={mini} onComplete={vi.fn()} />
    );
    expect(container.querySelector('[aria-hidden]')).toBeNull();
  });

  it('renders radial glow for major celebration', () => {
    const major: CelebrationEvent = { level: 'major', taskId: '1', timestamp: Date.now() };
    const { container } = render(
      <CelebrationOverlay celebration={major} onComplete={vi.fn()} />
    );
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('has pointer-events-none class on container', () => {
    const major: CelebrationEvent = { level: 'major', taskId: '1', timestamp: Date.now() };
    const { container } = render(
      <CelebrationOverlay celebration={major} onComplete={vi.fn()} />
    );
    expect(container.querySelector('.pointer-events-none')).not.toBeNull();
  });

  it('calls onComplete after 2s timer', () => {
    const onComplete = vi.fn();
    const major: CelebrationEvent = { level: 'major', taskId: '1', timestamp: Date.now() };
    render(<CelebrationOverlay celebration={major} onComplete={onComplete} />);
    vi.advanceTimersByTime(2000);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('fires confetti for major celebration', () => {
    const major: CelebrationEvent = { level: 'major', taskId: '1', timestamp: Date.now() };
    render(<CelebrationOverlay celebration={major} onComplete={vi.fn()} />);
    expect(fireConfetti).toHaveBeenCalledWith(
      expect.objectContaining({ particleCount: 40 })
    );
  });

  it('cleans up confetti on unmount', async () => {
    const cleanupFn = vi.fn();
    (fireConfetti as ReturnType<typeof vi.fn>).mockResolvedValue(cleanupFn);
    const major: CelebrationEvent = { level: 'major', taskId: '1', timestamp: Date.now() };
    const { unmount } = render(
      <CelebrationOverlay celebration={major} onComplete={vi.fn()} />
    );
    await vi.advanceTimersByTimeAsync(0);
    unmount();
    expect(cleanupFn).toHaveBeenCalled();
  });
});
