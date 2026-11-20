/** Real task projection/queue cleanup when final canonical ownership is refused. */
import { afterEach, expect, it, vi } from 'vitest';
import { RequiredSessionIdentityError } from '../../../lib/replay/required-session-identity-error.js';
import { claimRunTurn, TASK_RUN_CLIENT_ID } from '../session/run-projection.js';
import { onRequiredSessionRekey } from '../../session/turn-identity/durable-rekey.js';
import {
  disposeProjector,
  getOrCreateProjector,
  peekProjector,
  type RawSessionEvent,
} from '../../session/session-state-projector.js';

const original = '4328-task-original';
const target = '4328-task-independent';
afterEach(() => {
  disposeProjector(original);
  disposeProjector(target);
});
it('releases the original lock and queue even when finish first discovers a mandatory refusal', async () => {
  const refusal = new RequiredSessionIdentityError(new Error('required native identity refused'));
  let canonical: string | undefined;
  const held = new Map<string, symbol | undefined>();
  const releaseLock = vi.fn((id: string, _client: string, token?: symbol) => {
    if (held.get(id) === token) held.delete(id);
  });
  const runtime = {
    getInternalSessionId: () => canonical,
    acquireLock: (id: string, _client: string, _holder: unknown, token?: symbol) => {
      if (held.has(id)) return false;
      held.set(id, token);
      return true;
    },
    releaseLock,
  };
  const independent = getOrCreateProjector(target, '/independent');
  const generation = independent.streamGeneration;
  independent.ingest({ type: 'turn_start' });
  independent.ingest({ type: 'text_delta', text: 'Independent history' } as RawSessionEvent);
  const unregister = onRequiredSessionRekey((from, to) => {
    if (from === original && to === target) throw refusal;
  });
  try {
    const turn = await claimRunTurn({
      sessionId: original,
      cwd: '/original',
      prompt: 'New task',
      capabilities: undefined,
      runtime,
    });
    expect(turn).not.toBeNull();
    canonical = target;
    await expect(turn!.finish()).rejects.toBe(refusal);
    expect(held.has(original)).toBe(false);
    expect(releaseLock).toHaveBeenCalledWith(original, TASK_RUN_CLIENT_ID, expect.any(Symbol));
    expect(releaseLock).not.toHaveBeenCalledWith(target, expect.anything(), expect.anything());
    expect(peekProjector(target)).toBe(independent);
    expect(independent.streamGeneration).toBe(generation);
    const snapshot = await independent.buildSnapshot(async () => []);
    expect(snapshot.inProgressTurn).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text_delta', text: 'Independent history' }),
      ])
    );
    const abort = new AbortController();
    const subscriber = independent.subscribe(snapshot.cursor, abort.signal)[Symbol.asyncIterator]();
    const nextEvent = subscriber.next();
    independent.ingest({
      type: 'text_delta',
      text: 'Independent next turn remains usable',
    } as RawSessionEvent);
    expect(await nextEvent).toMatchObject({
      done: false,
      value: { type: 'text_delta', text: 'Independent next turn remains usable' },
    });
    abort.abort();
    // Repeating finish must neither silently accept the alias nor release a
    // different owner. A new claim on the original must actually become ready.
    await expect(turn!.finish()).rejects.toBe(refusal);
    canonical = undefined;
    const next = await claimRunTurn({
      sessionId: original,
      cwd: '/original',
      prompt: 'Later task',
      capabilities: undefined,
      runtime,
    });
    expect(next).not.toBeNull();
    await next!.finish();
    expect(held.size).toBe(0);
  } finally {
    unregister();
  }
});
