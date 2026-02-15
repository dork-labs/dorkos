import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock canvas-confetti module before import
vi.mock('canvas-confetti', () => {
  const mockConfetti = vi.fn();
  (mockConfetti as any).reset = vi.fn();
  return {
    default: mockConfetti,
  };
});

// Import after mocking
import { fireConfetti, RADIAL_GLOW_STYLE, MINI_SPRING_CONFIG, SHIMMER_STYLE } from '../effects';

// Get the mock
const getConfettiMock = async () => {
  const module = await import('canvas-confetti');
  return module.default;
};

describe('fireConfetti', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lazy-loads canvas-confetti and calls it', async () => {
    const confettiMock = await getConfettiMock();
    await fireConfetti();
    expect(confettiMock).toHaveBeenCalledOnce();
  });

  it('calls confetti with gold color palette', async () => {
    const confettiMock = await getConfettiMock();
    await fireConfetti();
    const call = (confettiMock as any).mock.calls[0][0];
    expect(call.colors).toEqual(['#FFD700', '#FFC107', '#F7B500']);
  });

  it('returns cleanup function that calls confetti.reset()', async () => {
    const confettiMock = await getConfettiMock();
    const cleanup = await fireConfetti();
    cleanup();
    expect((confettiMock as any).reset).toHaveBeenCalledOnce();
  });

  it('passes disableForReducedMotion: true', async () => {
    const confettiMock = await getConfettiMock();
    await fireConfetti();
    const call = (confettiMock as any).mock.calls[0][0];
    expect(call.disableForReducedMotion).toBe(true);
  });

  it('allows overriding options', async () => {
    const confettiMock = await getConfettiMock();
    await fireConfetti({ particleCount: 20, origin: { x: 0.3, y: 0.4 } });
    const call = (confettiMock as any).mock.calls[0][0];
    expect(call.particleCount).toBe(20);
    expect(call.origin).toEqual({ x: 0.3, y: 0.4 });
  });
});

describe('style constants', () => {
  it('RADIAL_GLOW_STYLE has radial gradient background', () => {
    expect(RADIAL_GLOW_STYLE.background).toContain('radial-gradient');
    expect(RADIAL_GLOW_STYLE.background).toContain('255,215,0');
  });

  it('MINI_SPRING_CONFIG has spring type with stiffness/damping', () => {
    expect(MINI_SPRING_CONFIG.type).toBe('spring');
    expect(MINI_SPRING_CONFIG.stiffness).toBe(400);
    expect(MINI_SPRING_CONFIG.damping).toBe(10);
  });

  it('SHIMMER_STYLE has linear gradient and 200% size', () => {
    expect(SHIMMER_STYLE.backgroundImage).toContain('linear-gradient');
    expect(SHIMMER_STYLE.backgroundSize).toBe('200% 100%');
  });
});
