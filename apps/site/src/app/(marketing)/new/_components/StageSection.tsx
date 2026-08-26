'use client';

import { useEffect, useRef, useState } from 'react';
import {
  motion,
  useInView,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
} from 'motion/react';
import { Dock } from './Dock';
import { BeatHeadline } from './BeatHeadline';
import { beatProgressAt, BEAT_ORDER, nextBeat, type Beat } from './beats';
import { ChatWindow } from './ChatWindow';
import { CHAT_SCRIPT, PART_ONE_COUNT } from './chat-script';
import { LOCALHOST_CAPTION } from './copy';
import { PANEL } from './film-tokens';
import { MacbookFrame } from './MacbookFrame';
import { SEAT_LIFT } from './macbook-geometry';
import {
  captionOpacityAt,
  chatScaleAt,
  layBackAt,
  machineArrivalAt,
  machineOpacityAt,
  seatAt,
  STAGE_TIMING,
} from './stage-timing';
import { StageSteps } from './stage/StageSteps';
import { useChatPlayback } from './use-chat-playback';
import { useSectionProgress } from './use-section-progress';

/**
 * Height of the pinned stage, in viewports.
 *
 * Shorter than the animation strictly needs, and deliberately so. On this page
 * the stage is the proof, not the pitch: the film has already made the case by
 * the time a visitor reaches it, and every extra viewport of pinned scroll is
 * a viewport spent re-arguing something they have agreed to. Three beats, one
 * screen of scroll each, and out.
 */
const STAGE_VH = 320;

interface StageSectionProps {
  /** Reports whether the agents have joined, so the hero can empty its seats. */
  onJoinedChange: (joined: boolean) => void;
}

/**
 * The one long pinned animation the page revolves around, with the reader
 * given a map of it.
 *
 * Beat one — the robots fly from their hero cards into the chat and talk.
 * Beat two — app icons fly off the dock into the messages that use them.
 * Beat three — a MacBook rises from under the frame and takes that same chat
 * into its screen: it was on your computer all along.
 *
 * A pinned scroll is the only shape where the visitor's own hand moves the
 * picture, and that is worth keeping. What it never did was say where you
 * were inside it, so a step rail sits above the headline the whole time: the
 * beat you are in is lit and named, the rail under it fills as you move
 * through that beat, and the numeral ticks when the beat changes.
 *
 * The rail and the finale read the same scroll and do not collide. Beat three
 * begins at 0.66 and the machine starts arriving at 0.68, so the third
 * headline is already on screen before anything of the ending moves; by the
 * time the machine is seated at 0.90 the rail is three quarters through its
 * last step, and it finishes filling as the caption comes up.
 */
export function StageSection({ onJoinedChange }: StageSectionProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const joined = useInView(stickyRef, { amount: 0.6 });
  const progress = useSectionProgress(sectionRef);

  const [beat, setBeat] = useState<Beat>('talk');
  useMotionValueEvent(progress, 'change', (v) => setBeat((current) => nextBeat(v, current)));

  useEffect(() => {
    onJoinedChange(joined);
  }, [joined, onJoinedChange]);

  const chatScale = useTransform(progress, (v: number) => chatScaleAt(v));
  const captionOpacity = useTransform(progress, (v: number) => captionOpacityAt(v));

  // The finale's four: the assembly rides up to centre the finished machine,
  // the machine rises to meet the chat, the chat falls the last of the way
  // into the opening, and it tips onto the lid's plane on the way in.
  const lift = useTransform(progress, (v: number) => `${-SEAT_LIFT * seatAt(v)}%`);
  const rise = useTransform(
    progress,
    (v: number) => `${STAGE_TIMING.machineRise * (1 - machineArrivalAt(v))}%`
  );
  const presence = useTransform(progress, (v: number) => machineOpacityAt(v));
  const drop = useTransform(
    progress,
    (v: number) => `${-STAGE_TIMING.chatDrop * (1 - seatAt(v))}%`
  );
  const layBack = useTransform(progress, (v: number) => layBackAt(v));

  // How far through the beat you are standing in, which is what the rail
  // draws. Not how far through the stage: at 40% of the scroll you are 14% of
  // the way into beat two, and a rail that draws the first number is lying.
  const withinBeat = useTransform(progress, (v: number) => beatProgressAt(v));

  const target = joined && beat !== 'talk' ? CHAT_SCRIPT.length : joined ? PART_ONE_COUNT : 0;
  const { lines, pending } = useChatPlayback(target);
  const used = new Set(lines.map((line) => line.dockApp).filter(Boolean) as string[]);

  // Reduced motion gets the ending, not the journey: once the last beat is on
  // screen the machine is simply already there, seated and square.
  const seated = beat === 'computer';
  const still = {
    scale: seated ? chatScaleAt(1) : 1,
    lift: seated ? `${-SEAT_LIFT}%` : '0%',
    rise: '0%',
    presence: seated ? 1 : 0,
    drop: '0%',
    layBack: 0,
  };

  return (
    <section
      ref={sectionRef}
      id="how-it-works"
      tabIndex={-1}
      aria-label="How it works"
      className="relative focus:outline-none"
      style={{ height: `${STAGE_VH}vh` }}
    >
      <div
        ref={stickyRef}
        className="sticky top-0 flex h-screen flex-col items-center justify-center gap-5 overflow-hidden px-4 sm:px-6"
      >
        <StageSteps index={BEAT_ORDER.indexOf(beat)} within={withinBeat} />
        <BeatHeadline beat={beat} />

        <MacbookFrame
          scale={reduced ? still.scale : chatScale}
          lift={reduced ? still.lift : lift}
          rise={reduced ? still.rise : rise}
          presence={reduced ? still.presence : presence}
          drop={reduced ? still.drop : drop}
          layBack={reduced ? still.layBack : layBack}
        >
          <ChatWindow joined={joined} lines={lines} pending={pending} />
        </MacbookFrame>

        <Dock present={beat !== 'talk'} visible={beat === 'yours'} used={used} />

        <motion.p
          style={{ opacity: captionOpacity, color: PANEL.dim }}
          className="text-2xs absolute bottom-8 font-mono tracking-[0.2em] uppercase"
        >
          {LOCALHOST_CAPTION}
        </motion.p>
      </div>
    </section>
  );
}
