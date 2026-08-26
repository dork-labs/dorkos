/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, type RenderResult } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { BeatHeadline } from '../BeatHeadline';
import { BEATS, LOCALHOST_CAPTION } from '../copy';
import { StageSection } from '../stage/StageSection';
import { nextFrame, scrollToEndOfStage, stubBrowser } from './stage-harness';

/**
 * Long enough for the whole thirteen-line conversation to play out.
 *
 * Only `setTimeout` is faked. Motion drives its own animations off
 * `requestAnimationFrame`, and a fake clock that owns both leaves its frame
 * loop being pumped by a test that is trying to skip a conversation.
 */
const WHOLE_CONVERSATION_MS = 30_000;

/** One step of that clock: longer than the slowest pause between two lines. */
const STEP_MS = 1_000;

function mount(): RenderResult {
  return render(<StageSection onJoinedChange={() => {}} />);
}

/**
 * Let the conversation play to its end.
 *
 * One long jump would not do it: each line's timer is scheduled by the effect
 * that runs after the previous line landed, and effects flush when `act`
 * returns. So the clock moves in steps, the way it does in a browser.
 */
function playOut(): void {
  for (let step = 0; step < WHOLE_CONVERSATION_MS / STEP_MS; step += 1) {
    act(() => {
      vi.advanceTimersByTime(STEP_MS);
    });
  }
}

/** Settle whatever the scroll started: motion publishes its scroll on the next frame. */
async function settle(): Promise<void> {
  await act(async () => {
    await nextFrame();
    await nextFrame();
  });
}

/** The step the rail says the reader is standing in, one-based. */
function currentStep(container: HTMLElement): string | null {
  return container.querySelector('[aria-current="step"]')?.textContent ?? null;
}

/**
 * The headline the stage is actually showing.
 *
 * All three are in the document at once — that is what puts every beat's words
 * in the served HTML — so "the page contains this title" says nothing about
 * which beat is on screen. The two that are not current are hidden from a
 * screen reader, and that is what this reads.
 */
function headlineOnScreen(container: HTMLElement): string | null {
  const shown = [...container.querySelectorAll('h2')].filter(
    (heading) => heading.closest('[aria-hidden]')?.getAttribute('aria-hidden') !== 'true'
  );
  expect(shown, 'the stage is showing more than one headline').toHaveLength(1);
  return shown[0].textContent;
}

beforeEach(() => {
  stubBrowser();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the stage says where you are', () => {
  it('names which of the three beats you are standing in', () => {
    const { container } = mount();

    expect(currentStep(container)).toContain('Step 1 of 3');
    expect(headlineOnScreen(container)).toBe(BEATS.talk.title);
  });

  it('moves the lit step as the scroll moves', async () => {
    const { container } = mount();

    scrollToEndOfStage();
    await settle();

    expect(currentStep(container)).toContain('Step 3 of 3');
  });

  it('names every step, not only the one you are in', () => {
    // "How much is left" is the half the stage never answered before.
    const { container } = mount();
    const text = container.textContent ?? '';

    for (const beat of Object.values(BEATS)) {
      expect(text).toContain(beat.eyebrow);
    }
  });

  it('leaves the steps as a readout, not a control', () => {
    const { container } = mount();

    // The stage is steered by scrolling. Buttons here would offer a jump it
    // cannot make cleanly, since every pixel between two beats is a frame of
    // the animation.
    expect(container.querySelectorAll('nav[aria-label="Stage steps"] button')).toHaveLength(0);
  });
});

describe('every beat reaches the served HTML', () => {
  it('renders all three headlines on the server, not only the first', () => {
    // The stage is a scroll, and a scroll is something only a browser does.
    // Everything that reads a page without scrolling it — a search engine, a
    // model, a preview card, a reader with scripting off — sees exactly what
    // this string contains. Mounting one beat at a time left two thirds of the
    // page's argument out of it, "Your files stay home" included.
    const html = renderToString(<BeatHeadline beat="talk" />);

    for (const copy of Object.values(BEATS)) {
      expect(html, `"${copy.title}" is not in the served HTML`).toContain(copy.title);
      expect(html, `"${copy.lede}" is not in the served HTML`).toContain(copy.lede);
    }
  });

  it('still shows only the beat the scroll is on', () => {
    // The other two are painted at zero and hidden, which is what keeps the
    // page looking like one headline at a time rather than three stacked.
    const { container } = render(<BeatHeadline beat="yours" />);
    expect(headlineOnScreen(container)).toBe(BEATS.yours.title);
  });
});

describe('the stage still tells its story under the rail', () => {
  it('shows the agents asking and the person approving', async () => {
    // The rail is wayfinding, not content. Losing a line of the conversation
    // to it would be a worse trade than being lost.
    const { container } = mount();
    scrollToEndOfStage();
    await settle();
    playOut();

    const said = container.textContent ?? '';
    expect(said).toContain('Want me to deploy?');
    expect(said).toContain('Go ahead.');
    expect(said).toContain('Want the release-notes skill for this?');
    expect(said).toContain('Yes.');
  });

  it('ends on the beat that says where the work happens', async () => {
    const { container } = mount();
    scrollToEndOfStage();
    await settle();
    playOut();

    expect(headlineOnScreen(container)).toBe(BEATS.computer.title);
    expect(container.textContent).toContain(LOCALHOST_CAPTION);
  });

  it('keeps the page landmark the pill scrolls to', () => {
    mount();
    const section = document.getElementById('how-it-works');

    // The floating pill scrolls here and then focuses it. Losing either the id
    // or the focus stop breaks navigation in a way no visual review catches.
    expect(section).not.toBeNull();
    expect(section?.getAttribute('tabindex')).toBe('-1');
  });
});
