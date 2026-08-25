import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { TutorialRailConfig } from './tutorials';

/**
 * The tile that closes the rail.
 *
 * A rail that just stops leaves the visitor holding the question it raised —
 * where is the rest? This answers it in the honest order: there will be more
 * clips, and in the meantime the thing they were looking for is already
 * written down. It is typographic rather than photographic, so it reads as the
 * end of the row and not as a fifth clip.
 */
export function TutorialEndCard({ endCard }: { endCard: TutorialRailConfig['endCard'] }) {
  return (
    <li className="w-60 shrink-0 snap-start sm:w-64" style={{ scrollSnapAlign: 'start' }}>
      <Link
        href={endCard.href}
        className="focus-visible:ring-brand-orange group flex aspect-[9/16] w-full flex-col justify-end rounded-2xl border border-dashed p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
        style={{ borderColor: 'rgba(255,255,255,0.18)' }}
      >
        <p className="text-sm leading-snug font-semibold" style={{ color: '#fffefb' }}>
          {endCard.title}
        </p>
        <p className="mt-2 text-sm leading-snug" style={{ color: 'rgba(255,254,251,0.55)' }}>
          {endCard.lede}
        </p>
        <p className="text-2xs text-brand-orange mt-4 flex items-center gap-1.5 font-mono tracking-[0.12em] uppercase">
          {endCard.label}
          <ArrowRight
            size={12}
            aria-hidden="true"
            className="transition-transform group-hover:translate-x-0.5"
          />
        </p>
      </Link>
    </li>
  );
}
