/**
 * session-turn-windows: several background helpers reporting at the same
 * moment (DOR-2829). The frames are captured; see `./helper-burst.fixtures.ts`.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../../../lib/logger.js';
import { resultMessage, textDeltaMessage } from './session-turn-windows.fixtures.js';
import {
  burstSession,
  capturedBurst,
  indexOf,
  isSystem,
  REPORT_ANSWER,
} from './helper-burst.fixtures.js';

const SESSION_ID = 'sess-helper-burst';

type Session = ReturnType<typeof burstSession>;

/** Each window's text, in opening order. */
function textsOf(s: Session): string[] {
  return s.streamEvents.map((events) =>
    events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.data as { text?: string }).text ?? '')
      .join('')
  );
}

/** Run the person's first turn from the capture, through frame `upTo`. */
async function firstTurn(s: Session, frames: SDKMessage[], upTo: number): Promise<void> {
  const init = indexOf(frames, (f) => isSystem(f, 'init'));
  const dispatching = s.dispatch('m1', 'start background helpers');
  await vi.waitFor(() => expect(s.live()).toBeDefined());
  for (const frame of frames.slice(0, init + 1)) s.live().emit(frame);
  await dispatching;
  await s.emitAll(frames.slice(init + 1, upTo + 1));
}

/** The captured burst after the parent's reply: where its answer starts, and where it ends. */
function burstBetweenTurns() {
  const frames = capturedBurst('between');
  const reply = indexOf(frames, (f) => f.type === 'result');
  const answerStarts = frames.findIndex((f, i) => i > reply && f.type === 'stream_event');
  return { frames, reply, answerStarts };
}

describe('several helpers reporting at once (DOR-2829)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives each captured segment a clean turn, and shows the answer once', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const s = burstSession(SESSION_ID);
    const { frames, reply } = burstBetweenTurns();
    await firstTurn(s, frames, reply);
    await s.emitAll(frames.slice(reply + 1));
    await vi.waitFor(() => expect(s.windows.openWindow).toBeUndefined());
    await s.projected();

    // The CLI's two empty segments are turns of the agent's own with nothing
    // in them, and neither is called a failure.
    expect(s.opened.map((w) => w.origin)).toEqual(['user', 'runtime', 'runtime', 'runtime']);
    expect(s.lifecycles).toEqual(['idle', 'idle', 'idle', 'idle']);
    expect(textsOf(s)).toEqual(['PARENT-REPLY', '', '', REPORT_ANSWER]);
  });

  it('lets the answer finish when a message arrives while it is being written', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const s = burstSession(SESSION_ID);
    const { frames, reply, answerStarts } = burstBetweenTurns();
    await firstTurn(s, frames, reply);
    await s.emitAll(frames.slice(reply + 1, answerStarts + 1));
    expect(s.windows.openWindow?.origin).toBe('runtime');

    // A message arrives: its turn settles whatever is open, then dispatches.
    expect(s.windows.abandonOpenWindow()).toBe(false);
    const dispatching = s.dispatch('m2', 'how is it going?');
    await s.emitAll(frames.slice(answerStarts + 1));
    await dispatching;
    await s.emitAll([textDeltaMessage('going well'), resultMessage('m2')]);
    await vi.waitFor(() => expect(s.windows.openWindow).toBeUndefined());
    await s.projected();

    expect(s.lifecycles).not.toContain('error');
    expect(s.opened.map((w) => w.origin)).toEqual([
      'user',
      'runtime',
      'runtime',
      'runtime',
      'user',
    ]);
    expect(textsOf(s)).toEqual(['PARENT-REPLY', '', '', REPORT_ANSWER, 'going well']);
  });

  it('keeps reports that land beside a tool result inside the turn', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const s = burstSession(SESSION_ID);
    const frames = capturedBurst('live');
    await firstTurn(s, frames, frames.length - 1);
    await vi.waitFor(() => expect(s.windows.openWindow).toBeUndefined());
    await s.projected();

    expect(s.opened.map((w) => w.origin)).toEqual(['user']);
    expect(s.lifecycles).toEqual(['idle']);
    expect(textsOf(s)).toEqual([REPORT_ANSWER]);
  });
});
