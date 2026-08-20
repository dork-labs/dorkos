import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationCue } from '../notification-sound';

let playNotificationCue: (cue: NotificationCue) => void;

/** One fake element per source, so "one player per cue" is observable. */
const instances = new Map<string, { play: ReturnType<typeof vi.fn>; currentTime: number }>();

// Vitest 4 spies honor `new` semantics; the implementation must be constructible.
vi.stubGlobal(
  'Audio',
  vi.fn(function (src: string) {
    const instance = { play: vi.fn().mockResolvedValue(undefined), currentTime: 0 };
    instances.set(src, instance);
    return instance;
  })
);

beforeEach(async () => {
  vi.clearAllMocks();
  instances.clear();
  vi.resetModules();
  const mod = await import('../notification-sound');
  playNotificationCue = mod.playNotificationCue;
});

describe('playNotificationCue', () => {
  it('plays the asset for each cue', () => {
    playNotificationCue('knock');
    expect(Audio).toHaveBeenCalledWith('/knock.wav');
    expect(instances.get('/knock.wav')?.play).toHaveBeenCalled();

    playNotificationCue('settle');
    expect(Audio).toHaveBeenCalledWith('/settle.wav');
    expect(instances.get('/settle.wav')?.play).toHaveBeenCalled();

    playNotificationCue('turn-end');
    expect(Audio).toHaveBeenCalledWith('/notification.wav');
    expect(instances.get('/notification.wav')?.play).toHaveBeenCalled();
  });

  it('catches play() rejection silently', async () => {
    playNotificationCue('knock');
    instances.get('/knock.wav')!.play.mockRejectedValueOnce(new Error('Autoplay blocked'));
    expect(() => playNotificationCue('knock')).not.toThrow();
  });

  it('reuses one Audio element per cue across calls', () => {
    playNotificationCue('knock');
    playNotificationCue('knock');
    expect(Audio).toHaveBeenCalledTimes(1);
  });

  it('keeps a separate element per cue, so one never cuts another off', () => {
    // The all-clear lands in the same second as the last answer, so the two
    // cues must not share one element whose `currentTime` reset would stop the
    // other mid-sound.
    playNotificationCue('knock');
    playNotificationCue('settle');
    expect(Audio).toHaveBeenCalledTimes(2);
    expect(instances.size).toBe(2);
  });

  it('sets currentTime = 0 before playing, so a repeat restarts the sound', () => {
    playNotificationCue('knock');
    instances.get('/knock.wav')!.currentTime = 5;
    playNotificationCue('knock');
    expect(instances.get('/knock.wav')!.currentTime).toBe(0);
  });
});
