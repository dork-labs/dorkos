import { describe, it, expect } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { INTERACTIVE_SCENARIOS } from '../interactive-scenarios.js';
import { toRawSessionEvent } from '../../../session/session-event-normalizer.js';
import type { ScenarioContext } from '../interaction-gate.js';

/**
 * What the interactive scenarios PARK in while a person is being asked
 * (DOR-2011).
 *
 * These fakes exist to put the browser tests in the state the real runtime
 * reaches, and that state changed: claude-code closes a tool's content block
 * when the model finishes typing its ARGUMENTS, and the frame that projects
 * from it now says `running` rather than `complete`. A fixture still saying
 * `complete` would park the reload tests in a state production no longer
 * produces — passing while asserting nothing about the shipped product, which
 * is the failure mode `interactive-scenarios.ts` was written to avoid in the
 * first place.
 *
 * Pinned here rather than only in the browser leg because this is a property of
 * the fixtures themselves, and it costs a millisecond to check.
 */

/** The scenarios that raise a prompt and then wait for an answer. */
const PARKING_SCENARIOS = [
  'approval-gated',
  'question-prompt',
  'question-expires',
  'approval-parks',
] as const;

/**
 * Drive a scenario up to the point it parks, collecting what it emitted.
 *
 * Every one of these waits on a `ScenarioContext` promise that nothing here
 * resolves, so the generator is abandoned mid-flight on purpose — the events
 * before the park are the whole subject.
 */
async function eventsBeforePark(name: string): Promise<StreamEvent[]> {
  const scenario = INTERACTIVE_SCENARIOS[name];
  if (!scenario) throw new Error(`no scenario named ${name}`);

  const never = <T>(): Promise<T> => new Promise<T>(() => {});
  const ctx = {
    sessionId: 'session-1',
    token: Symbol('turn') as unknown as ScenarioContext['token'],
    signal: new AbortController().signal,
    awaitApproval: never,
    awaitAnswers: never,
    awaitElicitation: never,
    awaitStep: never,
    delay: never,
  } as unknown as ScenarioContext;

  const events: StreamEvent[] = [];
  const iterator = scenario('go', ctx, undefined);
  // Bounded: every one of these parks well inside ten events, and a scenario
  // that stopped parking would otherwise hang this test rather than fail it.
  for (let i = 0; i < 10; i += 1) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<'parked'>((resolve) => setTimeout(() => resolve('parked'), 50)),
    ]);
    if (next === 'parked' || next.done) break;
    events.push(next.value);
  }
  // Deliberately NOT closed. `iterator.return()` on an async generator that is
  // suspended at an `await` queues behind that await — which is the park, and
  // never settles — so closing it politely is what would hang this test. The
  // abandoned generator holds one unresolved promise and no timer, and goes
  // when the test does.
  return events;
}

describe('interactive scenarios park in the state the real runtime parks in', () => {
  it.each(PARKING_SCENARIOS)('%s reports no finished tool while it waits', async (name) => {
    const events = await eventsBeforePark(name);

    // The prompt really did go up — without this the assertion below would pass
    // on a scenario that emitted nothing at all.
    expect(events.some((e) => e.type === 'approval_required' || e.type === 'question_prompt')).toBe(
      true
    );

    // And nothing it emitted claims a tool finished. Read off the DURABLE
    // frames, because that is where `tool_call_end` becomes a `tool_result` and
    // where a browser test would see it.
    const durable = events
      .map(toRawSessionEvent)
      .filter((event) => event !== null)
      .map((event) => event as unknown as { type: string; status?: string });

    expect(durable.filter((e) => e.type === 'tool_result' && e.status === 'complete')).toEqual([]);
    // The call is in flight, not merely absent: the resultless close is what
    // makes these fixtures able to catch DOR-1269 at all.
    expect(durable.some((e) => e.type === 'tool_result' && e.status === 'running')).toBe(true);
  });
});
