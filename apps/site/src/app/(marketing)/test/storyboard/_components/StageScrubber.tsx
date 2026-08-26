'use client';

import { useState } from 'react';
import {
  Dock,
  BeatHeadline,
  captionOpacityAt,
  chatScaleAt,
  CHAT_SCRIPT,
  ChatWindow,
  DOCK,
  layBackAt,
  machineArrivalAt,
  machineOpacityAt,
  MacbookFrame,
  nextBeat,
  PART_ONE_COUNT,
  seatAt,
  SEAT_LIFT,
  STAGE_TIMING,
  type Beat,
} from '../../../new/_components';
import { FRAME_HEIGHT, FRAME_WIDTH } from './StoryFrame';

const SCALE = 0.62;

/** A labelled range input with its current value shown. */
function Slider({
  label,
  value,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-charcoal flex items-baseline justify-between text-sm font-medium">
        {label}
        <span className="text-warm-gray font-mono text-xs tabular-nums">{format(value)}</span>
      </span>
      <input
        type="range"
        min={0}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-brand-orange"
      />
    </label>
  );
}

/** One derived value, shown so the numbers behind the animation stay visible. */
function Readout({ name, value }: { name: string; value: string }) {
  return (
    <div className="border-border-warm rounded-md border px-3 py-2">
      <p className="text-2xs text-warm-gray font-mono tracking-[0.1em] uppercase">{name}</p>
      <p className="text-charcoal font-mono text-sm tabular-nums">{value}</p>
    </div>
  );
}

/**
 * Drives the real stage by hand. Drag the scroll position and the same
 * components the live page renders move through the same numbers — the fastest
 * way to judge where the machine should appear or how far the chat should
 * shrink, without scrolling the page over and over.
 *
 * Every value below is the live page's own function of `progress`, so this is
 * the whole finale under one finger: the machine rising, the chat falling into
 * the screen and tipping onto the lid on the way in.
 */
export function StageScrubber() {
  const [progress, setProgress] = useState(0.5);
  const [messages, setMessages] = useState(CHAT_SCRIPT.length);
  const [joined, setJoined] = useState(true);

  const beat: Beat = nextBeat(progress, 'talk');
  const chatScale = chatScaleAt(progress);
  const seat = seatAt(progress);
  const arrival = machineArrivalAt(progress);
  const presence = machineOpacityAt(progress);
  const layBack = layBackAt(progress);
  const captionOpacity = captionOpacityAt(progress);
  const lines = CHAT_SCRIPT.slice(0, messages);
  const used = new Set(lines.map((line) => line.dockApp).filter(Boolean) as string[]);

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div
        style={{ width: FRAME_WIDTH * SCALE, height: FRAME_HEIGHT * SCALE }}
        className="border-border-warm bg-cream-primary relative shrink-0 overflow-hidden rounded-xl border"
      >
        <div
          style={{
            width: FRAME_WIDTH,
            height: FRAME_HEIGHT,
            transform: `scale(${SCALE})`,
            transformOrigin: 'top left',
          }}
          className="flex flex-col items-center justify-center gap-5 px-6"
        >
          <BeatHeadline beat={beat} />
          <MacbookFrame
            scale={chatScale}
            lift={`${-SEAT_LIFT * seat}%`}
            rise={`${STAGE_TIMING.machineRise * (1 - arrival)}%`}
            presence={presence}
            drop={`${-STAGE_TIMING.chatDrop * (1 - seat)}%`}
            layBack={layBack}
          >
            <ChatWindow joined={joined} lines={lines} pending={null} />
          </MacbookFrame>
          <Dock present={beat !== 'talk'} visible={beat === 'yours'} used={used} />
          <p
            style={{ opacity: captionOpacity }}
            className="text-2xs text-warm-gray absolute bottom-8 font-mono tracking-[0.2em] uppercase"
          >
            home sweet localhost
          </p>
        </div>
      </div>

      <div className="flex min-w-64 flex-1 flex-col gap-5">
        <Slider
          label="Scroll through the stage"
          value={progress}
          max={1}
          step={0.005}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={setProgress}
        />
        <Slider
          label="Messages said"
          value={messages}
          max={CHAT_SCRIPT.length}
          step={1}
          format={(v) => `${v} of ${CHAT_SCRIPT.length}`}
          onChange={setMessages}
        />
        <label className="text-charcoal flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={joined}
            onChange={(e) => setJoined(e.target.checked)}
            className="accent-brand-orange"
          />
          Agents have joined the room
        </label>

        <div className="grid grid-cols-2 gap-2">
          <Readout name="beat" value={beat} />
          <Readout name="chat scale" value={chatScale.toFixed(3)} />
          <Readout name="machine risen" value={arrival.toFixed(3)} />
          <Readout name="machine solid" value={presence.toFixed(3)} />
          <Readout name="chat seated" value={seat.toFixed(3)} />
          <Readout name="lay back" value={`${layBack.toFixed(2)}°`} />
          <Readout name="caption opacity" value={captionOpacity.toFixed(3)} />
        </div>

        <div className="border-border-warm text-warm-gray rounded-md border p-3 text-sm">
          <p className="text-charcoal font-medium">To change the timing</p>
          <p className="mt-1">
            Edit <code className="font-mono text-xs">STAGE_TIMING</code> in{' '}
            <code className="font-mono text-xs">(marketing)/_components/stage-timing.ts</code>. The
            live page and this scrubber both read it.
          </p>
          <ul className="mt-2 list-none space-y-0.5 font-mono text-xs">
            <li>
              shrink · seat {STAGE_TIMING.shrinkFrom} → {STAGE_TIMING.shrinkTo}
            </li>
            <li>
              machine {STAGE_TIMING.machineFrom} → {STAGE_TIMING.machineTo} (solid by{' '}
              {STAGE_TIMING.machineFadeTo})
            </li>
            <li>
              caption {STAGE_TIMING.captionFrom} → {STAGE_TIMING.captionTo}
            </li>
            <li>
              talk beat ends after {PART_ONE_COUNT} lines · {DOCK.length} apps
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
