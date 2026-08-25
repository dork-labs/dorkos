'use client';

import type { ReactNode } from 'react';
import { NIGHT_VARS } from '../../../new/_components';

/** Reference viewport every frame is composed against, then scaled down. */
export const FRAME_WIDTH = 1440;
export const FRAME_HEIGHT = 900;

interface StoryFrameProps {
  /** Beat number shown in the corner — the frames are a sequence. */
  step: number;
  title: string;
  /** What the visitor sees happen in this frame. */
  note: string;
  /** How much of full size to render at. */
  scale?: number;
  /**
   * Where the content sits in the frame. Full page sections are taller than
   * the frame, so they anchor to the top instead of overflowing both edges.
   */
  align?: 'center' | 'start';
  children: ReactNode;
}

/**
 * One storyboard frame: a real 1440×900 render of the page at a fixed moment,
 * scaled down so several fit side by side. Nothing here is a mockup — every
 * frame drives the same components the live page uses.
 */
export function StoryFrame({
  step,
  title,
  note,
  scale = 0.42,
  align = 'center',
  children,
}: StoryFrameProps) {
  return (
    <figure className="m-0 flex flex-col gap-3">
      <div
        style={{
          ...NIGHT_VARS,
          width: FRAME_WIDTH * scale,
          height: FRAME_HEIGHT * scale,
        }}
        className="relative overflow-hidden rounded-xl border border-(--line) bg-(--pitch)"
      >
        <div
          style={{
            width: FRAME_WIDTH,
            height: FRAME_HEIGHT,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
          className={`flex flex-col items-center gap-5 px-6 ${
            align === 'start' ? 'justify-start' : 'justify-center'
          }`}
        >
          {children}
        </div>
      </div>
      <figcaption className="flex gap-3">
        <span className="text-brand-orange font-mono text-xs tabular-nums">
          {String(step).padStart(2, '0')}
        </span>
        <span>
          <span className="text-charcoal block text-sm font-semibold">{title}</span>
          <span className="text-warm-gray block text-sm">{note}</span>
        </span>
      </figcaption>
    </figure>
  );
}
