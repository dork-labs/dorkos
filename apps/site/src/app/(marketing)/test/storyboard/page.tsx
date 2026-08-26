import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AppGallery,
  BeatStrip,
  CastGallery,
  PaletteAndType,
  StageScrubber,
  StoryboardSection,
} from './_components';

export const metadata: Metadata = {
  title: 'Storyboard — /new',
  description: 'The beats, cast, and palette behind /new, driven by its own components.',
  robots: { index: false, follow: false },
};

/**
 * `/test/storyboard` — an internal design surface for `/new`.
 *
 * Every frame and swatch below renders the page's real components rather than
 * a mockup, so the storyboard cannot drift from what ships, and the scrubber
 * drives the same timing constants the live page reads.
 */
export default function StoryboardPage() {
  return (
    <main className="mx-auto max-w-[1700px] px-6 pt-32 pb-24">
      <p className="text-2xs text-brand-orange mb-3 font-mono tracking-[0.15em] uppercase">
        internal · not indexed
      </p>
      <h1 className="text-charcoal font-mono text-3xl font-bold tracking-tight sm:text-4xl">
        Storyboard: one page, one animation
      </h1>
      <p className="text-warm-gray mt-4 max-w-2xl text-lg">
        The page at{' '}
        <Link href="/new" className="text-brand-orange underline underline-offset-4">
          /new
        </Link>{' '}
        leads with the 56-second film and then proves it with a scroll-driven animation around one
        chat. This page pins every moment of that so the visuals can be worked on without scrolling
        the page over and over. Everything here is the live components — change one and this page
        changes with it.
      </p>

      <StoryboardSection
        step="the story"
        title="Eight frames, in order"
        description="What a visitor sees, moment by moment. Each frame is a real 1440×900 render, scaled down."
      >
        <BeatStrip />
      </StoryboardSection>

      <StoryboardSection
        step="the controls"
        title="Scrub the animation by hand"
        description="Drag through the pinned stage and watch the same numbers the live page uses. This is the fastest way to judge where the laptop should appear or how far the chat should shrink."
      >
        <StageScrubber />
      </StoryboardSection>

      <StoryboardSection
        step="the cast"
        title="Three robots and a person"
        description="Original cartoon faces, so the page ships no third-party artwork. Each agent carries a small badge for the runtime behind it."
      >
        <CastGallery />
      </StoryboardSection>

      <StoryboardSection
        step="the apps"
        title="What flies into the chat"
        description="Each app appears twice: on the dock, and inside the message that uses it. The dashed slot is what it leaves behind."
      >
        <AppGallery />
      </StoryboardSection>

      <StoryboardSection
        step="the vocabulary"
        title="Eight colors, four sizes"
        description="The page's entire visual system. The palette is the brand's cream-on-charcoal identity inverted, with one accent."
      >
        <PaletteAndType />
      </StoryboardSection>
    </main>
  );
}
