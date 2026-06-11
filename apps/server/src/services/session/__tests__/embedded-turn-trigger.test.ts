import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { createEmbeddedTurnTrigger } from '../embedded-turn-trigger.js';
import {
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
  type SessionStateProjector,
} from '../session-state-projector.js';

/** A minimal one-turn scenario: a text token then a clean terminal `done`. */
function simpleTurn() {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'Hello from embedded' } } as StreamEvent;
    yield { type: 'done', data: { sessionId: 'ignored' } } as StreamEvent;
  };
}

/** A feed seam that drains the turn's events and records what it saw. */
function createRecordingFeed() {
  const fed: StreamEvent[] = [];
  let projector: SessionStateProjector | undefined;
  const feed = vi.fn(
    async (p: SessionStateProjector, events: AsyncIterable<StreamEvent>): Promise<void> => {
      projector = p;
      for await (const event of events) fed.push(event);
    }
  );
  return {
    feed,
    fed,
    getProjector: () => projector,
  };
}

describe('createEmbeddedTurnTrigger', () => {
  const disposed: string[] = [];

  /** Unique per-test session ids keep the module-level projector registry clean. */
  function sessionId(label: string): string {
    const id = `embedded-trigger-${label}-${crypto.randomUUID()}`;
    disposed.push(id);
    return id;
  }

  afterEach(() => {
    for (const id of disposed.splice(0)) disposeProjector(id);
  });

  it('accepts the turn, locks with the embedded clientId, and feeds the projector', async () => {
    // Real failure mode: an embedded send that never reaches the projector
    // delivers into a void — subscribeSession would show nothing.
    const runtime = new FakeAgentRuntime().withScenarios([simpleTurn()]);
    const { feed, fed, getProjector } = createRecordingFeed();
    const trigger = createEmbeddedTurnTrigger(runtime, feed);
    const id = sessionId('accept');

    const result = await trigger.trigger({
      sessionId: id,
      clientId: 'embedded-test-client',
      content: 'hi',
      cwd: '/tmp/vault',
    });

    expect(result.accepted).toBe(true);
    expect(runtime.acquireLock).toHaveBeenCalledWith(
      id,
      'embedded-test-client',
      expect.anything(),
      expect.any(Symbol)
    );
    // The detached turn settles asynchronously — wait for the feed to drain.
    await vi.waitFor(() => {
      expect(fed.length).toBeGreaterThan(0);
    });
    expect(getProjector()).toBe(peekProjector(id));
    await vi.waitFor(() => {
      expect(runtime.releaseLock).toHaveBeenCalled();
    });
  });

  it('rejects when the session lock is held — feed never starts', async () => {
    // Real failure mode: a second embedded send during an active turn must be
    // refused exactly like the HTTP 409, not silently run concurrently.
    const runtime = new FakeAgentRuntime();
    runtime.acquireLock.mockReturnValue(false);
    const { feed } = createRecordingFeed();
    const trigger = createEmbeddedTurnTrigger(runtime, feed);

    const result = await trigger.trigger({
      sessionId: sessionId('locked'),
      clientId: 'embedded-test-client',
      content: 'hi',
    });

    expect(result).toEqual({ accepted: false });
    expect(feed).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('returns the canonical id when the adapter resolves one mid-turn', async () => {
    // Real failure mode: a brand-new embedded session keeps its request UUID
    // forever if the canonical id never reaches the caller.
    const runtime = new FakeAgentRuntime().withScenarios([simpleTurn()]);
    runtime.getInternalSessionId.mockReturnValue('sdk-canonical-id');
    const { feed } = createRecordingFeed();
    const trigger = createEmbeddedTurnTrigger(runtime, feed);
    const id = sessionId('canonical');
    disposed.push('sdk-canonical-id'); // rekeyed registry entry

    const result = await trigger.trigger({
      sessionId: id,
      clientId: 'embedded-test-client',
      content: 'hi',
    });

    expect(result).toEqual({ accepted: true, canonicalId: 'sdk-canonical-id' });
  });

  it('stamps the caller cwd authoritatively over an earlier subscribe-path stamp', async () => {
    // Real failure mode: a projector first created by a cwd-less subscribe
    // pins liveness to the wrong project; the send's operator cwd must win.
    const runtime = new FakeAgentRuntime().withScenarios([simpleTurn()]);
    const { feed } = createRecordingFeed();
    const trigger = createEmbeddedTurnTrigger(runtime, feed);
    const id = sessionId('cwd');
    getOrCreateProjector(id, '/wrong/default');

    await trigger.trigger({
      sessionId: id,
      clientId: 'embedded-test-client',
      content: 'hi',
      cwd: '/right/project',
    });

    expect(peekProjector(id)?.cwd).toBe('/right/project');
  });
});
