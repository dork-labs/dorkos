import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { PANEL } from '../film-tokens';
import type { TutorialRailConfig } from './tutorials';

/**
 * The seven main bars, muted to about half strength.
 *
 * SMPTE order, left to right: grey, yellow, cyan, green, magenta, red, blue.
 * Muted because a full-saturation bar is a siren next to this page's cream
 * palette, and because the modern half of this tile — the words, the link to
 * the docs — is what the visitor is actually meant to read. At full chroma the
 * tile wins the whole rail and says nothing.
 */
const BARS_MAIN =
  'linear-gradient(90deg,#8c8c8c 0 14.28%,#9c9140 0 28.56%,#3f7f8a 0 42.84%,#3f7f4a 0 57.12%,#8a4676 0 71.4%,#8f3c3c 0 85.68%,#3c4a8f 0 100%)';

/**
 * The castellation row: the same seven tones reversed, separated by black.
 *
 * On a real test card this row exists to check colour-difference timing. Here
 * it exists because two rows of unequal rhythm are what separate "a test card"
 * from "seven coloured stripes", and it is the cheapest possible way to buy
 * that recognition — one more gradient, no bytes on disk.
 */
const BARS_CASTELLATION =
  'linear-gradient(90deg,#3c4a8f 0 14.28%,#171717 0 28.56%,#8a4676 0 42.84%,#171717 0 57.12%,#3f7f8a 0 71.4%,#171717 0 85.68%,#8c8c8c 0 100%)';

/**
 * The bottom reference strip: -I, white, +Q, black, then the PLUGE steps.
 *
 * The three near-black steps at 68.6-85.7% are the PLUGE proper — sub-black,
 * black, super-black — and they are within a few points of each other by
 * design. They read here as a barely-there ripple at the foot of the frame,
 * which is exactly what they look like on a television, and they sit under the
 * heaviest part of the scrim where nothing is being read anyway.
 */
const BARS_PLUGE =
  'linear-gradient(90deg,#2f3550 0 17.1%,#b9b6ae 0 34.3%,#3b2f50 0 51.4%,#141414 0 68.6%,#0e0e0e 0 74.3%,#141414 0 80%,#1e1e1e 0 85.7%,#141414 0 100%)';

/**
 * Grain, as a data URI rather than a file.
 *
 * `feTurbulence` renders the same noise the site's `film-grain` utility uses,
 * but that utility is authored for light grounds (`mix-blend-mode: multiply`
 * at 3.5%) and these bars are mid-tone blocks of flat colour. Flat is the
 * giveaway: a CSS gradient with no noise on it reads as a CSS gradient, and a
 * broadcast test card read off a tape never does. Painted at `overlay` so it
 * dirties the light bars and the dark ones by the same amount.
 *
 * It costs no request and no bytes on disk, which is the other reason the tile
 * is drawn rather than photographed.
 */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 220 220' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E\")";

/** How large one tile of {@link GRAIN} is painted. */
const GRAIN_TILE = '220px 220px';

/**
 * Full-tile scrim, and the reason the words stay readable over a picture that
 * contains a white block.
 *
 * Heavier at the foot than a card's label scrim, because this tile carries
 * three lines of type over the busiest part of the frame rather than one over
 * the quietest. The 0.87 floor across the bottom quarter is not taste: the
 * brightest thing the bars can put behind the label is the reference strip's
 * white at #b9b6ae, and 0.87 of black over it lands the ground near #181818,
 * which measures 5.2:1 for the orange label and 16:1 for the off-white title.
 *
 * It then falls away fast rather than gradually. A gentle ramp buried the
 * castellation row in the same near-black as the type behind it, which threw
 * away the one row that makes seven stripes read as a test card. The knee at
 * 26% is where the type stops and the picture starts.
 */
const SCRIM =
  'linear-gradient(to top, rgba(0,0,0,0.93) 0%, rgba(0,0,0,0.87) 26%, rgba(0,0,0,0.25) 48%, rgba(0,0,0,0.04) 100%)';

/**
 * The tile that closes the rail: a full frame of off-air colour bars.
 *
 * A rail that just stops leaves the visitor holding the question it raised —
 * where is the rest? This answers it in the honest order: there will be more
 * clips, and in the meantime the thing they were looking for is already
 * written down.
 *
 * The bars do the work a photograph was doing badly. A still of an object is
 * one more thing to look at on a row of things to look at, and it reads as a
 * fifth clip; bars read as the end of the dial, instantly, to anyone who ever
 * owned a television. They also say the honest state in a picture — there is
 * no programme here yet — which is the whole point of the tile. And the period
 * joke lands at the one place on the page where nothing about the product is
 * being depicted, which is the rule this page runs on: 1999 lives in the
 * frame, never in the app.
 *
 * Three stacked bands rather than one gradient with three background sizes,
 * because percentage background positions resolve against the free space left
 * over rather than against the box, and the arithmetic that follows from that
 * is the kind nobody reads twice and everybody gets wrong once.
 *
 * The tile wears the same solid border as every card beside it, not the dashed
 * rule the empty cards wear. Dashed over bars is noise on top of noise, and
 * the bars already say "nothing recorded here" louder than a border can.
 */
export function TutorialEndCard({ endCard }: { endCard: TutorialRailConfig['endCard'] }) {
  return (
    <li className="w-60 shrink-0 snap-start sm:w-64">
      <Link
        href={endCard.href}
        className="focus-visible:ring-brand-orange group relative flex aspect-[9/16] w-full flex-col justify-end overflow-hidden rounded-2xl bg-black p-4 focus-visible:ring-2 focus-visible:outline-none"
        style={{ border: `1px solid ${PANEL.border}` }}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 transition-transform duration-500 motion-safe:group-hover:scale-[1.03]"
        >
          <span className="absolute inset-x-0 top-0 h-[60%]" style={{ background: BARS_MAIN }} />
          <span
            className="absolute inset-x-0 top-[60%] h-[7%]"
            style={{ background: BARS_CASTELLATION }}
          />
          <span
            className="absolute inset-x-0 top-[67%] h-[33%]"
            style={{ background: BARS_PLUGE }}
          />
          <span
            className="absolute inset-0"
            style={{
              backgroundImage: GRAIN,
              backgroundSize: GRAIN_TILE,
              opacity: 0.22,
              mixBlendMode: 'overlay',
            }}
          />
        </span>
        <span aria-hidden="true" className="absolute inset-0" style={{ background: SCRIM }} />

        <p className="relative text-sm leading-snug font-semibold" style={{ color: '#fffefb' }}>
          {endCard.title}
        </p>
        <p
          className="relative mt-2 text-sm leading-snug"
          style={{ color: 'rgba(255,254,251,0.66)' }}
        >
          {endCard.lede}
        </p>
        <p className="text-2xs text-brand-orange relative mt-4 flex items-center gap-1.5 font-mono tracking-[0.12em] uppercase">
          {endCard.label}
          <ArrowRight
            size={12}
            aria-hidden="true"
            className="transition-transform motion-safe:group-hover:translate-x-0.5"
          />
        </p>
      </Link>
    </li>
  );
}
