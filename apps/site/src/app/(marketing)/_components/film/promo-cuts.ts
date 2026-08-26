/** Which cut of the promo a visitor gets: landscape, or the vertical phone cut. */
export type PromoCut = 'wide' | 'tall';

/**
 * The breakpoint that picks the cut. Matches Tailwind's `sm` (640px), so the
 * CSS that reserves the box and the JavaScript that picks the file cannot
 * disagree about which shape a visitor is looking at.
 */
export const PHONE_CUT_QUERY = '(max-width: 639px)';

/** One rendered cut of the promo: the video and the still that stands in for it. */
export interface PromoAssets {
  src: string;
  poster: string;
  /**
   * The still's real pixel size, put on the `<img>`/`<source>`.
   *
   * A lazily-loaded image with no declared size collapses to nothing until it
   * arrives and then shoves the page. These are each twice the box's largest
   * CSS width, which is what a retina screen asks for and no more.
   */
  posterWidth: number;
  posterHeight: number;
}

/**
 * The two web cuts of the promo, self-hosted under `public/promo/`.
 *
 * Only ever one of them loads: nothing is fetched until the visitor presses
 * play, and the poster is chosen by a `<picture>` `media` rule so the browser
 * downloads a single still. The mastered broadcast files stay off the web.
 */
export const PROMO_CUTS: Record<PromoCut, PromoAssets> = {
  wide: {
    src: '/promo/be-more-like-dave-16x9-web.mp4',
    poster: '/promo/poster-16x9.jpg',
    posterWidth: 1536,
    posterHeight: 864,
  },
  tall: {
    src: '/promo/be-more-like-dave-9x16-web.mp4',
    poster: '/promo/poster-9x16.jpg',
    posterWidth: 828,
    posterHeight: 1472,
  },
};

/** Caption track. Off by default: the video already burns in the narrator lines. */
export const PROMO_CAPTIONS = '/promo/be-more-like-dave.vtt';

/** Run time in seconds, rounded up from 55.8, so the page never undersells it. */
export const PROMO_SECONDS = 56;

/** What the poster shows, for anyone who cannot see it. */
export const PROMO_POSTER_ALT =
  'Dave at his 1999 office desk, giving a thumbs up beside a mug that reads World’s Okayest Employee.';

/**
 * The film's own cubicle plate, used as the backdrop of the film section.
 *
 * Already blurred in ffmpeg, which is why it is 40KB at 1920x1080 and why it
 * is set as a CSS background rather than an optimized `<img>`: it is wallpaper
 * behind a section, carries no information, and has nothing left to compress.
 */
export const ROOM_PLATE = '/promo/dorkspace-bg.jpg';

/**
 * The frame the page hands off on: the film's own chat, one beat in.
 *
 * It is the film's take of the exact four faces the live chat below uses, in
 * the same arrangement, which is what lets the page cut from the story to the
 * product without either one looking like a different piece of work. Resized
 * from the 1920px master to twice its largest rendered width.
 */
export const HANDOFF_STILL = {
  src: '/promo/still-agents.jpg',
  width: 1600,
  height: 900,
  alt: 'A moment from the film: Dave says “Hey, team.” and Otto answers “Morning, Dave.”, with Pip and Hal waiting beside him.',
} as const;
