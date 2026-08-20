/**
 * The three sounds, gated by what the person asked for.
 *
 * The gate lives here rather than in `shared/lib/notification-sound` because it
 * reads server config, and a `shared/` utility that reached for a query would
 * make every caller mock one to test a sound. This is the seam: the lib plays,
 * this decides whether to.
 *
 * @module features/notifications/model/use-notification-cues
 */
import { useCallback } from 'react';
import { useNotificationPrefs } from '@/layers/entities/config';
import { playNotificationCue, type NotificationCue } from '@/layers/shared/lib';

/** Which switch each cue answers to. */
const CUE_SWITCH = {
  knock: 'knock',
  settle: 'allClear',
  'turn-end': 'turnEnd',
} as const satisfies Record<NotificationCue, 'knock' | 'allClear' | 'turnEnd'>;

/** What {@link useNotificationCues} hands its consumers. */
export interface NotificationCues {
  /** Play a cue if this person wants that one. Silent otherwise. */
  play: (cue: NotificationCue) => void;
}

/**
 * Play notification cues, respecting the person's sound settings.
 *
 * Each cue has its own switch, so silencing the every-turn chime does not
 * silence the knock — which is the whole reason the three are separate settings
 * rather than one "sounds" boolean. Somebody who wants to know when an agent is
 * blocked and does not want a noise every time one finishes typing is the common
 * case, not an edge case.
 */
export function useNotificationCues(): NotificationCues {
  const { prefs } = useNotificationPrefs();
  const { sounds } = prefs;

  const play = useCallback(
    (cue: NotificationCue) => {
      if (!sounds[CUE_SWITCH[cue]]) return;
      playNotificationCue(cue);
    },
    [sounds]
  );

  return { play };
}
