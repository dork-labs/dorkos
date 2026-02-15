import { describe, it, expect, vi, beforeEach } from 'vitest';

let playNotificationSound: () => void;

const mockPlay = vi.fn().mockResolvedValue(undefined);
const mockAudioInstance = {
  play: mockPlay,
  currentTime: 0,
};

vi.stubGlobal('Audio', vi.fn(() => mockAudioInstance));

beforeEach(async () => {
  vi.clearAllMocks();
  mockAudioInstance.currentTime = 0;
  vi.resetModules();
  const mod = await import('../../lib/notification-sound');
  playNotificationSound = mod.playNotificationSound;
});

describe('playNotificationSound', () => {
  it('creates an Audio element and calls play()', () => {
    playNotificationSound();
    expect(Audio).toHaveBeenCalledWith('/notification.wav');
    expect(mockPlay).toHaveBeenCalled();
  });

  it('catches play() rejection silently', () => {
    mockPlay.mockRejectedValueOnce(new Error('Autoplay blocked'));
    expect(() => playNotificationSound()).not.toThrow();
  });

  it('reuses the same Audio instance across multiple calls', () => {
    playNotificationSound();
    playNotificationSound();
    expect(Audio).toHaveBeenCalledTimes(1);
  });

  it('sets currentTime = 0 before playing', () => {
    mockAudioInstance.currentTime = 5;
    playNotificationSound();
    expect(mockAudioInstance.currentTime).toBe(0);
  });
});
