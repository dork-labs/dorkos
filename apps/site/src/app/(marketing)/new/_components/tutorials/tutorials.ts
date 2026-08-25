import { FILM } from '../copy';
import { PROMO_CAPTIONS, PROMO_CUTS, PROMO_POSTER_ALT, PROMO_SECONDS } from '../promo-cuts';

/** A playable clip: the file, the still that stands in for it, and its length. */
export interface TutorialClip {
  src: string;
  poster: string;
  posterWidth: number;
  posterHeight: number;
  /** What the still shows, for anyone who cannot see it. */
  posterAlt: string;
  /** Caption track, if the clip has one. */
  captions?: string;
  /** Run time, rounded up, shown on the card as a chip. */
  seconds: number;
}

/** The still behind a card whose clip has not been shot yet. */
export interface TutorialPlate {
  src: string;
  alt: string;
  width: number;
  height: number;
}

/** One 9:16 tile on the rail. */
export interface TutorialCardSpec {
  id: string;
  /** What the card is called. */
  title: string;
  /**
   * The `features.ts` slug this card is about.
   *
   * Load-bearing, exactly as `DockApp.feature` is. A card is a promise that
   * something can be done, and the demo-claim gate says a page may only show
   * what actually ships, so `__tests__/home-copy.test.ts` resolves every slug
   * here against the feature catalog and fails on anything that is missing or
   * not `ga`. That applies to the unshot cards too: a placeholder that names a
   * capability makes the same promise a finished clip would.
   */
  feature: string;
  /** The clip, when one exists. Its absence is what makes a card a placeholder. */
  clip?: TutorialClip;
  /** The still a placeholder card sits on. */
  plate?: TutorialPlate;
}

/** The whole section, in one object: its words, its tiles and its end card. */
export interface TutorialRailConfig {
  eyebrow: string;
  title: string;
  lede: string;
  /** What a card says in place of a run time when its clip is not shot yet. */
  pendingChip: string;
  /** The tile that closes the rail. */
  endCard: { title: string; lede: string; label: string; href: string };
  cards: readonly TutorialCardSpec[];
}

/**
 * The clips rail, as this page configures it.
 *
 * One thing on this rail is real and the rest are frames waiting for footage,
 * and the section is built to say so rather than to hide it. The honest state
 * is in three places at once: the lede counts what exists, every unshot card
 * wears {@link TutorialRailConfig.pendingChip}, and the last tile is an end
 * card that sends anyone who wanted more to the docs, which are written.
 *
 * The placeholder titles still have to clear the demo-claim gate, because a
 * card that names a capability promises the capability whether or not the clip
 * behind it exists. Each one names a `ga` entry in the feature catalog, and
 * the chip is about the video, not the feature: the thing that is coming is
 * the clip.
 *
 * The section is one config object on purpose. Three sibling pages re-theme
 * this exact rail under their own names, and a section whose copy is spread
 * across its components is a section that gets re-themed in six files.
 */
export const TUTORIALS: TutorialRailConfig = {
  eyebrow: 'short clips',
  title: 'Learn it in a minute.',
  lede: 'One film is up. Short walkthroughs of each part are being made.',
  pendingChip: 'clip coming',
  endCard: {
    title: 'More on the way.',
    lede: 'The docs already cover all of it.',
    label: 'read the docs',
    href: '/docs',
  },
  cards: [
    {
      id: 'film',
      // The film's own title, taken from `copy.ts` rather than retyped. The
      // page is allowed the four approved lines about Dave and not a fifth,
      // and a card that invents one would be the fifth.
      title: FILM.title,
      feature: 'every-agent-one-place',
      clip: {
        // The vertical cut, whatever the visitor's screen is. This tile is a
        // 9:16 frame at every width, so the phone cut is the one that fits it,
        // and the landscape cut plays in the film section above.
        src: PROMO_CUTS.tall.src,
        poster: PROMO_CUTS.tall.poster,
        posterWidth: PROMO_CUTS.tall.posterWidth,
        posterHeight: PROMO_CUTS.tall.posterHeight,
        posterAlt: PROMO_POSTER_ALT,
        captions: PROMO_CAPTIONS,
        seconds: PROMO_SECONDS,
      },
    },
    {
      id: 'rooms',
      title: 'Put two agents in one room',
      feature: 'rooms',
      plate: {
        src: '/promo/tutorials/plate-phone.jpg',
        alt: 'A beige desk phone and its coiled cord on a 1999 office desk.',
        width: 511,
        height: 916,
      },
    },
    {
      id: 'skills',
      title: 'Add a skill from the marketplace',
      feature: 'marketplace',
      plate: {
        src: '/promo/tutorials/plate-cubicle.jpg',
        alt: 'A 1999 cubicle wall with blank index cards pinned to it, a wall clock and a fern.',
        width: 511,
        height: 916,
      },
    },
    {
      id: 'approvals',
      title: 'Decide what your agents can touch',
      feature: 'tool-approval',
      plate: {
        src: '/promo/tutorials/plate-folders.jpg',
        alt: 'A stack of blank manila folders and a dish of paper clips on a 1999 office desk.',
        width: 511,
        height: 916,
      },
    },
  ],
};
