'use client';

import { useCallback, useState } from 'react';
import Image from 'next/image';
import { Play } from 'lucide-react';
import { PANEL } from '../film-tokens';
import type {
  TutorialCardSpec,
  TutorialClip,
  TutorialPlate,
  TutorialRailConfig,
} from './tutorials';

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
 * A frame with no footage in it yet, and the press that admits it.
 *
 * The still behind it is decoration and is marked as such: it is a 1999 desk,
 * not a picture of the thing the card names, so describing it in alt text
 * would be describing the wrong subject. What the card is about is its title,
 * which is real text a screen reader reads. The ring is dashed and the glyph
 * is faint on purpose — nobody should have to press this to learn it is empty.
 *
 * It is a button all the same. An empty tile that swallows a press teaches the
 * visitor the page is not listening; this one opens a panel that says the clip
 * is not shot and offers the list new clips are announced on. The accessible
 * name carries the whole story in the order it matters — what the tile is,
 * that it has no clip, and what pressing it does — because a screen reader
 * gets no hover to discover the last part from.
 */
function PendingTile({
  card,
  pendingChip,
  hint,
  onOpen,
}: {
  card: TutorialCardSpec;
  pendingChip: string;
  hint: string;
  onOpen: (title: string, trigger: HTMLElement) => void;
}) {
  const plate: TutorialPlate | undefined = card.plate;

  return (
    <button
      type="button"
      onClick={(event) => onOpen(card.title, event.currentTarget)}
      aria-label={`${card.title}. ${pendingChip}. ${hint}`}
      className="focus-visible:ring-brand-orange block size-full cursor-pointer focus-visible:ring-2 focus-visible:outline-none"
    >
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
        className="absolute inset-0 grid place-items-center transition-colors"
        style={{ background: 'rgba(11,11,11,0.35)' }}
      >
        <span
          className="grid size-12 place-items-center rounded-full border border-dashed transition-colors group-hover:border-[rgba(255,255,255,0.5)] group-hover:text-[rgba(255,255,255,0.7)]"
          style={{ borderColor: 'rgba(255,255,255,0.28)', color: 'rgba(255,255,255,0.34)' }}
        >
          <Play size={16} />
        </span>
      </span>
    </button>
  );
}

/**
 * The title and the chip, over a scrim, on every tile that is not currently
 * playing, plus the one line an empty tile keeps for a pointer or a focus ring.
 *
 * That line stays hidden until then on purpose. Three tiles each asking for an
 * email at rest is a rail that begs; one that offers when you reach for it is a
 * rail that answers. Nothing is lost on a touch screen, where the press opens
 * the panel and the panel explains itself.
 */
function CardLabel({
  title,
  chip,
  ready,
  cta,
}: {
  title: string;
  chip: string;
  ready: boolean;
  cta?: string;
}) {
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
      {cta && (
        <p
          aria-hidden="true"
          className="text-2xs text-brand-orange font-mono tracking-[0.12em] uppercase opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100"
        >
          {cta}
        </p>
      )}
    </div>
  );
}

interface TutorialCardProps {
  card: TutorialCardSpec;
  /** What an unshot card says where a run time would go. */
  pendingChip: string;
  /** The words a placeholder tile's press carries and opens. */
  alert: TutorialRailConfig['alert'];
  /** Open the signup panel for this tile, and remember what to focus after. */
  onOpenAlert: (title: string, trigger: HTMLElement) => void;
}

/**
 * One 9:16 tile.
 *
 * Two states, and the difference between them is visible at a glance, which is
 * the point: a card with footage wears the brand's solid play button and its
 * run time, a card without one wears a dashed ring and says the clip is
 * coming. Nobody has to press a placeholder to find out it is a placeholder.
 * Both are pressable; what the press does is what differs. One plays 56
 * seconds. The other admits there is nothing to play and offers the list new
 * clips are announced on.
 *
 * Nothing is fetched before a press — `preload="none"`, and the `<video>` does
 * not exist at all until then — so a rail of five tiles costs five stills.
 */
export function TutorialCard({ card, pendingChip, alert, onOpenAlert }: TutorialCardProps) {
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
        {!clip && (
          <PendingTile
            card={card}
            pendingChip={pendingChip}
            hint={alert.triggerHint}
            onOpen={onOpenAlert}
          />
        )}

        {!playing && (
          <CardLabel
            title={card.title}
            chip={clip ? `${clip.seconds}s` : pendingChip}
            ready={Boolean(clip)}
            cta={clip ? undefined : alert.cardCta}
          />
        )}
      </div>
    </li>
  );
}
