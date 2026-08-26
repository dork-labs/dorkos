/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, type RenderResult } from '@testing-library/react';
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
    expect(container.textContent).toContain(BEATS.talk.title);
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

    expect(container.textContent).toContain(BEATS.computer.title);
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
