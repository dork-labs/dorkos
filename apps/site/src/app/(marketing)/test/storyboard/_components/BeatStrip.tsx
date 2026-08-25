'use client';

import {
  AppDock,
  BeatHeadline,
  CHAT_SCRIPT,
  ChatWindow,
  CloseSection,
  Hero,
  INTEGRATIONS,
  LaptopFrame,
  PART_ONE_COUNT,
} from '../../../_components';
import { StoryFrame } from './StoryFrame';

const NO_APPS: ReadonlySet<string> = new Set();
const ALL_APPS: ReadonlySet<string> = new Set(INTEGRATIONS.map((entry) => entry.id));
const TALK_LINES = CHAT_SCRIPT.slice(0, PART_ONE_COUNT);
const JOIN_LINES = CHAT_SCRIPT.slice(0, 1);

/** A chat sized for a frame, with the stage's spacing around it. */
function StageChat({ lines }: { lines: readonly (typeof CHAT_SCRIPT)[number][] }) {
  return (
    <div className="w-full max-w-xl">
      <ChatWindow joined lines={lines} pending={null} />
    </div>
  );
}

/**
 * The six moments of the page, in order, each rendered from the live
 * components at the state the scroll would put them in.
 */
export function BeatStrip() {
  return (
    <div className="flex flex-wrap gap-8">
      <StoryFrame
        step={1}
        title="Meet your team"
        note="Three agents float, waiting. One command."
        align="start"
      >
        <div className="w-full origin-top scale-[0.62]">
          <Hero joined={false} />
        </div>
      </StoryFrame>

      <StoryFrame
        step={2}
        title="They join"
        note="The robots fly out of their cards into the room."
      >
        <BeatHeadline beat="talk" />
        <StageChat lines={JOIN_LINES} />
      </StoryFrame>

      <StoryFrame step={3} title="They talk" note="You ask. They answer — and ask each other.">
        <BeatHeadline beat="talk" />
        <StageChat lines={TALK_LINES} />
      </StoryFrame>

      <StoryFrame
        step={4}
        title="Your apps join"
        note="Five icons fly off the dock into the messages that use them."
      >
        <BeatHeadline beat="yours" />
        <StageChat lines={CHAT_SCRIPT} />
        <AppDock present visible used={ALL_APPS} />
      </StoryFrame>

      <StoryFrame
        step={5}
        title="It was your computer"
        note="The laptop forms around the same chat as it shrinks."
      >
        <BeatHeadline beat="computer" />
        <LaptopFrame scale={0.62} shellOpacity={1}>
          <ChatWindow joined lines={CHAT_SCRIPT} pending={null} />
        </LaptopFrame>
        <AppDock present visible={false} used={ALL_APPS} />
      </StoryFrame>

      <StoryFrame
        step={6}
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
        <AppDock present visible used={NO_APPS} />
      </StoryFrame>
    </div>
  );
}
