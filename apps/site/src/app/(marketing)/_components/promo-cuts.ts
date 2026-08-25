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
  /** `width/height` of the video, for the box the page reserves. */
  aspect: string;
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
    aspect: '16 / 9',
  },
  tall: {
    src: '/promo/be-more-like-dave-9x16-web.mp4',
    poster: '/promo/poster-9x16.jpg',
    aspect: '9 / 16',
  },
};

/** Caption track. Off by default: the video already burns in the narrator lines. */
export const PROMO_CAPTIONS = '/promo/be-more-like-dave.vtt';

/** Run time, rounded to the second, so the page can say what it is asking for. */
export const PROMO_SECONDS = 56;

/** What the poster shows, for anyone who cannot see it. */
export const PROMO_POSTER_ALT =
  'Dave at his 1999 office desk, giving a thumbs up beside a mug that reads World’s Okayest Employee.';
