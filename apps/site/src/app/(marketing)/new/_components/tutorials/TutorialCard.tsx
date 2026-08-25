'use client';

import { useCallback, useState } from 'react';
import Image from 'next/image';
import { Play } from 'lucide-react';
import { PANEL } from '../film-tokens';
import type { TutorialCardSpec, TutorialClip, TutorialPlate } from './tutorials';

/** Bottom scrim, so a title stays readable over any frame. */
const SCRIM =
  'linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.35) 45%, transparent 100%)';

/** How dark the placeholder stills sit, so they read as texture and not as content. */
const PLATE_OPACITY = 0.42;

/**
 * The clip, playing.
 *
 * Mounted only once the tile has been pressed, which is what makes the sound
 * allowed: the press is the gesture browsers require, and a muted autoplay of
 * a scored film is the weaker thing anyway. Focus moves here on mount because
 * the button that was pressed no longer exists, and without it a keyboard
 * visitor is left on `<body>` with the controls they asked for out of reach.
 */
function PlayingClip({ clip }: { clip: TutorialClip }) {
  const start = useCallback((node: HTMLVideoElement | null) => {
    if (!node) return;
    void node.play().catch(() => undefined);
    node.focus({ preventScroll: true });
  }, []);

  return (
    <video
      ref={start}
      src={clip.src}
      poster={clip.poster}
      preload="none"
      controls
      playsInline
      className="size-full object-cover"
    >
      {clip.captions && <track kind="captions" srcLang="en" label="English" src={clip.captions} />}
    </video>
  );
}

/** The still, the brand's play button, and the press that swaps them for the clip. */
function ClipPoster({
  clip,
  title,
  onPlay,
}: {
  clip: TutorialClip;
  title: string;
  onPlay: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPlay}
      aria-label={`Play ${title}, ${clip.seconds} seconds, with sound`}
      className="focus-visible:ring-brand-orange block size-full cursor-pointer focus-visible:ring-2 focus-visible:outline-none"
    >
      <Image
        src={clip.poster}
        alt={clip.posterAlt}
        width={clip.posterWidth}
        height={clip.posterHeight}
        sizes="16rem"
        className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
      />
      <span
        aria-hidden="true"
        className="absolute inset-0 grid place-items-center bg-[rgba(19,17,16,0.28)] transition-colors group-hover:bg-[rgba(19,17,16,0.12)]"
      >
        <span className="bg-brand-orange grid size-12 place-items-center rounded-full text-[#131110] shadow-[0_8px_24px_rgba(0,0,0,0.5)] transition-transform group-hover:scale-110">
          <Play size={18} fill="currentColor" />
        </span>
      </span>
    </button>
  );
}

/**
 * A frame with no footage in it yet.
 *
 * The still behind it is decoration and is marked as such: it is a 1999 desk,
 * not a picture of the thing the card names, so describing it in alt text
 * would be describing the wrong subject. What the card is about is its title,
 * which is real text a screen reader reads. The ring is dashed and the glyph
 * is faint on purpose — nobody should have to press this to learn it is empty.
 */
function PendingPlate({ plate }: { plate?: TutorialPlate }) {
  return (
    <>
      {plate && (
        <Image
          src={plate.src}
          alt=""
          width={plate.width}
          height={plate.height}
          sizes="16rem"
          aria-hidden="true"
          className="size-full object-cover"
          style={{ opacity: PLATE_OPACITY }}
        />
      )}
      <span
        aria-hidden="true"
        className="absolute inset-0 grid place-items-center"
        style={{ background: 'rgba(11,11,11,0.35)' }}
      >
        <span
          className="grid size-12 place-items-center rounded-full border border-dashed"
          style={{ borderColor: 'rgba(255,255,255,0.28)', color: 'rgba(255,255,255,0.34)' }}
        >
          <Play size={16} />
        </span>
      </span>
    </>
  );
}

/** The title and the chip, over a scrim, on every tile that is not currently playing. */
function CardLabel({ title, chip, ready }: { title: string; chip: string; ready: boolean }) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 p-4"
      style={{ background: SCRIM }}
    >
      <p
        className="text-sm leading-snug font-semibold text-balance"
        style={{ color: ready ? '#fffefb' : 'rgba(255,254,251,0.72)' }}
      >
        {title}
      </p>
      <p
        className="text-2xs w-fit rounded-full px-2 py-0.5 font-mono tracking-[0.12em] uppercase"
        style={
          ready
            ? { background: 'rgba(255,255,255,0.14)', color: '#fffefb' }
            : { border: '1px dashed rgba(255,255,255,0.24)', color: 'rgba(255,254,251,0.6)' }
        }
      >
        {chip}
      </p>
    </div>
  );
}

interface TutorialCardProps {
  card: TutorialCardSpec;
  /** What an unshot card says where a run time would go. */
  pendingChip: string;
}

/**
 * One 9:16 tile.
 *
 * Two states, and the difference between them is visible at a glance, which is
 * the point: a card with footage wears the brand's solid play button and its
 * run time, a card without one wears a dashed ring and says the clip is
 * coming. Nobody has to press a placeholder to find out it is a placeholder.
 *
 * Nothing is fetched before a press — `preload="none"`, and the `<video>` does
 * not exist at all until then — so a rail of five tiles costs five stills.
 */
export function TutorialCard({ card, pendingChip }: TutorialCardProps) {
  const [playing, setPlaying] = useState(false);
  const { clip } = card;

  return (
    <li className="relative w-60 shrink-0 snap-start sm:w-64">
      <div
        className="group relative aspect-[9/16] w-full overflow-hidden rounded-2xl bg-black"
        style={{ border: `1px solid ${PANEL.border}` }}
      >
        {clip && playing && <PlayingClip clip={clip} />}
        {clip && !playing && (
          <ClipPoster clip={clip} title={card.title} onPlay={() => setPlaying(true)} />
        )}
        {!clip && <PendingPlate plate={card.plate} />}

        {!playing && (
          <CardLabel
            title={card.title}
            chip={clip ? `${clip.seconds}s` : pendingChip}
            ready={Boolean(clip)}
          />
        )}
      </div>
    </li>
  );
}
