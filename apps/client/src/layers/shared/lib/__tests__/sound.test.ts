/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDestination = {};

function createMockOscillator() {
  return {
    type: 'sine' as OscillatorType,
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function createMockGain() {
  return {
    gain: {
      value: 0,
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  };
}

const mockCtx = {
  currentTime: 0,
  destination: mockDestination,
  createOscillator: vi.fn(createMockOscillator),
  createGain: vi.fn(createMockGain),
};

// Vitest 4 spies honor `new` semantics; the implementation must be constructible.
vi.stubGlobal(
  'AudioContext',
  vi.fn(function () {
    return mockCtx;
  })
);

let playSliderTick: () => void;
let playCelebration: () => void;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();

  // Re-stub after restoreAllMocks so the implementation persists
  mockCtx.createOscillator = vi.fn(createMockOscillator);
  mockCtx.createGain = vi.fn(createMockGain);
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return mockCtx;
    })
  );

  const mod = await import('../sound');
  playSliderTick = mod.playSliderTick;
  playCelebration = mod.playCelebration;
});

describe('error handling', () => {
  it('playSliderTick does not throw when AudioContext creation fails', async () => {
    vi.resetModules();
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        throw new Error('AudioContext not supported');
      })
    );

    const mod = await import('../sound');
    expect(() => mod.playSliderTick()).not.toThrow();
  });

  it('playCelebration does not throw when AudioContext creation fails', async () => {
    vi.resetModules();
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        throw new Error('AudioContext not supported');
      })
    );

    const mod = await import('../sound');
    expect(() => mod.playCelebration()).not.toThrow();
  });
});

describe('AudioContext lifecycle', () => {
  it('lazily creates AudioContext on first call', () => {
    const ctorSpy = vi.mocked(AudioContext);

    // No AudioContext created yet (fresh module from beforeEach)
    expect(ctorSpy).not.toHaveBeenCalled();

    playSliderTick();
    expect(ctorSpy).toHaveBeenCalledOnce();
  });

  it('reuses AudioContext across multiple calls', () => {
    playSliderTick();
    playSliderTick();
    playCelebration();

    expect(vi.mocked(AudioContext)).toHaveBeenCalledOnce();
  });
});
