import { FILM } from '../copy';
import { PROMO_CAPTIONS, PROMO_CUTS, PROMO_POSTER_ALT, PROMO_SECONDS } from '../film/promo-cuts';

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
  /**
   * The words on a placeholder tile's press, and in the panel it opens.
   *
   * A tile with no footage behind it used to be inert, which taught a visitor
   * nothing except that the page ignored them. Pressing one now says what is
   * actually true — the clip is not shot — and offers the one thing that can
   * be offered honestly, which is the mailing list new clips are announced on.
   * Nothing here may name a date or promise a feature; the pending chip stays
   * on the tile either way.
   */
  alert: {
    /** Announced after the card's title and chip, so the press explains itself. */
    triggerHint: string;
    /** The line that appears on the tile under a pointer or a focus ring. */
    cardCta: string;
    /** The panel's heading. */
    title: string;
    /** What the panel says before the email field. */
    lede: string;
    /** The dismiss control's accessible name. */
    close: string;
  };
  /**
   * The tile that closes the rail: its words and its destination.
   *
   * It carries no picture. The tile paints itself — a full frame of off-air
   * colour bars, drawn in CSS — so there is no asset to ship, nothing to
   * download, and no photograph that can go stale when the rail's contents
   * change. See `TutorialEndCard` for why bars and not a still.
   */
  endCard: {
    title: string;
    lede: string;
    label: string;
    href: string;
  };
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
  alert: {
    triggerHint: 'Open the newsletter signup.',
    cardCta: 'email me when clips land',
    title: 'Not shot yet.',
    lede: 'This one is still being made. New clips get announced in the DorkOS newsletter, so leave your email if you want to hear about them.',
    close: 'Close',
  },
  endCard: {
    // Plain words, on purpose. The tile behind them is already the period
    // joke — a frame of off-air colour bars — so the copy does not have to
    // reach for tapes or manuals to carry 1999. It says the two true things
    // in the honest order and gets out of the picture's way.
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
