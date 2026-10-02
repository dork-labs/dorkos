/**
 * The recording state machine, transition by transition (spec
 * `canvas-agent-seat` §3.1).
 *
 * The interesting half is what is LEFT behind. Every refusal here — a second
 * start, a stop with nothing running, a stop the window never answers — has to
 * leave the session able to start a fresh recording immediately, because the
 * state that survives a failure is the state that makes the next call lie.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { WORKBENCH } from '../../../../config/constants.js';
import { DevtoolsCaptureStore } from '../../devtools-capture-store.js';
import type { RawSessionEvent } from '../../session-state-projector.js';
import { createBrowserSeatHandlers } from '../handlers.js';
import { createRecordingHandlers } from '../recording.js';
import {
  NOTHING_RECORDING_NOTE,
  RECORDING_ALREADY_RUNNING_NOTE,
  RECORDING_STOP_TIMEOUT_NOTE,
} from '../recording.js';
import { NO_DRIVER_NOTE, NOT_INSTRUMENTED_NOTE } from '../act-protocol.js';

/** A stand-in for the calling session's stream, and a way to read what reached it. */
function makeSink() {
  const emitted: RawSessionEvent[] = [];
  return {
    emit: (event: RawSessionEvent) => {
      emitted.push(event);
      return true;
    },
    emitted,
  };
}

/** A store with one window holding one instrumented page. */
function storeWithDriver(instrumented = true): DevtoolsCaptureStore {
  const store = new DevtoolsCaptureStore();
  store.ingest(
    's1',
    { documentId: 'doc-a', seq: 1, console: [], network: [], active: true, instrumented },
    'client-a'
  );
  return store;
}

/** Read one pushed event, typed enough to assert on. */
function pushed(emitted: RawSessionEvent[], index = -1) {
  return emitted.at(index) as unknown as {
    type: string;
    requestId: string;
    targetClientId: string;
    documentId: string;
    action?: string;
    recordingId?: string;
    capture?: boolean;
    bounds?: { longEdgePx: number; frameMs: number; maxBytes: number };
  };
}

/** Both handler sets over one store and one session, as the tool layer builds them. */
function seat(store: DevtoolsCaptureStore, stopTimeoutMs = 50) {
  const { emit, emitted } = makeSink();
  const resolveAction = store.resolveAction.bind(store);
  store.resolveAction = (result) => {
    const request = emitted.find(
      (e) => (e as unknown as { requestId?: string }).requestId === result.requestId
    ) as { documentId?: string; targetClientId?: string } | undefined;
    resolveAction({ ...result, documentId: request?.documentId }, request?.targetClientId);
  };
  const deps = { sessionId: 's1', store, emit };
  return {
    emitted,
    store,
    driving: createBrowserSeatHandlers(deps, 50),
    recording: createRecordingHandlers({ ...deps, cwd: '/tmp/cwd' }, stopTimeoutMs),
  };
}

describe('starting a recording', () => {
  it('addresses the window holding the page and carries the encoding bounds', async () => {
    const { recording, emitted } = seat(storeWithDriver());

    const answer = await recording.start({});

    expect(answer.payload.ok).toBe(true);
    const event = pushed(emitted);
    expect(event.type).toBe('devtools_recording_request');
    expect(event).toMatchObject({
      action: 'start',
      targetClientId: 'client-a',
      documentId: 'doc-a',
      bounds: {
        longEdgePx: WORKBENCH.RECORDING_LONG_EDGE_PX,
        frameMs: WORKBENCH.RECORDING_FRAME_MS,
        maxBytes: WORKBENCH.MAX_RECORDING_BYTES,
      },
    });
    expect(event.recordingId).toBe(answer.payload.recordingId);
  });

  it('refuses a second recording in a sentence, and keeps the first one running', async () => {
    const { recording, store } = seat(storeWithDriver());
    const first = await recording.start({});

    const second = await recording.start({});

    expect(second.payload).toMatchObject({ ok: false, note: RECORDING_ALREADY_RUNNING_NOTE });
    // The refusal did not disturb what was already filming.
    expect(store.recordingFor('s1')?.id).toBe(first.payload.recordingId);
  });

  it('refuses when no window is holding a page, and films nothing', async () => {
    const store = new DevtoolsCaptureStore();
    store.ingest('s1', { documentId: 'doc-a', seq: 1, console: [], network: [] });
    const { recording } = seat(store);

    const answer = await recording.start({});

    expect(answer.payload).toMatchObject({ ok: false, note: NO_DRIVER_NOTE });
    expect(store.recordingFor('s1')).toBeUndefined();
  });

  it('refuses a page DorkOS is not instrumenting', async () => {
    const store = storeWithDriver(false);
    const { recording } = seat(store);

    const answer = await recording.start({});

    expect(answer.payload).toMatchObject({ ok: false, note: NOT_INSTRUMENTED_NOTE });
    expect(store.recordingFor('s1')).toBeUndefined();
  });

  it('ends the recording before refusing a stop with nowhere to save', async () => {
    // The one path that could leave dangling state: a stop that returns without
    // clearing it makes every later start refuse "already running" and every
    // later stop refuse again, with nothing able to break the loop.
    const store = storeWithDriver();
    const { emit } = makeSink();
    const deps = { sessionId: 's1', store, emit };
    const withCwd = createRecordingHandlers({ ...deps, cwd: '/tmp/cwd' });
    const withoutCwd = createRecordingHandlers(deps);
    await withCwd.start({});

    const answer = await withoutCwd.stop();

    expect(answer.payload.ok).toBe(false);
    expect(String(answer.payload.note)).toContain('nowhere to save');
    expect(store.recordingFor('s1')).toBeUndefined();
    // And the session is not wedged: the very next start works.
    expect((await withCwd.start({})).payload.ok).toBe(true);
  });

  it('refuses a session with nowhere to save, before anything is filmed', async () => {
    const store = storeWithDriver();
    const { emit } = makeSink();
    const recording = createRecordingHandlers({ sessionId: 's1', store, emit });

    const answer = await recording.start({});

    expect(answer.payload.ok).toBe(false);
    expect(String(answer.payload.note)).toContain('nowhere to save');
    expect(store.recordingFor('s1')).toBeUndefined();
  });
});

describe('a running recording turns every action into a frame', () => {
  it('puts `capture` on the driving request, and counts what comes back', async () => {
    const { recording, driving, emitted, store } = seat(storeWithDriver());
    await recording.start({});

    const answer = driving.click({ text: 'Pay' });
    const request = pushed(emitted);
    expect(request.capture).toBe(true);
    store.resolveAction({ requestId: request.requestId, ok: true, captured: true });
    await answer;

    expect(store.recordingFor('s1')?.frames).toBe(1);
  });

  it('counts nothing when the page could not be rasterized', async () => {
    const { recording, driving, emitted, store } = seat(storeWithDriver());
    await recording.start({});

    const answer = driving.click({ text: 'Pay' });
    store.resolveAction({ requestId: pushed(emitted).requestId, ok: true });
    await answer;

    // The action happened; no frame did. Counting the REQUEST would make the
    // stop answer claim a picture nobody has.
    expect(store.recordingFor('s1')?.frames).toBe(0);
  });

  it('leaves `capture` off when nothing is recording', async () => {
    const { driving, emitted, store } = seat(storeWithDriver());

    const answer = driving.click({ text: 'Pay' });
    expect(pushed(emitted).capture).toBeUndefined();
    store.resolveAction({ requestId: pushed(emitted).requestId, ok: true });
    await answer;
    expect(store.recordingFor('s1')).toBeUndefined();
  });

  it('stops filming at the ceiling and keeps driving', async () => {
    const { recording, driving, emitted, store } = seat(storeWithDriver());
    await recording.start({});

    for (let i = 0; i < WORKBENCH.MAX_RECORDING_FRAMES; i++) {
      const answer = driving.click({ text: 'Pay' });
      store.resolveAction({
        requestId: pushed(emitted).requestId,
        ok: true,
        captured: true,
      });
      await answer;
    }
    expect(store.recordingFor('s1')?.full).toBe(true);

    // One more action: it still runs, and it no longer asks for a frame.
    const after = driving.click({ text: 'Pay' });
    expect(pushed(emitted).capture).toBeUndefined();
    store.resolveAction({
      requestId: pushed(emitted).requestId,
      ok: true,
      did: 'Clicked.',
    });
    expect((await after).payload).toMatchObject({ ok: true, did: 'Clicked.' });
  });

  it('counts an action the recording could not film, and says so on stop', async () => {
    const store = storeWithDriver();
    const { recording, driving, emitted } = seat(store, 500);
    await recording.start({});

    // A person brought a preview to the front in ANOTHER window. The action is
    // addressed there, really runs, and is not in the film.
    store.ingest(
      's1',
      { documentId: 'doc-b', seq: 2, console: [], network: [], active: true, instrumented: true },
      'client-b'
    );
    const acted = driving.click({ text: 'Pay' });
    const request = pushed(emitted);
    expect(request.targetClientId).toBe('client-b');
    // Never asked for a frame from a window that is not holding the buffer.
    expect(request.capture).toBeUndefined();
    store.resolveAction({ requestId: request.requestId, ok: true, did: 'Clicked.' });
    // The action itself still succeeds — the run is not what went wrong.
    expect((await acted).payload).toMatchObject({ ok: true, did: 'Clicked.' });

    const stopping = recording.stop();
    const stopEvent = pushed(emitted);
    store.resolveRecording(stopEvent.requestId, {
      ok: true,
      path: '.dork/.temp/recordings/rec.gif',
      bytes: 10,
      frames: 2,
      durationMs: 1_000,
      keyframe: null,
    });

    const answer = await stopping;
    // `ok: true` with an unexplained gap is the one thing §10 forbids.
    expect(answer.payload).toMatchObject({ ok: true, missed: 1 });
    // And it reads as one thing, not as several.
    expect(String(answer.payload.note)).toContain(
      '1 action you took happened in another window while this was recording, so it is not in ' +
        'the file.'
    );
  });

  it('does not count an action that never came back as one that happened', async () => {
    const store = storeWithDriver();
    const { recording, driving, emitted } = seat(store, 5);
    await recording.start({});

    // Same shape as above — the action is addressed to another window — except
    // that window never answers. Nothing happened there, so the recording has
    // no gap to own up to: saying it does would make the count claim more than
    // the run did.
    store.ingest(
      's1',
      { documentId: 'doc-b', seq: 2, console: [], network: [], active: true, instrumented: true },
      'client-b'
    );
    const acted = driving.click({ text: 'Pay' });
    expect(pushed(emitted).targetClientId).toBe('client-b');
    expect((await acted).payload).toMatchObject({ ok: false });

    const stopping = recording.stop();
    store.resolveRecording(pushed(emitted).requestId, {
      ok: true,
      path: '.dork/.temp/recordings/rec.gif',
      bytes: 10,
      frames: 2,
      durationMs: 1_000,
      keyframe: null,
    });

    const stopped = await stopping;
    expect(stopped.payload.missed).toBeUndefined();
    expect(String(stopped.payload.note)).not.toContain('another window');
  });

  it('says nothing about missed frames when the whole run was filmed', async () => {
    const { recording, driving, emitted, store } = seat(storeWithDriver(), 500);
    await recording.start({});
    const answer = driving.click({ text: 'Pay' });
    store.resolveAction({
      requestId: pushed(emitted).requestId,
      ok: true,
      captured: true,
    });
    await answer;

    const stopping = recording.stop();
    store.resolveRecording(pushed(emitted).requestId, {
      ok: true,
      path: '.dork/.temp/recordings/rec.gif',
      bytes: 10,
      frames: 3,
      durationMs: 1_000,
      keyframe: null,
    });

    const stopped = await stopping;
    expect(stopped.payload.missed).toBeUndefined();
    expect(String(stopped.payload.note)).not.toContain('another window');
  });

  it('drops the buffer when the window lets that page go', async () => {
    const { recording, store } = seat(storeWithDriver());
    await recording.start({});

    store.ingest(
      's1',
      { documentId: 'doc-a', seq: 2, console: [], network: [], active: false },
      'client-a'
    );

    expect(store.recordingFor('s1')).toBeUndefined();
  });

  it('keeps the recording when a DIFFERENT window releases a different page', async () => {
    const store = storeWithDriver();
    const { recording } = seat(store);
    await recording.start({});

    store.ingest(
      's1',
      { documentId: 'doc-b', seq: 2, console: [], network: [], active: false },
      'client-b'
    );

    expect(store.recordingFor('s1')).toBeDefined();
  });
});

describe('stopping a recording', () => {
  it('asks the window that started it, and answers with the file it wrote', async () => {
    const { recording, emitted, store } = seat(storeWithDriver(), 500);
    const started = await recording.start({});

    const stopping = recording.stop();
    const event = pushed(emitted);
    expect(event).toMatchObject({
      action: 'stop',
      targetClientId: 'client-a',
      documentId: 'doc-a',
      recordingId: started.payload.recordingId,
    });
    store.resolveRecording(event.requestId, {
      ok: true,
      path: '.dork/.temp/recordings/rec.gif',
      bytes: 743_210,
      frames: 6,
      durationMs: 3_000,
      keyframe: { data: 'aGk=', mimeType: 'image/png' },
    });

    const answer = await stopping;
    expect(answer.payload).toMatchObject({
      ok: true,
      path: '.dork/.temp/recordings/rec.gif',
      frames: 6,
      bytes: 743_210,
      seconds: 3,
    });
    // The last FRAME comes back as the picture, never the GIF.
    expect(answer.image).toEqual({ data: 'aGk=', mimeType: 'image/png' });
    expect(String(answer.payload.note)).toContain('last frame');
  });

  it('says the ceiling was reached when the run outran the film', async () => {
    const { recording, driving, emitted, store } = seat(storeWithDriver(), 500);
    await recording.start({});
    for (let i = 0; i < WORKBENCH.MAX_RECORDING_FRAMES; i++) {
      const answer = driving.click({ text: 'Pay' });
      store.resolveAction({
        requestId: pushed(emitted).requestId,
        ok: true,
        captured: true,
      });
      await answer;
    }

    const stopping = recording.stop();
    const event = pushed(emitted);
    store.resolveRecording(event.requestId, {
      ok: true,
      path: '.dork/.temp/recordings/rec.gif',
      bytes: 10,
      frames: WORKBENCH.MAX_RECORDING_FRAMES,
      durationMs: 1_000,
      keyframe: null,
    });

    const answer = await stopping;
    expect(String(answer.payload.note)).toContain('filled up');
    expect(answer.image).toBeUndefined();
  });

  it('refuses when nothing is being recorded', async () => {
    const { recording } = seat(storeWithDriver());

    expect((await recording.stop()).payload).toMatchObject({
      ok: false,
      note: NOTHING_RECORDING_NOTE,
    });
  });

  it('fails plainly when the window never comes back, and claims no file', async () => {
    const { recording, store } = seat(storeWithDriver(), 20);
    await recording.start({});

    const answer = await recording.stop();

    expect(answer.payload).toMatchObject({ ok: false, note: RECORDING_STOP_TIMEOUT_NOTE });
    expect(answer.payload.path).toBeUndefined();
    // And nothing is left behind: the very next start works.
    expect(store.recordingFor('s1')).toBeUndefined();
    expect((await recording.start({})).payload.ok).toBe(true);
  });

  it('passes the sentence the window gave through when it could not make a file', async () => {
    const { recording, emitted, store } = seat(storeWithDriver(), 500);
    await recording.start({});

    const stopping = recording.stop();
    store.resolveRecording(pushed(emitted).requestId, {
      ok: false,
      error: 'The recording came out bigger than 8 MB, so it was not saved.',
    });

    expect((await stopping).payload).toMatchObject({
      ok: false,
      note: 'The recording came out bigger than 8 MB, so it was not saved.',
    });
  });
});

describe('recording request publication', () => {
  it('refuses an unpublished start, rolls back its state and permits a later published start', async () => {
    const store = storeWithDriver();
    const emit = vi.fn(() => false);
    const handlers = createRecordingHandlers({ sessionId: 's1', cwd: '/tmp/cwd', store, emit });
    expect((await handlers.start({})).payload.ok).toBe(false);
    expect(store.recordingFor('s1')).toBeUndefined();
    emit.mockReturnValue(true);
    expect((await handlers.start({})).payload.ok).toBe(true);
    expect(store.recordingFor('s1')).toBeDefined();
  });

  it('settles an unpublished stop as a host failure and promptly clears its waiter, binding and timer', async () => {
    vi.useFakeTimers();
    const store = storeWithDriver();
    const emitted: RawSessionEvent[] = [];
    const emit = vi.fn((event: RawSessionEvent) => {
      emitted.push(event);
      return true;
    });
    const handlers = createRecordingHandlers(
      { sessionId: 's1', cwd: '/tmp/cwd', store, emit },
      1000
    );
    try {
      await handlers.start({});
      emit.mockReturnValue(false);
      let answer: Awaited<ReturnType<typeof handlers.stop>> | undefined;
      const stop = handlers.stop().then((result) => {
        answer = result;
      });
      await Promise.resolve();
      await Promise.resolve();
      const request = pushed(emitted);
      expect
        .soft(answer?.payload)
        .toMatchObject({ ok: false, evidence: { source: 'host', verified: true } });
      expect.soft(store.pendingRecording(request.requestId)).toBeUndefined();
      expect.soft(vi.getTimerCount()).toBe(0);
      expect(store.recordingFor('s1')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      await stop;
    } finally {
      store.clear();
      vi.useRealTimers();
    }
  });

  it('publishes the exact bound host and installs its stop waiter before a synchronous reply', async () => {
    const store = new DevtoolsCaptureStore();
    store.ingest(
      'bound-session',
      {
        documentId: 'doc',
        seq: 0,
        console: [],
        network: [],
        active: true,
        instrumented: true,
        bridgeGeneration: 'generation',
      },
      'host'
    );
    const emit = vi.fn((event: RawSessionEvent) => {
      const request = pushed([event]);
      if (
        event.type === 'devtools_recording_request' &&
        (request.action === 'start' || request.action === 'confirm-start')
      ) {
        store.ingest(
          'bound-session',
          {
            hostOutcome: 'host',
            documentId: 'doc',
            bridgeGeneration: 'generation',
            seq: 0,
            console: [],
            network: [],
            recordingStart: {
              requestId: request.requestId,
              recordingId: request.recordingId!,
              phase: request.action === 'start' ? 'reserved' : 'started',
              ok: true,
            },
          },
          'host'
        );
      }
      if (event.type === 'devtools_recording_request' && request.action === 'stop') {
        expect(store.pendingRecording(request.requestId)?.binding).toEqual({
          clientId: 'host',
          documentId: 'doc',
          bridgeGeneration: 'generation',
        });
        store.resolveRecording(request.requestId, {
          ok: false,
          error: 'Controlled host failure.',
          provenance: 'host',
        });
      }
      return true;
    });
    const handlers = createRecordingHandlers(
      { sessionId: 'bound-session', cwd: '/tmp/cwd', store, emit },
      100
    );
    expect((await handlers.start({})).payload.ok).toBe(true);
    expect(emit.mock.calls[0][0]).toMatchObject({
      action: 'start',
      targetClientId: 'host',
      documentId: 'doc',
      bridgeGeneration: 'generation',
    });
    expect((await handlers.stop()).payload).toMatchObject({
      ok: false,
      evidence: { source: 'host', verified: true },
    });
    expect(store.recordingFor('bound-session')).toBeUndefined();
  });
});

it.each(['original', 'replacement'] as const)(
  'failed start rolls back only its recording after reentrant buffer rekey (%s)',
  async (mode) => {
    const store = storeWithDriver();
    const emit = () => {
      if (mode === 'replacement') {
        store.endRecording('s1');
        store.startRecording('s1', {
          id: 'replacement',
          documentId: 'doc-a',
          clientId: 'client-a',
        });
      }
      store.rekeySession('s1', 'canonical');
      return false;
    };
    const handlers = createRecordingHandlers({ sessionId: 's1', cwd: '/tmp/cwd', store, emit });
    expect((await handlers.start({})).payload.ok).toBe(false);
    expect(store.recordingFor('s1')).toBeUndefined();
    if (mode === 'replacement') expect(store.recordingFor('canonical')?.id).toBe('replacement');
    else expect(store.recordingFor('canonical')).toBeUndefined();
  }
);

describe('bound recording START phases', () => {
  function boundStore() {
    const store = new DevtoolsCaptureStore();
    store.ingest(
      's1',
      {
        seq: 0,
        console: [],
        network: [],
        documentId: 'doc-a',
        bridgeGeneration: 'gen',
        active: true,
        instrumented: true,
      },
      'client-a'
    );
    return store;
  }
  function reply(
    store: DevtoolsCaptureStore,
    request: ReturnType<typeof pushed>,
    phase: 'reserved' | 'started',
    options: { ok?: boolean } = {}
  ) {
    const ok = options.ok ?? true;
    store.ingest(
      's1',
      {
        hostOutcome: 'host',
        documentId: 'doc-a',
        bridgeGeneration: 'gen',
        seq: 0,
        console: [],
        network: [],
        recordingStart: {
          requestId: request.requestId,
          recordingId: request.recordingId!,
          phase,
          ok,
          ...(ok ? {} : { error: 'Controlled admission refusal.' }),
        },
      },
      'client-a'
    );
  }
  it('does not report successful START until a separately delivered started outcome', async () => {
    const store = boundStore();
    const sent: RawSessionEvent[] = [];
    const handlers = createRecordingHandlers({
      sessionId: 's1',
      cwd: '/tmp/cwd',
      store,
      emit: (event) => {
        sent.push(event);
        if (pushed([event]).action === 'start') reply(store, pushed([event]), 'reserved');
        return true;
      },
    });
    let settled = false;
    const answer = handlers.start({}).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(pushed(sent).action).toBe('confirm-start');
    expect(settled).toBe(false);
    reply(store, pushed(sent), 'started');
    expect((await answer).payload.ok).toBe(true);
    store.clear();
  });
  it.each(['reserved', 'started'] as const)(
    'lost %s outcome times out and rolls back only that reservation',
    async (missing) => {
      vi.useFakeTimers();
      const store = boundStore();
      try {
        const sent: RawSessionEvent[] = [];
        const handlers = createRecordingHandlers({
          sessionId: 's1',
          cwd: '/tmp/cwd',
          store,
          emit: (event) => {
            sent.push(event);
            const request = pushed([event]);
            if (request.action === 'start' && missing !== 'reserved')
              reply(store, request, 'reserved');
            return true;
          },
        });
        const answer = handlers.start({});
        await vi.advanceTimersByTimeAsync(8001);
        expect((await answer).payload.ok).toBe(false);
        expect(pushed(sent).action).toBe('cancel-start');
        expect(store.recordingFor('s1')).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        store.clear();
        vi.useRealTimers();
      }
    }
  );
  it.each(['start', 'confirm-start'] as const)(
    'failed %s publication cancels its phase waiter immediately',
    async (fail) => {
      vi.useFakeTimers();
      const store = boundStore();
      try {
        const handlers = createRecordingHandlers({
          sessionId: 's1',
          cwd: '/tmp/cwd',
          store,
          emit: (event) => {
            const request = pushed([event]);
            if (request.action === fail) return false;
            if (request.action === 'start') reply(store, request, 'reserved');
            return true;
          },
        });
        expect((await handlers.start({})).payload.ok).toBe(false);
        expect(store.recordingFor('s1')).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        store.clear();
        vi.useRealTimers();
      }
    }
  );
  it('refused START cannot clear a different recording installed reentrantly and rekeyed', async () => {
    const store = boundStore();
    const handlers = createRecordingHandlers({
      sessionId: 's1',
      cwd: '/tmp/cwd',
      store,
      emit: (event) => {
        const request = pushed([event]);
        if (request.action === 'start') {
          reply(store, request, 'reserved', { ok: false });
          store.endRecording('s1');
          store.startRecording('s1', {
            id: 'replacement',
            documentId: 'doc-a',
            clientId: 'client-a',
            bridgeGeneration: 'gen',
          });
          store.rekeySession('s1', 'canonical');
        }
        return true;
      },
    });
    expect((await handlers.start({})).payload.ok).toBe(false);
    expect(store.recordingFor('canonical')?.id).toBe('replacement');
    store.clear();
  });
});
