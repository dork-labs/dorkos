import type { Beat } from './stage/beats';

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
 *
 * One exception, and it is deliberate. The clips rail's words live with its
 * cards in `tutorials/tutorials.ts`, because that section is built to be
 * lifted whole into a sibling page that renames it: its copy and its card
 * list are one config object, and splitting them across two files would mean
 * re-theming the section in two places. The copy test sweeps that object into
 * the same checks as everything here, so nothing escapes the gates.
 */
export const HERO: Block = {
  eyebrow: 'claude code · codex · opencode',
  title: 'All your agents. One place.',
  lede: 'DorkOS puts every AI agent you run in one window. Watch them work.',
};

/** What the pinned stage says at each of its three moments. */
export const BEATS: Record<Beat, Block> = {
  talk: {
    eyebrow: 'people + agents',
    title: 'Talk to your team.',
    lede: 'You talk to them. They talk to each other. Work happens out loud.',
  },
  yours: {
    eyebrow: 'what you add',
    title: 'Make it yours.',
    lede: 'Add a skill. Set a schedule. Pick where they reach you.',
  },
  computer: {
    eyebrow: 'yours alone',
    title: 'It all happens on your computer.',
    lede: 'Your files stay home. You pick what your agents can touch, and what needs your say-so.',
  },
};

/** The line that fades up once the laptop has formed around the chat. */
export const LOCALHOST_CAPTION = 'home sweet localhost';

/**
 * The film, which this page puts second and treats as the main event.
 *
 * Every word here is one of the four lines the film's own campaign settled on,
 * used in the film's order: "Meet Dave." / "Dave wasn't winning..." above the
 * player, {@link FILM_TURN} under it, and {@link BRIDGE} carrying the last one
 * into the product. The page never invents a new sentence about Dave and never
 * explains what happens in the film. A page that narrates a joke has spent it.
 *
 * The second line was "Dave is not winning." until the operator edited it in
 * the 2026-08-25 review. The past tense and the trailing dots do the work the
 * present tense could not: they say the story is already over and its ending
 * is one scroll away, which is the whole reason to press play. The apostrophe
 * is the typographic one, to match "Dave isn’t" in {@link BRIDGE}.
 */
export const FILM: Block = {
  eyebrow: '56 seconds · sound on',
  title: 'Meet Dave.',
  lede: 'Dave wasn’t winning...',
};

/** The turn, under the player: what the next 56 seconds are about. */
export const FILM_TURN = 'Then Dave got DorkOS.';

/**
 * The hand-off from Dave's story to the visitor's.
 *
 * The two halves are one approved line broken over a heading and its
 * supporting sentence, so the pivot from "him" to "you" lands on the heading.
 */
export const BRIDGE: Block = {
  eyebrow: 'now for real',
  title: 'Dave isn’t smarter than you.',
  lede: 'He just has help. Here is what that help looks like.',
};

/** The close. */
export const CLOSE = {
  title: 'You, multiplied.',
  lede: 'We built it for ourselves. Now it’s yours.',
  /**
   * The bill, said once and plainly.
   *
   * "free · open source" is true of DorkOS and false of running agents, and
   * this page says the first part twice. `/` can afford to answer it in a FAQ
   * entry; a page with a word budget this small has to answer it in a line,
   * or the cheerful half stands alone.
   */
  cost: 'DorkOS is free. Your agents call whichever AI company powers them, and that is the only bill.',
  /** The one link out of the close, to every other way of installing. */
  otherWays: 'other ways to install',
  /**
   * The Marketplace, beside that link rather than in the pill.
   *
   * The floating pill now steers this page's own sections, and browsing
   * packages is not one of them: it is somewhere you go once you already run
   * DorkOS, which puts it at the end of the page rather than in the reading
   * path. It is still one click from every screen via the pill's overflow
   * menu.
   *
   * It sits on the close's own quiet line because the site footer underneath
   * does not carry it, and it is the one destination that would otherwise
   * vanish with the colophon that used to hold it.
   */
  marketplace: 'marketplace',
} as const;

/** What the download button offers, and what it costs. */
export const DOWNLOAD = {
  label: 'Download for Mac',
  terms: 'free · open source · apple silicon',
} as const;

/** Introduces the terminal install, wherever the download button appears. */
export const INSTALL_ASIDE = 'or run';

/**
 * What the terminal install needs, next to the command itself.
 *
 * `/install` says this too, but someone who copies the command straight off
 * this page never gets there, and the failure it saves them from is opaque.
 */
export const NPX_REQUIREMENT = 'needs node 22+';
