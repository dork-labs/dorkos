/**
 * The computer's side of the session relay connection (B2, DOR-2945): when
 * DorkOS Cloud's command stream says a viewer is open (`viewer_open`), dial
 * the hub this computer pinned, prove both ends ({@link finishComputerHandshake}),
 * then pass each request to the relay's request server and send its answers
 * back, sealed.
 *
 * Rules it keeps:
 * - It dials only the pinned origin, as `wss://`, with the pinned relay secret.
 *   The command carries no address and nothing here reads one from it.
 * - It dials only while an owner account exists (ADR 261015-042933 rule 5,
 *   `exposure-guard.ts`): a relay to a computer nobody can sign in to is off.
 * - At most one connection at a time; a second `viewer_open` while connected
 *   or dialing joins it.
 * - Nothing is served before the hub has proved itself and the `finish` has
 *   gone out. Any frame that fails to open, parse or verify ends the
 *   connection.
 * - It closes {@link SESSION_RELAY_IDLE_CLOSE_MS} after the hub last reported
 *   no viewers (or after the handshake, until the first report), so a hub can
 *   sleep. The next `viewer_open` dials again.
 *
 * The socket is injected ({@link RelayDialerDeps.connect}), so tests drive a
 * real hub end without a network.
 *
 * @module services/core/session-relay/relay-dialer
 */
import type { KeyObject } from 'node:crypto';
import type { RemoteCommandOutcome } from '@dork-labs/cloud-api';
import {
  RelaySealedFrameSchema,
  RelayWebFrameSchema,
  SESSION_RELAY_FEATURES,
  SESSION_RELAY_IDLE_CLOSE_MS,
  decodeRelayFrame,
  encodeRelayFrame,
  type RelayComputerFrame,
  type RelayDevice,
  type RelayError,
  type RelayWebFrame,
} from '@dorkos/shared/session-relay';
import { logger } from '../../../lib/logger.js';
import {
  finishComputerHandshake,
  startComputerHandshake,
  type ComputerHandshake,
  type RelayChannel,
} from './channel.js';
import type { RelayPin } from './pin-store.js';
import type { RelayLinkState } from './relay-presence.js';
import { RELAY_BACKLOGGED, RELAY_FRAME_TOO_LARGE } from './relay-errors.js';

/** How long the hub has to answer `hello` before the dial is dropped. */
export const RELAY_HANDSHAKE_TIMEOUT_MS = 15_000;

/** The path a hub serves computer relay connections on. */
export const RELAY_COMPUTER_PATH = '/api/relay/computer';

/**
 * How long the computer waits for any frame from the hub before it treats the
 * connection as dead. The hub sends a heartbeat at least every 30 seconds, so
 * this is three missed beats: a half-open connection (a sleeping laptop, a NAT
 * that dropped it) is noticed and the next `viewer_open` dials afresh.
 */
export const RELAY_SILENCE_TIMEOUT_MS = 90_000;

/**
 * The most a stream may leave waiting in the socket's send buffer. Past it the
 * hub is not reading fast enough, and the stream ends rather than grow it.
 */
export const RELAY_SEND_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

/** After a dial fails, how long `viewer_open` is ignored before dialing again. */
export const RELAY_REDIAL_BACKOFF_MS = 15_000;

/** The few things the dialer needs from a WebSocket, so tests can stand in for one. */
export interface RelaySocket {
  send(text: string): void;
  /** Bytes queued but not yet written to the network (`ws` keeps this). */
  readonly bufferedAmount: number;
  close(code?: number, reason?: string): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown, isBinary?: boolean) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

/** What answers the requests a relay connection carries (the relayed caller's adapter). */
export interface RelayRequestServer {
  /** The features this computer serves, advertised in `hello`. */
  features(): readonly string[];
  /**
   * Handle one inner frame from the hub: a request, or closing a stream.
   *
   * @param frame - The frame, already opened and parsed.
   * @param emit - Send a frame back to the hub over this connection.
   */
  handle(frame: RelayWebFrame, emit: (frame: RelayComputerFrame) => void): void;
  /** The connection ended: stop every stream it opened. */
  closeAll(): void;
  /**
   * Stop one stream from this side, telling the hub why with one `stream.end`.
   * Returns `false` when no such stream is open, so the caller sends the end.
   *
   * @param streamId - The stream to stop.
   * @param error - What to tell the hub.
   */
  endStream(streamId: string, error: RelayError): boolean;
}

/** What the dialer reads and calls. */
export interface RelayDialerDeps {
  /** The pin, or `null` when the relay is off. */
  readPin: () => RelayPin | null;
  /** Whether an owner account exists. */
  ownerExists: () => boolean;
  /** This computer's long-lived signing key. May throw; a throw means no dial. */
  computerKey: () => KeyObject;
  /** This build's DorkOS version. */
  appVersion: string;
  /** Answers relayed requests. */
  server: RelayRequestServer;
  /** Open a WebSocket to `url` with these headers. */
  connect: (url: string, headers: Record<string, string>) => RelaySocket;
  /** The clock; injectable for tests. */
  now?: () => number;
  /** Told each time the connection opens or ends, or the hub's viewer count changes. */
  onLinkState?: (state: RelayLinkState) => void;
  /** Told the device each request names, before the request is served. */
  onDevice?: (device: RelayDevice) => void;
}

type State =
  | { state: 'idle' }
  | { state: 'dialing'; socket: RelaySocket }
  | { state: 'open'; socket: RelaySocket; channel: RelayChannel };

/** One computer's relay connection to its hub. */
export class RelayDialer {
  private current: State = { state: 'idle' };
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** No dial before this time, after a failure. */
  private redialAfter = 0;
  /** Chats of this computer open on the hub, as it last reported; 0 when not connected. */
  private viewerCount = 0;

  /**
   * Hold the dialer's dependencies.
   *
   * @param deps - See {@link RelayDialerDeps}.
   */
  constructor(private readonly deps: RelayDialerDeps) {}

  /**
   * Act on a `viewer_open` command: dial the pinned hub unless already
   * connected. Never throws; the answer is the command's outcome.
   *
   * @param expiresAt - The command's `expiresAt`; past it, the command is ignored.
   */
  onViewerOpen(expiresAt: string): RemoteCommandOutcome {
    // Fails closed: an expiry that does not parse is treated as passed.
    if (!(Date.parse(expiresAt) > this.now())) return 'ignored';
    return this.dialNow();
  }

  /**
   * Dial the pinned hub now unless already connected or dialing: what a
   * `viewer_open` does once its expiry is checked, and what a cloud agent
   * computer does at boot and after it links (DOR-2940). Every other check
   * {@link onViewerOpen} makes is made here. Never throws.
   */
  dialNow(): RemoteCommandOutcome {
    return this.tryDial(null);
  }

  /**
   * Dial the pinned hub at another origin, without changing the pin: for a
   * cloud agent computer whose hub moved (DOR-2940). The handshake there must
   * be signed by the pinned key, as every handshake is; only once it is does
   * `onProved` run, so the caller saves the new origin then and not before. A
   * hub at the new origin that signs with another key is refused like any
   * other, and the pin keeps the old origin. Never throws.
   *
   * @param hubOrigin - The origin to try, already checked as a public https one.
   * @param onProved - Called once, when the hub there has proved the pinned key.
   */
  dialAt(hubOrigin: string, onProved: () => void): RemoteCommandOutcome {
    return this.tryDial({ hubOrigin, onProved });
  }

  private tryDial(moved: { hubOrigin: string; onProved: () => void } | null): RemoteCommandOutcome {
    const pinned = this.deps.readPin();
    if (!pinned) return 'ignored';
    if (!this.deps.ownerExists()) return 'refused:no-owner';
    if (this.current.state !== 'idle') return 'applied';
    if (this.now() < this.redialAfter) return 'ignored';
    const pin = moved ? { ...pinned, hubOrigin: moved.hubOrigin } : pinned;
    try {
      // Read before dialing, so a key that cannot be read is a failed command
      // rather than a throw inside a socket listener.
      const computerKey = this.deps.computerKey();
      this.dial(pin, computerKey, moved?.onProved ?? null);
      return 'applied';
    } catch (error) {
      logger.warn('[SessionRelay] Could not dial the hub', { error: (error as Error).name });
      this.failed();
      return 'failed';
    }
  }

  /** Whether a connection is open and proved. */
  get connected(): boolean {
    return this.current.state === 'open';
  }

  /** Chats of this computer open on the hub, as it last reported; 0 when not connected. */
  get viewers(): number {
    return this.viewerCount;
  }

  /** End the connection, if any. Called at shutdown and when the pin is removed. */
  close(): void {
    if (this.current.state !== 'idle') this.current.socket.close(1000, 'closing');
    this.reset();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private dial(pin: RelayPin, computerKey: KeyObject, onProved: (() => void) | null): void {
    const features = this.deps.server
      .features()
      .filter((feature) => (SESSION_RELAY_FEATURES as readonly string[]).includes(feature));
    const handshake = startComputerHandshake(pin.computerId, features, this.deps.appVersion);
    const url = `${pin.hubOrigin.replace(/^https:/, 'wss:')}${RELAY_COMPUTER_PATH}`;
    const socket = this.deps.connect(url, { Authorization: `Bearer ${pin.relaySecret}` });
    this.current = { state: 'dialing', socket };

    // A throw inside a socket listener would escape into the process, so
    // every listener body is guarded: anything unexpected drops this socket.
    const guarded =
      <A extends unknown[]>(body: (...args: A) => void) =>
      (...args: A): void => {
        try {
          body(...args);
        } catch (error) {
          logger.warn('[SessionRelay] The relay connection hit an error', {
            error: (error as Error).name,
          });
          this.drop(socket);
        }
      };
    socket.on(
      'open',
      guarded(() => socket.send(handshake.helloText))
    );
    socket.on(
      'message',
      guarded((data: unknown, isBinary?: boolean) =>
        this.receive(socket, pin, handshake, computerKey, data, isBinary === true, onProved)
      )
    );
    socket.on(
      'close',
      guarded(() => this.ended(socket))
    );
    socket.on(
      'error',
      guarded((error: Error) => {
        logger.warn('[SessionRelay] The relay connection failed', { error: error.name });
        this.drop(socket);
      })
    );
    this.handshakeTimer = unref(
      setTimeout(() => {
        if (this.current.state === 'dialing' && this.current.socket === socket) {
          logger.warn('[SessionRelay] The hub did not answer in time');
          this.drop(socket);
        }
      }, RELAY_HANDSHAKE_TIMEOUT_MS)
    );
  }

  private receive(
    socket: RelaySocket,
    pin: RelayPin,
    handshake: ComputerHandshake,
    computerKey: KeyObject,
    data: unknown,
    isBinary: boolean,
    onProved: (() => void) | null
  ): void {
    const current = this.current;
    if (current.state === 'idle' || current.socket !== socket) return;
    // The protocol is text frames only; a binary frame ends the connection.
    if (isBinary) {
      this.drop(socket);
      return;
    }
    const text =
      typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';

    if (current.state === 'dialing') {
      const finished = finishComputerHandshake(handshake, text, {
        hubOrigin: pin.hubOrigin,
        hubKey: pin.hubKey,
        computerKey,
      });
      if (!finished.ok) {
        // A refusal the pinned hub signed is the one case worth naming.
        if (finished.reason === 'refused') {
          logger.warn('[SessionRelay] The hub needs a newer relay version than this computer has');
        } else {
          logger.warn('[SessionRelay] The hub could not be verified; the relay stays closed');
        }
        this.failed();
        this.drop(socket);
        return;
      }
      this.clearHandshakeTimer();
      socket.send(encodeRelayFrame(finished.finish)!);
      this.current = { state: 'open', socket, channel: finished.channel };
      this.redialAfter = 0;
      this.startIdleTimer();
      this.heardFromHub(socket);
      logger.info('[SessionRelay] Connected to this computer’s own DorkOS in the cloud');
      this.reportLinkState();
      if (onProved) {
        try {
          onProved();
        } catch (error) {
          logger.warn('[SessionRelay] Could not record the hub`s new address', {
            error: (error as Error).name,
          });
        }
      }
      return;
    }

    const sealed = decodeRelayFrame(text, RelaySealedFrameSchema);
    const inner = sealed ? current.channel.open(sealed) : null;
    const frame = inner === null ? null : decodeRelayFrame(inner, RelayWebFrameSchema);
    if (!frame) {
      logger.warn('[SessionRelay] A frame from the hub failed to open; closing the relay');
      this.drop(socket);
      return;
    }
    this.heardFromHub(socket);
    // A backstop for "removing the pin turns the relay off": recheck the pin
    // (none while paused or switched off) and the owner on every frame, not
    // only at the dial, so no request is served once either is gone.
    if (!this.deps.readPin() || !this.deps.ownerExists()) {
      this.close();
      return;
    }
    switch (frame.type) {
      case 'viewers':
        if (frame.count === 0) this.startIdleTimer();
        else this.clearIdleTimer();
        if (frame.count !== this.viewerCount) {
          this.viewerCount = frame.count;
          this.reportLinkState();
        }
        return;
      case 'heartbeat':
        this.emit(socket, { type: 'heartbeat' });
        return;
      default:
        if (frame.type === 'request' && frame.device) {
          const device = frame.device;
          this.tell(() => this.deps.onDevice?.(device));
        }
        this.deps.server.handle(frame, (out) => this.emit(socket, out));
    }
  }

  /** Seal and send one frame, if this socket is still the open one. */
  private emit(socket: RelaySocket, frame: RelayComputerFrame): void {
    const current = this.current;
    if (current.state !== 'open' || current.socket !== socket) return;
    // A hub that stops reading must not grow this side's send buffer without
    // bound: past the ceiling a stream ends, and the page reopens it from its
    // cursor once the link drains.
    if (frame.type === 'stream.frame' && socket.bufferedAmount > RELAY_SEND_BUFFER_MAX_BYTES) {
      this.endStream(socket, frame.streamId, RELAY_BACKLOGGED);
      return;
    }
    const text = encodeRelayFrame(frame);
    const sealed = text === null ? null : current.channel.seal(text);
    if (!sealed) {
      // Too large to send. A request answer becomes an error the hub can show;
      // a stream frame is dropped and the stream ended.
      if (frame.type === 'result') {
        this.emit(socket, {
          type: 'error',
          id: frame.id,
          ok: false,
          error: { status: 500, code: 'internal', message: 'The answer was too large to relay.' },
        });
      } else if (frame.type === 'stream.frame') {
        this.endStream(socket, frame.streamId, RELAY_FRAME_TOO_LARGE);
      }
      return;
    }
    socket.send(encodeRelayFrame(sealed)!);
  }

  /** End one stream on both sides: the server stops it and tells the hub once. */
  private endStream(socket: RelaySocket, streamId: string, error: RelayError): void {
    if (!this.deps.server.endStream(streamId, error)) {
      this.emit(socket, { type: 'stream.end', streamId, error });
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = unref(
      setTimeout(() => {
        logger.info('[SessionRelay] No viewers left; closing the relay so the hub can sleep');
        this.close();
      }, SESSION_RELAY_IDLE_CLOSE_MS)
    );
  }

  /** Any frame from the hub restarts the silence watchdog. */
  private heardFromHub(socket: RelaySocket): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = unref(
      setTimeout(() => {
        if (this.current.state === 'idle' || this.current.socket !== socket) return;
        logger.warn('[SessionRelay] The hub went silent; closing the relay');
        this.drop(socket);
      }, RELAY_SILENCE_TIMEOUT_MS)
    );
  }

  /** A dial failed: wait a little before the next one. */
  private failed(): void {
    this.redialAfter = this.now() + RELAY_REDIAL_BACKOFF_MS;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  /** Close this socket and forget it. */
  private drop(socket: RelaySocket): void {
    socket.close(1008, 'relay closed');
    this.ended(socket);
  }

  /** The socket closed: forget it if it was ours, and stop its streams. */
  private ended(socket: RelaySocket): void {
    if (this.current.state === 'idle' || this.current.socket !== socket) return;
    this.reset();
  }

  private reset(): void {
    const wasOpen = this.current.state === 'open';
    this.current = { state: 'idle' };
    this.clearIdleTimer();
    this.clearHandshakeTimer();
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.viewerCount = 0;
    if (wasOpen) {
      this.deps.server.closeAll();
      this.reportLinkState();
    }
  }

  /** Tell the presence tracker where the connection stands. */
  private reportLinkState(): void {
    this.tell(() =>
      this.deps.onLinkState?.({ connected: this.connected, viewers: this.viewerCount })
    );
  }

  /** Run a listener's callback; its throw is logged, never the connection's end. */
  private tell(body: () => void): void {
    try {
      body();
    } catch (error) {
      logger.warn('[SessionRelay] A relay listener failed', { error: (error as Error).name });
    }
  }
}

/** Let a timer never hold the process open on its own. */
function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}
