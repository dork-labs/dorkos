import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { PANEL } from '../film-tokens';
import type { TutorialRailConfig } from './tutorials';

/**
 * Full-tile scrim. Heavier than the one under a card's label, because this
 * tile carries three lines of type over the picture rather than one over the
 * bottom of it.
 */
const SCRIM =
  'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.66) 48%, rgba(0,0,0,0.34) 100%)';

/** How far back the photograph sits, so type wins and the shelf stays legible. */
const PLATE_OPACITY = 0.62;

/**
 * The tile that closes the rail.
 *
 * A rail that just stops leaves the visitor holding the question it raised —
 * where is the rest? This answers it in the honest order: there will be more,
 * and in the meantime the thing they were looking for is already written down.
 *
 * The photograph is a shelf of blank video cassettes, carried over from the
 * sibling retro page along with its words. It does three things a typographic
 * tile could not. It looks like a tile rather than like the end of the row's
 * furniture, so the last thing a visitor sees is an invitation. The cassettes
 * are visibly unlabelled, which is the honest state said in a picture: nothing
 * is recorded on them yet. And the period joke lands hardest here, at the one
 * place on the page where nothing about the product is being depicted, which
 * is the rule this page runs on — 1999 lives in the frame, never in the app.
 *
 * The dashed rule inside the tile is the rail's own grammar for "empty",
 * carried over from the placeholder cards so this reads as the shelf's last
 * blank rather than as a fifth clip.
 */
export function TutorialEndCard({ endCard }: { endCard: TutorialRailConfig['endCard'] }) {
  return (
    <li className="w-60 shrink-0 snap-start sm:w-64">
      <Link
        href={endCard.href}
        className="focus-visible:ring-brand-orange group relative flex aspect-[9/16] w-full flex-col justify-end overflow-hidden rounded-2xl bg-black p-4 focus-visible:ring-2 focus-visible:outline-none"
        style={{ border: `1px solid ${PANEL.border}` }}
      >
        <Image
          src={endCard.plate.src}
          alt=""
          width={endCard.plate.width}
          height={endCard.plate.height}
          sizes="16rem"
          aria-hidden="true"
          className="absolute inset-0 size-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.04]"
          style={{ opacity: PLATE_OPACITY }}
        />
        <span aria-hidden="true" className="absolute inset-0" style={{ background: SCRIM }} />
        <span
          aria-hidden="true"
          className="absolute inset-3 rounded-xl border border-dashed"
          style={{ borderColor: 'rgba(255,255,255,0.2)' }}
        />

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
