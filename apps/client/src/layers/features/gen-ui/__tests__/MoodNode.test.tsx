/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Force reduced motion for this file: faces must stay fully expressive as
// static shapes (brows + mouth carry the emotion without any animation).
vi.mock('../lib/widget-motion', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/widget-motion');
  return { ...actual, useWidgetMotion: () => false };
});

vi.mock('@/layers/shared/lib', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/lib');
  return { ...actual, fireCelebration: vi.fn().mockResolvedValue(vi.fn()) };
});

import { MoodNode } from '../ui/nodes/mood';

afterEach(cleanup);

const EMOTIONS = [
  'happy',
  'thinking',
  'celebrating',
  'sheepish',
  'determined',
  'surprised',
  'sad',
  'love',
] as const;

describe('MoodNode under reduced motion', () => {
  it.each(EMOTIONS)('renders a static, labeled %s face', (emotion) => {
    const { container } = render(<MoodNode node={{ type: 'mood', emotion }} />);
    expect(screen.getByRole('img', { name: `Mood: ${emotion}` })).toBeInTheDocument();
    // The face still has anatomy: at least one stroke path (brow or mouth).
    expect(container.querySelectorAll('svg path').length).toBeGreaterThan(0);
  });

  it('does not fire confetti for celebrating when motion is reduced', async () => {
    const { fireCelebration } = await import('@/layers/shared/lib');
    vi.mocked(fireCelebration).mockClear();
    render(<MoodNode node={{ type: 'mood', emotion: 'celebrating' }} />);
    expect(fireCelebration).not.toHaveBeenCalled();
  });

  it('renders the message bubble', () => {
    render(<MoodNode node={{ type: 'mood', emotion: 'happy', message: 'All tests green!' }} />);
    expect(screen.getByText('All tests green!')).toBeInTheDocument();
  });

  it('gives every emotion brows (two brow strokes minimum)', () => {
    for (const emotion of EMOTIONS) {
      const { container, unmount } = render(<MoodNode node={{ type: 'mood', emotion }} />);
      // Brows + mouth are all round-capped strokes; every face has ≥ 3 stroked
      // elements (2 brows + mouth) except celebrating whose mouth is filled —
      // still ≥ 2 brows + 2 caret eyes.
      const strokes = container.querySelectorAll('[stroke="currentColor"]');
      expect(strokes.length).toBeGreaterThanOrEqual(3);
      unmount();
    }
  });
});
