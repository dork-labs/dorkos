'use client';

import {
  Dock,
  BeatHeadline,
  CastBridge,
  chatScaleAt,
  CHAT_SCRIPT,
  ChatWindow,
  CloseSection,
  FilmSection,
  Hero,
  DOCK,
  MacbookFrame,
  PART_ONE_COUNT,
  SEAT_LIFT,
} from '../../../_components';
import { StoryFrame } from './StoryFrame';

const NO_APPS: ReadonlySet<string> = new Set();
const ALL_APPS: ReadonlySet<string> = new Set(DOCK.map((entry) => entry.id));
const TALK_LINES = CHAT_SCRIPT.slice(0, PART_ONE_COUNT);
const JOIN_LINES = CHAT_SCRIPT.slice(0, 1);

/**
 * A chat sized for a frame, with the stage's spacing around it.
 *
 * It goes through `MacbookFrame` with the machine turned off rather than
 * sitting in a plain box, because that is literally what the stage does before
 * the machine rises: the frame owns the 16:10 screen from the first beat and
 * the laptop arrives around it. A plain box here would show a shape the page
 * never has.
 *
 * `flights={false}` on every chat in the strip. Four frames on one page each
 * render the same room, and a shared layout id claimed four times sends the
 * flight to whichever copy motion measured last — the faces landed in the
 * wrong frame and the dock tiles with them. These are stills, so they want
 * none of it.
 */
function StageChat({ lines }: { lines: readonly (typeof CHAT_SCRIPT)[number][] }) {
  return (
    <MacbookFrame presence={0}>
      <ChatWindow joined lines={lines} pending={null} flights={false} />
    </MacbookFrame>
  );
}

/**
 * The eight moments of the page, in order, each rendered from the live
 * components at the state the scroll would put them in.
 */
export function BeatStrip() {
  return (
    <div className="flex flex-wrap gap-8">
      <StoryFrame
        step={1}
        title="The claim"
        note="Half a screen: what it is, and how to get it."
        align="start"
      >
        <div className="w-full origin-top scale-[0.62]">
          <Hero />
        </div>
      </StoryFrame>

      <StoryFrame
        step={2}
        title="The film"
        note="Dave's room, full width, one press away."
        align="start"
      >
        <div className="w-full origin-top scale-[0.5]">
          <FilmSection />
        </div>
      </StoryFrame>

      <StoryFrame
        step={3}
        title="The turn"
        note="The cast steps out of the last frame and onto the page."
        align="start"
      >
        <div className="w-full origin-top scale-[0.5]">
          <CastBridge joined={false} />
        </div>
      </StoryFrame>

      <StoryFrame
        step={4}
        title="They join"
        note="The robots fly out of their cards into the room."
      >
        <BeatHeadline beat="talk" />
        <StageChat lines={JOIN_LINES} />
      </StoryFrame>

      <StoryFrame step={5} title="They talk" note="You ask. They answer — and ask each other.">
        <BeatHeadline beat="talk" />
        <StageChat lines={TALK_LINES} />
      </StoryFrame>

      <StoryFrame
        step={6}
        title="Your apps join"
        note="Five icons fly off the dock into the messages that use them."
      >
        <BeatHeadline beat="yours" />
        <StageChat lines={CHAT_SCRIPT} />
        <Dock present visible used={ALL_APPS} />
      </StoryFrame>

      <StoryFrame
        step={7}
        title="It was your computer"
        note="The machine has risen into its seat and taken the chat with it."
      >
        <BeatHeadline beat="computer" />
        {/* The end of the stage, read off the stage's own numbers rather than
            dialled in: the scale and the lift the live page holds at the last
            frame of the scroll. */}
        <MacbookFrame scale={chatScaleAt(1)} lift={`${-SEAT_LIFT}%`} presence={1}>
          <ChatWindow joined lines={CHAT_SCRIPT} pending={null} flights={false} />
        </MacbookFrame>
        <Dock present visible={false} used={ALL_APPS} />
      </StoryFrame>

      <StoryFrame
        step={8}
        title="The close"
        note="The tagline, then the one thing to do next."
        align="start"
      >
        <div className="w-full origin-top scale-[0.66]">
          <CloseSection />
        </div>
      </StoryFrame>

      <StoryFrame
        step={0}
        title="Empty dock (reference)"
        note="Before any app is used — for comparing icon treatments."
        scale={0.32}
      >
        <Dock present visible used={NO_APPS} />
      </StoryFrame>
    </div>
  );
}
