/**
 * The demo workspace's turns (`demo-workspace-scenarios.ts`), driven through
 * the real server path the messages route takes.
 *
 * The phone-approval turn is the one a person answers on camera, so what this
 * pins is that it genuinely WAITS for that answer and that Allow and Don't
 * allow end differently. A turn that streamed its ending regardless would
 * film fine and lie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
import { triggerTurn } from '../../../session/trigger-turn.js';
import { scenarioStore } from '../scenario-store.js';
import { TestModeRuntime } from '../test-mode-runtime.js';

const SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CWD = '/projects/demo';

/** Start a turn the way the messages route does, without waiting for it to end. */
function startTurn(runtime: TestModeRuntime, content: string) {
  const projector = getOrCreateProjector(SESSION, CWD);
  const accepted = triggerTurn({
    sessionId: SESSION,
    clientId: 'test-client',
    content,
    cwd: CWD,
    projector,
    deps: {
      acquireLock: (sid, cid, res) => runtime.acquireLock(sid, cid, res),
      releaseLock: (sid, cid) => runtime.releaseLock(sid, cid),
      sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
      interruptQuery: (sid) => runtime.interruptQuery(sid),
      getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
      rekeyProjector: () => {},
      getCapabilities: () => runtime.getCapabilities(),
    },
  });
  return { projector, accepted };
}

/** All assistant text the turn has produced so far. */
function streamedText(projector: ReturnType<typeof getOrCreateProjector>): string {
  return [...projector.replayFrom(0)]
    .filter((e): e is Extract<SessionEvent, { type: 'text_delta' }> => e.type === 'text_delta')
    .map((e) => e.text)
    .join('');
}

/** Fake time one drive step moves on: a few of the turns' own word beats. */
const CLOCK_STEP_MS = 100;

/** Fake time a drive may spend before it gives up: far past any turn here. */
const CLOCK_BUDGET_MS = 60_000;

/**
 * Move the fake clock on until `reached` holds. The turns pace themselves with
 * real-world beats (a word every 55 ms, a tool step every 650 ms, so they film
 * well); on the fake clock those beats still happen in order, without the wait.
 */
async function driveClockUntil(reached: () => boolean, what: string): Promise<void> {
  for (let spent = 0; !reached(); spent += CLOCK_STEP_MS) {
    if (spent >= CLOCK_BUDGET_MS) throw new Error(`the turn never reached: ${what}`);
    await vi.advanceTimersByTimeAsync(CLOCK_STEP_MS);
  }
}

/** Wait until the turn is parked on its approval. */
async function waitForApproval(projector: ReturnType<typeof getOrCreateProjector>): Promise<void> {
  // The text before the card streams word by word, a beat per word.
  await driveClockUntil(
    () => [...projector.replayFrom(0)].some((e) => e.type === 'approval_required'),
    'its approval card'
  );
}

/** Wait until the turn has ended. */
async function waitForIdle(projector: ReturnType<typeof getOrCreateProjector>): Promise<void> {
  await driveClockUntil(() => projector.getStatus().lifecycle === 'idle', 'idle');
}

beforeEach(() => {
  // Only the timers the turns pace themselves with; Date stays real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  // A case that failed mid-turn leaves that turn parked on a fake beat. Run its
  // clock out so it ends here and cannot hold the session for the next case.
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  scenarioStore.reset();
  disposeProjector(SESSION);
});

describe('demo-phone-approval', () => {
  it('waits for the answer, then publishes when allowed', async () => {
    scenarioStore.setForSession(SESSION, 'demo-phone-approval');
    const runtime = new TestModeRuntime();
    const { projector, accepted } = startTurn(runtime, "Publish this week's release notes");
    expect((await accepted).accepted).toBe(true);

    await waitForApproval(projector);
    // Still parked after a long wait: it waits for the person, not for a clock.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(projector.getStatus().lifecycle).toBe('blocked');
    expect(streamedText(projector)).not.toContain('live');

    expect(runtime.approveTool(SESSION, 'demo-phone-approval-1', true)).toBe(true);
    await waitForIdle(projector);
    expect(streamedText(projector)).toContain("This week's release notes are live.");
  }, 15_000);

  it('says it will not publish when denied', async () => {
    scenarioStore.setForSession(SESSION, 'demo-phone-approval');
    const runtime = new TestModeRuntime();
    const { projector, accepted } = startTurn(runtime, "Publish this week's release notes");
    expect((await accepted).accepted).toBe(true);

    await waitForApproval(projector);
    expect(runtime.approveTool(SESSION, 'demo-phone-approval-1', false)).toBe(true);
    await waitForIdle(projector);
    expect(streamedText(projector)).toContain("I won't publish them");
    expect(streamedText(projector)).not.toContain('are live');
  }, 15_000);
});

describe('demo-mini-app', () => {
  it('finishes on its own and sends the person to the yes it needs', async () => {
    scenarioStore.setForSession(SESSION, 'demo-mini-app');
    const runtime = new TestModeRuntime();
    const { projector, accepted } = startTurn(runtime, 'Build me a launch checklist');
    expect((await accepted).accepted).toBe(true);

    await waitForIdle(projector);
    expect(streamedText(projector)).toContain('waiting for you under **Needs you**');
  }, 15_000);
});

describe('demo-social-chat', () => {
  it('points at the Social queue tab, with no date, version or price', async () => {
    scenarioStore.setForSession(SESSION, 'demo-social-chat');
    const runtime = new TestModeRuntime();
    const { projector, accepted } = startTurn(runtime, "What's going out on X this week?");
    expect((await accepted).accepted).toBe(true);

    await waitForIdle(projector);
    const text = streamedText(projector);
    expect(text).toContain('**Social queue** tab beside this chat');
    // The marketing claim gate: nothing on screen that goes stale on camera.
    expect(text).not.toMatch(/\d+\.\d+\.\d+|\$\d|\b20\d\d\b/);
  }, 15_000);
});
