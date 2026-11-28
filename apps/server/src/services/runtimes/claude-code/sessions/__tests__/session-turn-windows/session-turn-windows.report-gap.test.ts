/**
 * session-turn-windows: a helper's report segment between its `system/init`
 * and its first word (DOR-5490). The frames are the captured burst; see
 * `./helper-burst.fixtures.ts`.
 *
 * The init clears the owed delivery and no window opens until the model's
 * first frame, so the process used to read as quiet for the whole time to
 * first token. A person's message launched into that gap (the queue asks
 * `isSegmentPending`, which reads `delivery-owed`), and a reap, a slot reclaim
 * or a relaunch for new settings (all of which ask `quietness()`) could end
 * the process mid-request.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../../../lib/logger.js';
import {
  burstSession,
  capturedBurst,
  indexOf,
  isSystem,
  REPORT_ANSWER,
} from './helper-burst.fixtures.js';

const SESSION_ID = 'sess-report-gap';

type Session = ReturnType<typeof burstSession>;

/** Run the person's first turn from the capture, through its `result`. */
async function firstTurn(s: Session, frames: SDKMessage[], reply: number): Promise<void> {
  const init = indexOf(frames, (f) => isSystem(f, 'init'));
  const dispatching = s.dispatch('m1', 'start background helpers');
  await vi.waitFor(() => expect(s.live()).toBeDefined());
  for (const frame of frames.slice(0, init + 1)) s.live().emit(frame);
  await dispatching;
  await s.emitAll(frames.slice(init + 1, reply + 1));
  await vi.waitFor(() => expect(s.windows.openWindow).toBeUndefined());
}

describe('a report segment that has opened but not yet spoken (DOR-5490)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('holds the process from the init to the answer, and lets it go after', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const s = burstSession(SESSION_ID);
    const frames = capturedBurst('between');
    const reply = indexOf(frames, (f) => f.type === 'result');
    const answerStarts = frames.findIndex((f, i) => i > reply && f.type === 'stream_event');
    await firstTurn(s, frames, reply);

    // Everything up to the model's first frame: the last segment's init and
    // its `requesting` status are the last two.
    await s.emitAll(frames.slice(reply + 1, answerStarts));
    expect(isSystem(frames[answerStarts - 2]!, 'init')).toBe(true);
    expect(s.windows.openWindow).toBeUndefined();

    // What the queue, the reaper, the slot reclaim and a relaunch all ask.
    expect(s.pump.quietness()).toMatchObject({ quiet: false, because: 'delivery-owed' });
    expect(await s.pump.reap()).toBe(false);
    expect(s.pump.state).toBe('warm');

    // The first word opens a runtime window, which holds the process from here.
    await s.emitAll([frames[answerStarts]!]);
    expect(s.windows.openWindow?.origin).toBe('runtime');
    expect(s.pump.quietness()).toMatchObject({ quiet: false, because: 'runtime-turn-open' });

    // The answer arrives in that window, whole.
    await s.emitAll(frames.slice(answerStarts + 1));
    await vi.waitFor(() => expect(s.windows.openWindow).toBeUndefined());
    await s.projected();
    expect(s.opened.at(-1)?.origin).toBe('runtime');
    expect(s.lifecycles.at(-1)).toBe('idle');
    const answer = s.streamEvents
      .at(-1)!
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.data as { text?: string }).text ?? '')
      .join('');
    expect(answer).toBe(REPORT_ANSWER);
    expect(s.pump.quietness()).toMatchObject({ quiet: true });
  });
});
