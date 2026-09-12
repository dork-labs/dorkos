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
 * So it builds the production handlers over a local event queue, drains what
 * they push onto the turn's own stream, and awaits the real answer. The only
 * piece not exercised is the MCP tool wrapper around them, which the unit tests
 * own.
 *
 * Inert unless a test selects it with `POST /api/test/scenario`.
 *
 * @module services/runtimes/test-mode/browser-driving-scenarios
 */
import type { StreamEvent } from '@dorkos/shared/types';
import {
  createBrowserSeatHandlers,
  devtoolsCaptureStore,
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
    const eventQueue: StreamEvent[] = [];
    const handlers = createBrowserSeatHandlers({
      resolveSessionId: () => ctx.sessionId,
      store: devtoolsCaptureStore,
      session: { eventQueue },
    });

    yield {
      type: 'session_status',
      data: { sessionId: ctx.sessionId, model: 'claude-haiku-4-5' },
    } as StreamEvent;

    const answers: string[] = [];

    /**
     * Run one verb: the handler pushes its request synchronously, the generator
     * forwards it onto the turn's stream, and only then does it await the
     * answer. Forwarding after the await would leave the request sitting in a
     * local array while the handler waited for a reply nobody was ever asked
     * for.
     */
    async function* step(
      label: string,
      run: () => Promise<DrivingAnswer>
    ): AsyncGenerator<StreamEvent> {
      const pending = run();
      while (eventQueue.length > 0) yield eventQueue.shift() as StreamEvent;
      const answer = await pending;
      answers.push(line(label, answer));
      const outline = (answer.payload as { outline?: string }).outline;
      if (outline) answers.push(`${label}-outline: ${outline.replace(/\n/g, ' | ')}`);
    }

    yield* step('read', () => handlers.readPage({}));
    yield* step('click', () => handlers.click({ role: 'button', name: DRIVING_FIXTURE_BUTTON }));
    yield* step('wait', () =>
      handlers.waitFor({ text: DRIVING_FIXTURE_DONE_TEXT, timeoutMs: 4_000 })
    );
    yield* step('read-again', () => handlers.readPage({}));

    yield { type: 'text_delta', data: { text: answers.join('\n') } } as StreamEvent;
    yield { type: 'done', data: { sessionId: ctx.sessionId } } as StreamEvent;
  };

  return { 'browser-driving': drive };
}
