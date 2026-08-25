/** The three moments of the pinned stage, in scroll order. */
export type Beat = 'talk' | 'yours' | 'computer';

/** Headline copy for each beat. */
export interface BeatCopy {
  eyebrow: string;
  title: string;
  lede: string;
}

/** What the stage says during each beat. */
export const BEAT_COPY: Record<Beat, BeatCopy> = {
  talk: {
    eyebrow: 'people + agents',
    title: 'Talk to your team.',
    lede: 'You talk to them. They talk to each other. Work happens out loud.',
  },
  yours: {
    eyebrow: 'your apps',
    title: 'Make it yours.',
    lede: 'Plug in the apps you already use. Your agents put them to work.',
  },
  computer: {
    eyebrow: 'yours alone',
    title: 'It all happens on your computer.',
    lede: 'Your files stay home. You pick what your agents can touch. When you say go, they do the real work: send the email, fix the bug, ship the site.',
  },
};

/**
 * Beat thresholds with dead zones between them, so a scroll that rests on a
 * boundary can't flicker between two beats.
 */
export function nextBeat(progress: number, current: Beat): Beat {
  if (progress >= 0.66) return 'computer';
  if (progress <= 0.62 && progress >= 0.38) return 'yours';
  if (progress <= 0.34) return 'talk';
  return current;
}
