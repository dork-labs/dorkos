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
import { nextBeat, type Beat } from './beats';
import { ChatWindow } from './ChatWindow';
import { CHAT_SCRIPT, PART_ONE_COUNT } from './chat-script';
import { LOCALHOST_CAPTION } from './copy';
import { PANEL } from './film-tokens';
import { LaptopFrame } from './LaptopFrame';
import { captionOpacityAt, chatScaleAt, shellOpacityAt } from './stage-timing';
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
 * The one long pinned animation the page revolves around.
 *
 * Beat one — the robots fly from their hero cards into the chat and talk.
 * Beat two — app icons fly off the dock into the messages that use them.
 * Beat three — the laptop materializes around that same chat as it shrinks:
 * it was on your computer all along.
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
  const shellOpacity = useTransform(progress, (v: number) => shellOpacityAt(v));
  const captionOpacity = useTransform(progress, (v: number) => captionOpacityAt(v));

  const target = joined && beat !== 'talk' ? CHAT_SCRIPT.length : joined ? PART_ONE_COUNT : 0;
  const { lines, pending } = useChatPlayback(target);
  const used = new Set(lines.map((line) => line.dockApp).filter(Boolean) as string[]);

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
        className="sticky top-0 flex h-screen flex-col items-center justify-center gap-5 overflow-hidden px-6"
      >
        <BeatHeadline beat={beat} />

        <LaptopFrame
          scale={reduced ? 1 : chatScale}
          shellOpacity={reduced && beat === 'computer' ? 1 : shellOpacity}
        >
          <ChatWindow joined={joined} lines={lines} pending={pending} />
        </LaptopFrame>

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
