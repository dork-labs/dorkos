import type { Beat } from './beats';

/** A headline block: mono kicker, headline, one supporting line. */
export interface Block {
  eyebrow: string;
  title: string;
  lede: string;
}

/**
 * Every word on the home page, in one file.
 *
 * The page's whole argument is about six sentences long, and several of them
 * are settled: "All your agents. One place." is the category line, and
 * "You, multiplied." is the product's tagline. Keeping them here rather than
 * scattered through the components means the word budget is one thing you can
 * read end to end, and `__tests__/home-copy.test.ts` can hold the settled
 * lines still while the rest stays editable.
 */
export const HERO: Block = {
  eyebrow: 'claude code · codex · opencode',
  title: 'All your agents. One place.',
  lede: 'DorkOS puts every AI agent you run in one window. Watch them work. Step in when you want.',
};

/** What the pinned stage says at each of its three moments. */
export const BEATS: Record<Beat, Block> = {
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

/** The line that fades up once the laptop has formed around the chat. */
export const LOCALHOST_CAPTION = 'home sweet localhost';

/** The promo section. Two lines, then the film. */
export const PROMO: Block = {
  eyebrow: '56 seconds',
  title: 'Dave isn’t smarter than you.',
  lede: 'He just has help.',
};

/** The close. */
export const CLOSE = {
  title: 'You, multiplied.',
  lede: 'We built it for ourselves. Now it’s yours.',
  /** The one link out of the close, to every other way of installing. */
  otherWays: 'other ways to install',
  /** The colophon, before the GitHub link. */
  colophon: 'dorkos · open source, mit ·',
} as const;

/** What the download button offers, and what it costs. */
export const DOWNLOAD = {
  label: 'Download for Mac',
  terms: 'free · open source · apple silicon',
} as const;

/** Introduces the terminal install, wherever the download button appears. */
export const INSTALL_ASIDE = 'or run';
