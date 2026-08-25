'use client';

import { useCallback, useState } from 'react';
import { Play } from 'lucide-react';
import {
  PHONE_CUT_QUERY,
  PROMO_CAPTIONS,
  PROMO_CUTS,
  PROMO_POSTER_ALT,
  PROMO_SECONDS,
  type PromoCut,
} from './promo-cuts';

/**
 * The promo, behind a press.
 *
 * It never autoplays. The film is scored and voiced and much weaker silent,
 * and a muted autoplay is the only kind browsers allow, so the page shows the
 * still and waits. That also happens to be the pattern reduced motion wants,
 * which is why there is no separate reduced-motion path: nothing moves until
 * a visitor asks it to.
 *
 * No video file is fetched before that press. The `<video>` element does not
 * exist yet, so a phone can never pull the landscape cut and a laptop can
 * never pull the vertical one — the cut is chosen at the moment of the press,
 * when the viewport is known for certain. The still is picked by a `<picture>`
 * media rule for the same reason: one press, one download, of one file.
 *
 * The still loads eagerly, unlike almost anything else on a marketing page.
 * This player sits on the second screen and the whole page is arranged to get
 * it pressed, so the poster is closer to a hero image than to a thumbnail, and
 * a play button drawn over an empty box does not invite a press.
 */
export function PromoPlayer() {
  const [cut, setCut] = useState<PromoCut | null>(null);

  const play = useCallback(() => {
    setCut(window.matchMedia(PHONE_CUT_QUERY).matches ? 'tall' : 'wide');
  }, []);

  // Start the moment the element exists. The press is the user gesture that
  // lets it play with sound. Focus moves here too: the button the visitor
  // just pressed no longer exists, and without this a keyboard user is left
  // on `<body>` with the controls they asked for out of reach.
  const startPlaying = useCallback((node: HTMLVideoElement | null) => {
    if (!node) return;
    void node.play().catch(() => undefined);
    node.focus({ preventScroll: true });
  }, []);

  return (
    <div className="mx-auto aspect-[9/16] w-full max-w-[26rem] overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.12)] bg-black shadow-[0_40px_120px_rgba(0,0,0,0.65)] sm:aspect-video sm:max-w-4xl lg:max-w-5xl">
      {cut === null ? (
        <button
          type="button"
          onClick={play}
          aria-label={`Play the video, ${PROMO_SECONDS} seconds, with sound`}
          className="group focus-visible:ring-brand-orange relative block size-full cursor-pointer focus-visible:ring-2 focus-visible:outline-none"
        >
          <picture>
            <source
              media={PHONE_CUT_QUERY}
              srcSet={PROMO_CUTS.tall.poster}
              width={PROMO_CUTS.tall.posterWidth}
              height={PROMO_CUTS.tall.posterHeight}
            />
            <img
              src={PROMO_CUTS.wide.poster}
              alt={PROMO_POSTER_ALT}
              width={PROMO_CUTS.wide.posterWidth}
              height={PROMO_CUTS.wide.posterHeight}
              loading="eager"
              decoding="async"
              className="size-full object-cover"
            />
          </picture>
          <span className="absolute inset-0 grid place-items-center bg-[rgba(19,17,16,0.35)] transition-colors group-hover:bg-[rgba(19,17,16,0.2)]">
            <span className="bg-brand-orange grid size-16 place-items-center rounded-full text-[#131110] shadow-[0_8px_32px_rgba(0,0,0,0.5)] transition-transform group-hover:scale-110 sm:size-20">
              <Play size={26} fill="currentColor" aria-hidden="true" />
            </span>
          </span>
        </button>
      ) : (
        <video
          ref={startPlaying}
          src={PROMO_CUTS[cut].src}
          poster={PROMO_CUTS[cut].poster}
          preload="none"
          controls
          playsInline
          className="size-full object-cover"
        >
          <track kind="captions" srcLang="en" label="English" src={PROMO_CAPTIONS} />
        </video>
      )}
    </div>
  );
}
