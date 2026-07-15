import { describe, it, expect, vi } from 'vitest';
import type { StreamEvent, ErrorEvent } from '@dorkos/shared/types';
import { guardTurnErrors } from '../trigger-turn.js';
import { SessionStateProjector } from '../session-state-projector.js';

/** An async source that yields nothing and throws the given error mid-turn. */
function throwingSource(err: unknown): AsyncIterable<StreamEvent> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }),
  };
}

/** Drain the guarded stream into an array of events. */
async function drain(source: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of source) out.push(e);
  return out;
}

/** The `error` event's data payload, if the stream emitted one. */
function errorData(events: StreamEvent[]): ErrorEvent | undefined {
  return events.find((e) => e.type === 'error')?.data as ErrorEvent | undefined;
}

describe('guardTurnErrors', () => {
  it('classifies a thrown auth error as auth_error', async () => {
    const projector = new SessionStateProjector('sess-auth');
    const events = await drain(
      guardTurnErrors(
        projector,
        throwingSource(
          new Error('Failed to authenticate. API Error: 401 OAuth access token has been revoked.')
        ),
        vi.fn()
      )
    );

    const data = errorData(events);
    expect(data?.category).toBe('auth_error');
    expect(data?.code).toBe('turn_exception');
    // The failure still closes the turn cleanly.
    expect(events.at(-1)?.type).toBe('done');
  });

  it('classifies a thrown non-auth error as execution_error', async () => {
    const projector = new SessionStateProjector('sess-exec');
    const onError = vi.fn();
    const events = await drain(
      guardTurnErrors(projector, throwingSource(new Error('spawn ENOENT')), onError)
    );

    expect(errorData(events)?.category).toBe('execution_error');
    // The original error is reported to the caller.
    expect(onError).toHaveBeenCalledOnce();
  });
});
