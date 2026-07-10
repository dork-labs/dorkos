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

describe('playSliderTick', () => {
  it('creates an oscillator at 800Hz with gain 0.05 and ~4ms duration', () => {
    playSliderTick();

    expect(mockCtx.createOscillator).toHaveBeenCalledOnce();
    expect(mockCtx.createGain).toHaveBeenCalledOnce();

    const osc = mockCtx.createOscillator.mock.results[0]!.value;
    const gain = mockCtx.createGain.mock.results[0]!.value;

    expect(osc.frequency.value).toBe(800);
    expect(osc.type).toBe('sine');
    expect(gain.gain.value).toBe(0.05);

    expect(osc.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(mockDestination);

    expect(osc.start).toHaveBeenCalledWith(0);
    expect(osc.stop).toHaveBeenCalledWith(0.004);
  });
});

describe('playCelebration', () => {
  it('creates 3 oscillators at C5/E5/G5 with gain 0.08, staggered 33ms', () => {
    playCelebration();

    expect(mockCtx.createOscillator).toHaveBeenCalledTimes(3);
    expect(mockCtx.createGain).toHaveBeenCalledTimes(3);

    const expectedNotes = [523, 659, 784];
    const stagger = 0.033;

    for (let i = 0; i < 3; i++) {
      const osc = mockCtx.createOscillator.mock.results[i]!.value;
      const gain = mockCtx.createGain.mock.results[i]!.value;

      expect(osc.frequency.value).toBe(expectedNotes[i]);
      expect(osc.type).toBe('sine');
      expect(gain.gain.value).toBe(0.08);

      expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.08, i * stagger);
      expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.001, i * stagger + 0.3);

      expect(osc.start).toHaveBeenCalledWith(i * stagger);
      expect(osc.stop).toHaveBeenCalledWith(i * stagger + 0.3);
    }
  });
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
