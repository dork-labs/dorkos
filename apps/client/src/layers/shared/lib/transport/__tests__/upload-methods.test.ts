/**
 * What `uploadFiles` promises the composer: it always ends, and it can always
 * be ended (DOR-494).
 *
 * Driven against the real `XMLHttpRequest` wiring through a fake XHR, because
 * jsdom's own implementation cannot express the case that matters — a socket
 * that stays open and says nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSystemMethods } from '../system-methods';
import { createRoomMethods } from '../room-methods';
import {
  UPLOAD_CANCELED_MESSAGE,
  UPLOAD_STALLED_MESSAGE,
  UPLOAD_STALL_TIMEOUT_MS,
  UPLOAD_UNREADABLE_MESSAGE,
} from '../upload-contract';
import type { UploadFile } from '@dorkos/shared/transport';

type Listener = (event: unknown) => void;

/** An XHR that does exactly nothing until a test tells it to. */
class FakeXhr {
  static instances: FakeXhr[] = [];

  status = 0;
  responseText = '';
  withCredentials = false;
  sent = false;
  aborted = false;
  /** The URL `open()` was called with — what the two destinations differ by. */
  url = '';

  private readonly listeners = new Map<string, Listener[]>();
  private readonly uploadListeners = new Map<string, Listener[]>();

  readonly upload = {
    addEventListener: (type: string, fn: Listener) => {
      this.uploadListeners.set(type, [...(this.uploadListeners.get(type) ?? []), fn]);
    },
  };

  constructor() {
    FakeXhr.instances.push(this);
  }

  static reset() {
    FakeXhr.instances = [];
  }

  static get latest(): FakeXhr {
    const xhr = FakeXhr.instances.at(-1);
    if (!xhr) throw new Error('no XMLHttpRequest was created');
    return xhr;
  }

  open(_method: string, url: string) {
    this.url = url;
  }

  send() {
    this.sent = true;
  }

  /** Matches the browser: aborting a live request fires `abort`. */
  abort() {
    this.aborted = true;
    this.emit(this.listeners, 'abort', {});
  }

  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  /** A chunk of the request body leaving the machine. */
  emitUploadProgress(loaded: number, total: number) {
    this.emit(this.uploadListeners, 'progress', { lengthComputable: true, loaded, total });
  }

  /** A byte of the response arriving. */
  emitDownloadProgress() {
    this.emit(this.listeners, 'progress', { lengthComputable: false });
  }

  succeedWith(uploads: unknown[]) {
    this.status = 200;
    this.responseText = JSON.stringify({ uploads });
    this.emitLoad();
  }

  /** The response has fully arrived — whatever it turned out to contain. */
  emitLoad() {
    this.emit(this.listeners, 'load', {});
  }

  private emit(registry: Map<string, Listener[]>, type: string, event: unknown) {
    for (const fn of registry.get(type) ?? []) fn(event);
  }
}

const file: UploadFile = {
  name: 'notes.txt',
  type: 'text/plain',
  size: 5,
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(5)),
} as UploadFile;

/**
 * Start an upload and wait until the request has actually been sent.
 *
 * Drains microtasks by hand rather than using `vi.waitFor`, which advances the
 * fake clock — and this suite's whole subject is a timer.
 */
async function startUpload(signal?: AbortSignal) {
  const methods = createSystemMethods('http://localhost:4242/api');
  const onProgress = vi.fn();
  const result = methods.uploadFiles([file], '/test/project', onProgress, signal);
  // Claim the rejection now. These uploads fail on a timer, well before the
  // assertion that inspects them, and Node reports a late-handled rejection as
  // an unhandled one.
  void result.catch(() => {});
  // The body is read (async) before the request exists.
  for (let i = 0; i < 10 && FakeXhr.instances.length === 0; i += 1) await Promise.resolve();
  expect(FakeXhr.instances).toHaveLength(1);
  return { result, onProgress };
}

/** Whether a promise has settled, without adopting its outcome. */
function settlement<T>(promise: Promise<T>) {
  const state = { done: false, reason: undefined as unknown };
  promise.then(
    () => {
      state.done = true;
    },
    (err: unknown) => {
      state.done = true;
      state.reason = err;
    }
  );
  return state;
}

beforeEach(() => {
  FakeXhr.reset();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('uploadFiles never hangs', () => {
  it('gives up on a connection that has said nothing, and aborts the request', async () => {
    const { result } = await startUpload();
    const xhr = FakeXhr.latest;
    expect(xhr.sent).toBe(true);

    // One tick short of the deadline it is still trying.
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS - 1);
    expect(xhr.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    await expect(result).rejects.toThrow(UPLOAD_STALLED_MESSAGE);
    // The request itself is gone, not just this promise.
    expect(xhr.aborted).toBe(true);
  });

  it('leaves a slow-but-alive upload alone', async () => {
    const { result, onProgress } = await startUpload();
    const state = settlement(result);
    const xhr = FakeXhr.latest;

    // Ten deadlines' worth of wall-clock, with a chunk moving just before each
    // one. A total-duration timeout would have killed this upload nine times.
    for (let i = 1; i <= 10; i += 1) {
      await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS - 1);
      xhr.emitUploadProgress(i * 10, 100);
    }

    expect(xhr.aborted).toBe(false);
    expect(state.done).toBe(false);
    expect(onProgress).toHaveBeenCalledTimes(10);

    // And it still completes.
    xhr.succeedWith([{ originalName: 'notes.txt', savedPath: '/test/project/notes.txt' }]);
    await expect(result).resolves.toHaveLength(1);
  });

  it('counts a slow response as life, not silence', async () => {
    const { result } = await startUpload();
    const state = settlement(result);
    const xhr = FakeXhr.latest;

    // Body fully sent, then a server that takes its time replying but keeps
    // dribbling bytes back.
    xhr.emitUploadProgress(100, 100);
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS - 1);
      xhr.emitDownloadProgress();
    }

    expect(xhr.aborted).toBe(false);
    expect(state.done).toBe(false);
  });

  /**
   * The one wedge neither escape hatch can reach.
   *
   * A 2xx is not proof DorkOS answered — a proxy interstitial, a captive portal
   * or an expired-session redirect all reply 200 with HTML. An unguarded
   * `JSON.parse` threw straight out of the `load` listener, leaving the promise
   * unsettled with the watchdog already cleared; and `xhr.abort()` on a request
   * already in DONE fires no `abort` event, so Cancel could not rescue it
   * either. The composer would spin forever.
   */
  it.each([
    ['HTML from a proxy or captive portal', '<html>Sign in to continue</html>'],
    ['an empty body', ''],
    ['valid JSON of the wrong shape', '{"ok":true}'],
  ])('settles on a 2xx carrying %s', async (_label, body) => {
    const { result } = await startUpload();
    const xhr = FakeXhr.latest;

    xhr.status = 200;
    xhr.responseText = body;
    xhr.emitLoad();

    await expect(result).rejects.toThrow(UPLOAD_UNREADABLE_MESSAGE);

    // And nothing is left running that could settle it a second time.
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS * 3);
    expect(xhr.aborted).toBe(false);
  });

  it('stops watching once the upload succeeds', async () => {
    const { result } = await startUpload();
    const xhr = FakeXhr.latest;

    xhr.succeedWith([{ originalName: 'notes.txt', savedPath: '/test/project/notes.txt' }]);
    await expect(result).resolves.toHaveLength(1);

    // A watchdog left running would abort a request that already finished.
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS * 2);
    expect(xhr.aborted).toBe(false);
  });
});

describe('uploadFiles can always be cancelled', () => {
  it('aborts the request when the signal aborts', async () => {
    const controller = new AbortController();
    const { result } = await startUpload(controller.signal);
    const xhr = FakeXhr.latest;

    controller.abort();

    expect(xhr.aborted).toBe(true);
    await expect(result).rejects.toThrow(UPLOAD_CANCELED_MESSAGE);
  });

  it('never sends when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const methods = createSystemMethods('http://localhost:4242/api');
    await expect(
      methods.uploadFiles([file], '/test/project', undefined, controller.signal)
    ).rejects.toThrow(UPLOAD_CANCELED_MESSAGE);

    // Not merely unsent: the signal is checked before the files are even read,
    // so no request is built and nothing is copied into memory.
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('lands a cancel raised while the files are still being read', async () => {
    // The window before `send()`: no request exists yet, so neither the
    // watchdog nor `xhr.abort()` covers it — only the signal check does.
    const controller = new AbortController();
    const slowFile = {
      name: 'huge.bin',
      type: 'application/octet-stream',
      size: 999,
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          controller.abort();
          resolve(new ArrayBuffer(8));
        }),
    } as UploadFile;

    const methods = createSystemMethods('http://localhost:4242/api');
    await expect(
      methods.uploadFiles([slowFile, file], '/test/project', undefined, controller.signal)
    ).rejects.toThrow(UPLOAD_CANCELED_MESSAGE);

    // The request was never made at all — the bytes never left.
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('reports a cancel as a cancel, not as a stall', async () => {
    const controller = new AbortController();
    const { result } = await startUpload(controller.signal);

    // Cancelled with the deadline in sight — the wording must follow the cause.
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS - 1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_TIMEOUT_MS);

    await expect(result).rejects.toThrow(UPLOAD_CANCELED_MESSAGE);
  });
});

/**
 * A room's upload rides the same request machinery and lands somewhere else.
 *
 * The watchdog, the progress channel and the cancel are shared code, proven
 * above; what these assert is the only thing that differs — where the bytes go,
 * and what shape is read back out.
 */
describe('uploadRoomAttachments goes to the room, not to a working directory', () => {
  /** Start a room upload and wait until the request has actually been sent. */
  async function startRoomUpload(signal?: AbortSignal) {
    const rooms = createRoomMethods('http://localhost:4242/api');
    const onProgress = vi.fn();
    const result = rooms.uploadRoomAttachments('room 1', [file], onProgress, signal);
    void result.catch(() => {});
    for (let i = 0; i < 10 && FakeXhr.instances.length === 0; i += 1) await Promise.resolve();
    expect(FakeXhr.instances).toHaveLength(1);
    return { result, onProgress };
  }

  /** One stored attachment, as the route answers it. */
  const attachment = {
    id: '01J000000000000000000000',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 5,
    preview: null,
    url: '/api/rooms/room%201/attachments/01J000000000000000000000',
  };

  it('posts to the room, with the id encoded and NO cwd anywhere', async () => {
    await startRoomUpload();

    // A room has no working directory. A `cwd` here would mean the room upload
    // was quietly re-derived from chat's endpoint rather than given its own.
    expect(FakeXhr.latest.url).toBe('http://localhost:4242/api/rooms/room%201/attachments');
    expect(FakeXhr.latest.url).not.toContain('cwd');
  });

  it("leaves chat's own URL byte-identical", async () => {
    // The regression this refactor risks: chat's endpoint is the thing the
    // generalization moved through, and nothing about it may have shifted.
    await startUpload();

    expect(FakeXhr.latest.url).toBe('http://localhost:4242/api/uploads?cwd=%2Ftest%2Fproject');
  });

  it('reports progress and resolves with the attachments the route answered', async () => {
    const { result, onProgress } = await startRoomUpload();
    const xhr = FakeXhr.latest;

    xhr.emitUploadProgress(50, 100);
    expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: 100, percentage: 50 });

    xhr.status = 200;
    xhr.responseText = JSON.stringify({ attachments: [attachment] });
    xhr.emitLoad();

    await expect(result).resolves.toEqual([attachment]);
  });

  it('refuses a 2xx that is not the room upload response', async () => {
    // `{ uploads: [...] }` is chat's shape and valid JSON. Resolving on it
    // would hand the composer a list of the wrong things.
    const { result } = await startRoomUpload();
    const xhr = FakeXhr.latest;

    xhr.status = 200;
    xhr.responseText = JSON.stringify({ uploads: [] });
    xhr.emitLoad();

    await expect(result).rejects.toThrow(UPLOAD_UNREADABLE_MESSAGE);
  });

  it('aborts the request when the signal aborts', async () => {
    const controller = new AbortController();
    const { result } = await startRoomUpload(controller.signal);
    const xhr = FakeXhr.latest;

    controller.abort();

    expect(xhr.aborted).toBe(true);
    await expect(result).rejects.toThrow(UPLOAD_CANCELED_MESSAGE);
  });
});
