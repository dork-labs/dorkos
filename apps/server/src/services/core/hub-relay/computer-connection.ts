/**
 * The hub's end of one computer's session relay connection (B1, DOR-2944): the
 * mirror of the computer's `relay-dialer.ts`.
 *
 * 1. The computer opens with `hello`. The hub answers with a signed `welcome`
 *    ({@link answerHello}), or a signed `refuse` and a hang-up when the two
 *    share no protocol version.
 * 2. The computer's first sealed frame must be a `finish` signed by the key
 *    this hub pinned for it ({@link PendingHubChannel.acceptFinish}). Nothing
 *    is sent or served before it verifies.
 * 3. From then on every frame is sealed. The hub sends a heartbeat every
 *    {@link HUB_RELAY_HEARTBEAT_MS} (the computer hangs up after 90 seconds of
 *    silence) and the number of web viewers, and closes on 90 seconds of the
 *    computer's own silence, on any frame that does not open or parse, and on
 *    a binary frame.
 *
 * What part 2b (the relayed chat view) uses: {@link HubComputerConnection.request},
 * {@link HubComputerConnection.openStream}, {@link HubComputerConnection.setViewers}
 * and `connected`. Every pending request and open stream ends cleanly, with a
 * {@link RelayError}, when the connection does.
 *
 * Nothing here makes anyone a person or a signed-in user: the connection grants
 * no session, cookie or principal.
 *
 * @module services/core/hub-relay/computer-connection
 */
import {
  RelayComputerFrameSchema,
  RelayHelloFrameSchema,
  RelaySealedFrameSchema,
  SESSION_RELAY_DEVICE_FEATURE,
  SESSION_RELAY_MAX_INFLIGHT_REQUESTS,
  SESSION_RELAY_MAX_OPEN_STREAMS,
  SESSION_RELAY_VERSIONS,
  decodeRelayFrame,
  encodeRelayFrame,
  missingRelayFeature,
  parseRelayResult,
  type RelayComputerFrame,
  type RelayDevice,
  type RelayError,
  type RelayRequest,
  type RelayResultBody,
  type RelayResultOp,
  type RelayVersionRange,
  type RelayWebFrame,
} from '@dorkos/shared/session-relay';
import { logger } from '../../../lib/logger.js';
import {
  answerHello,
  type PendingHubChannel,
  type RelayChannel,
} from '../session-relay/channel.js';
import type { LinkedComputer } from './computer-store.js';

/** How long a computer has to send `hello`, then `finish`, before the dial is dropped. */
export const HUB_RELAY_HANDSHAKE_TIMEOUT_MS = 15_000;

/** How often the hub sends a heartbeat; the computer hangs up after three missed. */
export const HUB_RELAY_HEARTBEAT_MS = 30_000;

/** How long the hub waits for any frame from the computer before hanging up. */
export const HUB_RELAY_SILENCE_TIMEOUT_MS = 90_000;

/** How long one request waits for its answer. */
export const HUB_RELAY_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The hub's long-lived signing key and its origin, injected so this module
 * never reads a key itself. The key signs relay transcripts and nothing else.
 */
export interface HubRelaySigner {
  /** Sign bytes with the hub's Ed25519 key. */
  sign(data: Uint8Array): Buffer | Uint8Array;
  /** The hub's origin as computers pin it (`https://…`, no path). */
  origin: string;
}

/** The few things the connection needs from a server-side WebSocket. */
export interface HubRelaySocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown, isBinary?: boolean) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

/** The computer is not connected, or the connection ended before an answer. */
export const RELAY_COMPUTER_OFFLINE: RelayError = {
  status: 503,
  code: 'internal',
  message: 'This computer is not connected right now.',
};

/** The computer did not answer in time. */
export const RELAY_TIMED_OUT: RelayError = {
  status: 504,
  code: 'internal',
  message: 'This computer did not answer in time.',
};

/** Too many requests or streams already open on this connection. */
export const RELAY_HUB_BUSY: RelayError = {
  status: 429,
  code: 'rate_limited',
  message: 'Too many requests at once. Try again in a moment.',
};

/** The request was too large to relay. */
export const RELAY_REQUEST_TOO_LARGE: RelayError = {
  status: 413,
  code: 'invalid',
  message: 'That request is too large to relay.',
};

/** The computer's answer did not match what was asked. */
export const RELAY_BAD_ANSWER: RelayError = {
  status: 502,
  code: 'internal',
  message: 'This computer sent an answer that could not be read.',
};

/** A request answered by one `result`: every request but opening a stream. */
export type RelayCallRequest = Exclude<RelayRequest, { op: 'session.stream' }>;

/** A request's outcome: the checked answer body, or why there is none. */
export type RelayCallResult<Op extends RelayResultOp = RelayResultOp> =
  { ok: true; body: RelayResultBody<Op> } | { ok: false; error: RelayError };

/** One frame of a durable session stream, as the computer relays it. */
export type RelayStreamFrame = Extract<RelayComputerFrame, { type: 'stream.frame' }>['frame'];

/** What a connection is told and given. */
export interface HubComputerConnectionOptions {
  /** The upgraded socket. */
  socket: HubRelaySocket;
  /** The linked computer the dial's secret belongs to. */
  computer: Pick<LinkedComputer, 'computerId' | 'computerKey'>;
  /** The hub's signing key and origin. */
  signer: HubRelaySigner;
  /** Called once, when the computer's `finish` verifies. */
  onOpen?: (connection: HubComputerConnection) => void;
  /** Called once, when the connection ends for any reason. */
  onClose?: (connection: HubComputerConnection) => void;
  /** Override for tests. */
  requestTimeoutMs?: number;
  /** Override for tests; defaults to this build's versions. */
  versions?: RelayVersionRange;
}

interface PendingRequest {
  op: RelayResultOp;
  resolve: (result: RelayCallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OpenStream {
  /** The id of the request that opened it, which an `error` refusing it names. */
  requestId: string;
  onFrame: (frame: RelayStreamFrame) => void;
  onEnd: (error?: RelayError) => void;
}

type State =
  | { state: 'hello' }
  | { state: 'finishing'; pending: PendingHubChannel }
  | { state: 'open'; channel: RelayChannel }
  | { state: 'closed' };

/** One computer's relay connection, as the hub holds it. */
export class HubComputerConnection {
  /** The computer this connection is for. */
  readonly computerId: string;
  private current: State = { state: 'hello' };
  private advertised: readonly string[] = [];
  private viewers = 0;
  private nextId = 0;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly streams = new Map<string, OpenStream>();
  /** Each open stream's opening request id, so a refusal by `error` can end it. */
  private readonly streamByRequest = new Map<string, string>();
  private handshakeTimer: ReturnType<typeof setTimeout> | null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Take over an upgraded socket and wait for the computer's `hello`.
   *
   * @param options - See {@link HubComputerConnectionOptions}.
   */
  constructor(private readonly options: HubComputerConnectionOptions) {
    this.computerId = options.computer.computerId;
    const { socket } = options;
    socket.on(
      'message',
      this.guarded((data: unknown, isBinary?: boolean) => this.receive(data, isBinary === true))
    );
    socket.on(
      'close',
      this.guarded(() => this.ended())
    );
    socket.on(
      'error',
      this.guarded((error: Error) => {
        logger.warn('[HubRelay] A computer connection failed', { error: error.name });
        this.close(1011);
      })
    );
    this.handshakeTimer = unref(
      setTimeout(() => {
        if (this.current.state === 'hello' || this.current.state === 'finishing') {
          logger.warn('[HubRelay] A computer did not finish the handshake in time');
          this.close(1008);
        }
      }, HUB_RELAY_HANDSHAKE_TIMEOUT_MS)
    );
  }

  /** Whether the computer has proved itself and the connection is open. */
  get connected(): boolean {
    return this.current.state === 'open';
  }

  /** The features the computer advertised in `hello`. A hint, never a permission. */
  get features(): readonly string[] {
    return this.advertised;
  }

  /**
   * Send one request answered by one `result`, and wait for its checked
   * answer. Never rejects: every failure is a `{ ok: false, error }`.
   *
   * @param request - The request; opening a stream goes through {@link openStream}.
   * @param device - The browser that asked; sent only to a computer that reads it.
   */
  request<R extends RelayCallRequest>(
    request: R,
    device?: RelayDevice
  ): Promise<RelayCallResult<R['op']>> {
    const refused = this.refusal(
      request,
      this.requests.size >= SESSION_RELAY_MAX_INFLIGHT_REQUESTS
    );
    if (refused) return Promise.resolve({ ok: false, error: refused });
    const id = this.mintId('r');
    if (!this.sendInner(this.requestFrame(id, request, device))) {
      return Promise.resolve({ ok: false, error: RELAY_REQUEST_TOO_LARGE });
    }
    return new Promise((resolve) => {
      const timer = unref(
        setTimeout(() => {
          if (this.requests.delete(id)) resolve({ ok: false, error: RELAY_TIMED_OUT });
        }, this.options.requestTimeoutMs ?? HUB_RELAY_REQUEST_TIMEOUT_MS)
      );
      this.requests.set(id, {
        op: request.op,
        resolve: resolve as (result: RelayCallResult) => void,
        timer,
      });
    });
  }

  /**
   * Open a chat's durable stream. `onFrame` gets each frame; `onEnd` is called
   * exactly once when the computer ends the stream or the connection ends,
   * with the reason when it is a refusal. Not called after the returned close.
   *
   * @param sessionId - The chat to stream.
   * @param resume - The whole id of the last frame the viewer saw, if any.
   * @param onFrame - Each frame, in order.
   * @param onEnd - The stream ended; `error` says why when it was refused.
   * @param device - The browser that asked; sent only to a computer that reads it.
   * @returns Close the stream from this side.
   */
  openStream(
    sessionId: string,
    resume: string | undefined,
    onFrame: (frame: RelayStreamFrame) => void,
    onEnd: (error?: RelayError) => void,
    device?: RelayDevice
  ): () => void {
    const streamId = this.mintId('s');
    const request: RelayRequest = {
      op: 'session.stream',
      streamId,
      sessionId,
      ...(resume !== undefined ? { resume } : {}),
    };
    const requestId = this.mintId('r');
    const refused =
      this.refusal(request, this.streams.size >= SESSION_RELAY_MAX_OPEN_STREAMS) ??
      (this.sendInner(this.requestFrame(requestId, request, device))
        ? null
        : RELAY_REQUEST_TOO_LARGE);
    if (refused) {
      queueMicrotask(() => onEnd(refused));
      return () => undefined;
    }
    this.streams.set(streamId, { requestId, onFrame, onEnd });
    this.streamByRequest.set(requestId, streamId);
    return () => {
      if (this.forgetStream(streamId)) this.sendInner({ type: 'stream.close', streamId });
    };
  }

  /**
   * Tell the computer how many web viewers it has. At 0 it closes the relay a
   * few minutes later, so the hub can sleep.
   *
   * @param count - Viewers with one of this computer's chats open.
   */
  setViewers(count: number): void {
    this.viewers = Math.max(0, Math.min(10_000, Math.floor(count) || 0));
    this.sendInner({ type: 'viewers', count: this.viewers });
  }

  /**
   * End the connection. Every pending request and open stream ends with
   * {@link RELAY_COMPUTER_OFFLINE}.
   *
   * @param code - The WebSocket close code.
   */
  close(code = 1000): void {
    if (this.current.state === 'closed') return;
    try {
      this.options.socket.close(code, 'relay closed');
    } catch {
      // The socket is gone either way; what matters is the cleanup below.
    }
    this.ended();
  }

  /** Why a request cannot go out now, or `null` when it can. */
  private refusal(request: RelayRequest, atCap: boolean): RelayError | null {
    if (this.current.state !== 'open') return RELAY_COMPUTER_OFFLINE;
    const feature = missingRelayFeature(this.advertised, request);
    if (feature) {
      return {
        status: 501,
        code: 'needs_update',
        feature,
        message: 'This computer needs an update for that.',
      };
    }
    return atCap ? RELAY_HUB_BUSY : null;
  }

  /**
   * A request frame, naming the browser only to a computer that advertised
   * `request.device`: every frame is strict, so an older computer would refuse
   * the field rather than ignore it.
   */
  private requestFrame(id: string, request: RelayRequest, device?: RelayDevice): RelayWebFrame {
    return device && this.advertised.includes(SESSION_RELAY_DEVICE_FEATURE)
      ? { type: 'request', id, request, device }
      : { type: 'request', id, request };
  }

  private mintId(prefix: string): string {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }

  /** Seal and send one inner frame. `false` when it could not go out. */
  private sendInner(frame: RelayWebFrame): boolean {
    if (this.current.state !== 'open') return false;
    const text = encodeRelayFrame(frame);
    const sealed = text === null ? null : this.current.channel.seal(text);
    if (!sealed) return false;
    this.options.socket.send(encodeRelayFrame(sealed)!);
    return true;
  }

  private receive(data: unknown, isBinary: boolean): void {
    if (this.current.state === 'closed') return;
    // The protocol is text frames only.
    if (isBinary) {
      this.close(1003);
      return;
    }
    const text =
      typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
    switch (this.current.state) {
      case 'hello':
        return this.answer(text);
      case 'finishing':
        return this.finish(this.current.pending, text);
      case 'open':
        return this.serve(this.current.channel, text);
    }
  }

  private answer(helloText: string): void {
    const { signer, computer, versions } = this.options;
    const answered = answerHello(
      helloText,
      computer.computerId,
      { sign: (data) => Buffer.from(signer.sign(data)), origin: signer.origin },
      versions ?? SESSION_RELAY_VERSIONS
    );
    if (!answered.ok) {
      logger.warn('[HubRelay] A computer sent a hello that could not be answered');
      this.close(1008);
      return;
    }
    this.options.socket.send(encodeRelayFrame(answered.answer)!);
    if (!answered.pending) {
      logger.warn('[HubRelay] A computer speaks no relay version this hub does');
      this.close(1000);
      return;
    }
    // `answerHello` parsed this same text already; read the features from it.
    this.advertised = decodeRelayFrame(helloText, RelayHelloFrameSchema)?.features ?? [];
    this.current = { state: 'finishing', pending: answered.pending };
  }

  private finish(pending: PendingHubChannel, text: string): void {
    const sealed = decodeRelayFrame(text, RelaySealedFrameSchema);
    const channel = sealed ? pending.acceptFinish(sealed, this.options.computer.computerKey) : null;
    if (!channel) {
      logger.warn('[HubRelay] A computer could not prove itself; closing');
      this.close(1008);
      return;
    }
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.current = { state: 'open', channel };
    this.heardFromComputer();
    this.heartbeatTimer = unref(
      setInterval(() => this.sendInner({ type: 'heartbeat' }), HUB_RELAY_HEARTBEAT_MS)
    );
    this.sendInner({ type: 'viewers', count: this.viewers });
    logger.info('[HubRelay] A linked computer connected');
    this.options.onOpen?.(this);
  }

  private serve(channel: RelayChannel, text: string): void {
    const sealed = decodeRelayFrame(text, RelaySealedFrameSchema);
    const inner = sealed ? channel.open(sealed) : null;
    const frame = inner === null ? null : decodeRelayFrame(inner, RelayComputerFrameSchema);
    if (!frame) {
      logger.warn('[HubRelay] A frame from a computer failed to open; closing');
      this.close(1008);
      return;
    }
    this.heardFromComputer();
    switch (frame.type) {
      case 'heartbeat':
        // Liveness only. Never answered, or two ends would echo forever.
        return;
      case 'result':
      case 'error': {
        const pending = this.requests.get(frame.id);
        if (!pending) {
          // The computer refuses a stream it never opened (a bad or duplicate
          // id) with an `error` naming the opening request, not a `stream.end`.
          const streamId = frame.type === 'error' ? this.streamByRequest.get(frame.id) : undefined;
          const stream = streamId === undefined ? null : this.forgetStream(streamId);
          stream?.onEnd(frame.type === 'error' ? frame.error : undefined);
          return;
        }
        this.requests.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.type === 'error') {
          pending.resolve({ ok: false, error: frame.error });
          return;
        }
        const body = parseRelayResult(pending.op, frame.body);
        pending.resolve(
          body === null ? { ok: false, error: RELAY_BAD_ANSWER } : { ok: true, body }
        );
        return;
      }
      case 'stream.frame':
        this.streams.get(frame.streamId)?.onFrame(frame.frame);
        return;
      case 'stream.end': {
        this.forgetStream(frame.streamId)?.onEnd(frame.error);
        return;
      }
    }
  }

  /** Stop tracking a stream; returns it when it was open. */
  private forgetStream(streamId: string): OpenStream | null {
    const stream = this.streams.get(streamId);
    if (!stream) return null;
    this.streams.delete(streamId);
    this.streamByRequest.delete(stream.requestId);
    return stream;
  }

  /** Any frame from the computer restarts the silence watchdog. */
  private heardFromComputer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = unref(
      setTimeout(() => {
        logger.warn('[HubRelay] A computer went silent; closing');
        this.close(1001);
      }, HUB_RELAY_SILENCE_TIMEOUT_MS)
    );
  }

  /** The socket is gone: stop the timers and end everything that waited on it. */
  private ended(): void {
    if (this.current.state === 'closed') return;
    this.current = { state: 'closed' };
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.handshakeTimer = this.heartbeatTimer = this.silenceTimer = null;
    const requests = [...this.requests.values()];
    const streams = [...this.streams.values()];
    this.requests.clear();
    this.streams.clear();
    this.streamByRequest.clear();
    for (const pending of requests) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: RELAY_COMPUTER_OFFLINE });
    }
    for (const stream of streams) this.quietly(() => stream.onEnd(RELAY_COMPUTER_OFFLINE));
    this.quietly(() => this.options.onClose?.(this));
  }

  /** Run a caller's callback so that its throw cannot stop the cleanup. */
  private quietly(body: () => void): void {
    try {
      body();
    } catch (error) {
      logger.warn('[HubRelay] A relay callback threw', { error: (error as Error).name });
    }
  }

  /** Wrap a socket listener so that nothing it does can throw into `ws`. */
  private guarded<A extends unknown[]>(body: (...args: A) => void): (...args: A) => void {
    return (...args: A): void => {
      try {
        body(...args);
      } catch (error) {
        logger.warn('[HubRelay] A computer connection hit an error', {
          error: (error as Error).name,
        });
        this.close(1011);
      }
    };
  }
}

/** Let a timer never hold the process open on its own. */
function unref<T extends ReturnType<typeof setTimeout>>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}
