import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { createEmbeddedTurnTrigger } from '../embedded-turn-trigger.js';
import {
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
} from '../session-state-projector.js';

/** A minimal one-turn scenario: a text token then a clean terminal `done`. */
function simpleTurn() {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'Hello from embedded' } } as StreamEvent;
    yield { type: 'done', data: { sessionId: 'ignored' } } as StreamEvent;
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
    // delivers into a void — subscribeSession would show nothing. Asserted
    // through the projector's replay buffer (the durable-stream source), not an
    // internal seam: the whole normalized turn must land there.
    const runtime = new FakeAgentRuntime().withScenarios([simpleTurn()]);
    const trigger = createEmbeddedTurnTrigger(runtime);
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
    // The detached turn settles asynchronously — wait for the closing turn_end.
    await vi.waitFor(() => {
      const types = (peekProjector(id)?.replayFrom(0) ?? []).map((e) => e.type);
      expect(types).toEqual(['turn_start', 'text_delta', 'turn_end']);
    });
    const delta = peekProjector(id)
      ?.replayFrom(0)
      .find((e) => e.type === 'text_delta');
    expect(delta).toMatchObject({ text: 'Hello from embedded' });
    await vi.waitFor(() => {
      expect(runtime.releaseLock).toHaveBeenCalled();
    });
  });

  it('rejects when the session lock is held — the turn never starts', async () => {
    // Real failure mode: a second embedded send during an active turn must be
    // refused exactly like the HTTP 409, not silently run concurrently.
    const runtime = new FakeAgentRuntime();
    runtime.acquireLock.mockReturnValue(false);
    const trigger = createEmbeddedTurnTrigger(runtime);
    const id = sessionId('locked');

    const result = await trigger.trigger({
      sessionId: id,
      clientId: 'embedded-test-client',
      content: 'hi',
    });

    expect(result).toEqual({ accepted: false });
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    // The projector exists (created before the lock check) but ingested nothing.
    expect(peekProjector(id)?.getCursor()).toBe(0);
  });

  it('returns the canonical id when the adapter resolves one mid-turn', async () => {
    // Real failure mode: a brand-new embedded session keeps its request UUID
    // forever if the canonical id never reaches the caller.
    const runtime = new FakeAgentRuntime().withScenarios([simpleTurn()]);
    runtime.getInternalSessionId.mockReturnValue('sdk-canonical-id');
    const trigger = createEmbeddedTurnTrigger(runtime);
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
    const trigger = createEmbeddedTurnTrigger(runtime);
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
