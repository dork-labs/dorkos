/**
 * A scripted turn that really drives the browser preview (spec
 * `canvas-agent-seat` §2).
 *
 * ## Why this scenario calls the real handlers instead of faking a tool call
 *
 * Every other test-mode scenario yields tool events it composed itself, which is
 * right when the thing under test is the UI's reaction to a tool call. Here the
 * thing under test is the round trip itself: the server resolving the driver
 * seat, the addressed window forwarding the command into its frame, the shim
 * acting on a real page, and the answer coming back. A scenario that yielded a
 * hand-written `act-result` would prove none of that — it would be the
 * hypothesis, written down.
 *
 * So it builds the production handlers over the production seam — the calling
 * session's own durable stream — and awaits the real answer. The only piece not
 * exercised is the capability wrapper around them, which the unit tests own.
 *
 * Inert unless a test selects it with `POST /api/test/scenario`.
 *
 * @module services/runtimes/test-mode/browser-driving-scenarios
 */
import type { StreamEvent } from '@dorkos/shared/types';
import {
  createBrowserSeatHandlers,
  devtoolsCaptureStore,
  emitToSession,
  type DrivingAnswer,
} from '../../session/index.js';
import type { ScenarioFn } from './scenario-store.js';

/** The button this scenario clicks, and the text the fixture page shows after. */
export const DRIVING_FIXTURE_BUTTON = 'Mark as done';

/** What the driven page shows once the button has been clicked. */
export const DRIVING_FIXTURE_DONE_TEXT = 'Done — 1 item';

/** One line of the turn's answer, so a spec can read the outcome off the message. */
function line(label: string, answer: DrivingAnswer): string {
  const payload = answer.payload as { ok?: boolean; did?: string; note?: string };
  return `${label}: ${payload.ok === true ? (payload.did ?? 'ok') : (payload.note ?? 'failed')}`;
}

/**
 * The browser-driving turn: read the page, click the button, wait for what the
 * click produced, and read the page back.
 *
 * @returns The scenario, under the name a test selects it by.
 */
export function browserDrivingScenarios(): Record<string, ScenarioFn> {
  const drive: ScenarioFn = async function* (_content, ctx) {
    const handlers = createBrowserSeatHandlers({
      sessionId: ctx.sessionId,
      store: devtoolsCaptureStore,
      emit: (event) => emitToSession(ctx.sessionId, event),
    });

    yield {
      type: 'session_status',
      data: { sessionId: ctx.sessionId, model: 'claude-haiku-4-5' },
    } as StreamEvent;

    const answers: string[] = [];

    /**
     * Run one verb and record what came back.
     *
     * The handler puts its request straight onto this session's durable stream —
     * the production path, which every window open on the session is already
     * reading — so there is nothing for this generator to forward. It waits for
     * the one real answer.
     */
    async function step(label: string, run: () => Promise<DrivingAnswer>): Promise<void> {
      const answer = await run();
      answers.push(line(label, answer));
      const outline = (answer.payload as { outline?: string }).outline;
      if (outline) answers.push(`${label}-outline: ${outline.replace(/\n/g, ' | ')}`);
    }

    await step('read', () => handlers.readPage({}));
    await step('click', () => handlers.click({ role: 'button', name: DRIVING_FIXTURE_BUTTON }));
    await step('wait', () =>
      handlers.waitFor({ text: DRIVING_FIXTURE_DONE_TEXT, timeoutMs: 4_000 })
    );
    await step('read-again', () => handlers.readPage({}));

    yield { type: 'text_delta', data: { text: answers.join('\n') } } as StreamEvent;
    yield { type: 'done', data: { sessionId: ctx.sessionId } } as StreamEvent;
  };

  return { 'browser-driving': drive };
}
