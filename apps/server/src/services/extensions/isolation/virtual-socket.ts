/**
 * One end of a virtual HTTP connection between DorkOS and an isolated
 * extension's process (DOR-2686, spec §7).
 *
 * Nothing listens anywhere. The host's `http.request` writes into one of these
 * (`createConnection`), the child's `http.Server` reads from the twin
 * (`server.emit('connection', socket)`), and the bytes travel as `conn-*`
 * messages on the IPC channel the child already has. Real HTTP/1.1 on both
 * ends, so streaming responses and server-sent events work, and Windows
 * behaves like everywhere else (no named pipe, no port).
 *
 * Both sides use this same class, so it is bundled into the child and must
 * stay free of server-only imports.
 *
 * - A write is split into frames of at most {@link ISOLATION_LIMITS}
 *   `httpFrameBytes` (64 KB) and sent as `conn-data`.
 * - Ending the writable side sends `conn-end` (a half-close: the other side
 *   can still answer).
 * - Destroying it sends `conn-destroy`, unless the other side destroyed it
 *   first.
 * - **Flow control.** When this end's read buffer is full (whoever reads it
 *   is slower than the other side writes) it sends `conn-pause`, and
 *   `conn-resume` once it is read again; the other end holds back its write
 *   callbacks meanwhile, so an HTTP stack writing into it sees ordinary
 *   backpressure (`res.write()` returns `false`, `'drain'` waits). The other
 *   side is untrusted and may ignore the pause, so an end holding more than
 *   {@link ISOLATION_LIMITS} `httpBufferBytes` unread cuts the connection.
 *   Bytes that arrive while paused do not count as activity, so a stalled
 *   reader cannot be kept "busy" forever by a child that keeps sending.
 *
 * Both HTTP stacks treat their socket as a `net.Socket`, so the few socket
 * methods they call (`setTimeout`, `setNoDelay`, `setKeepAlive`, `ref`,
 * `unref`) are present and do nothing: timeouts are the router's own, never
 * the socket's.
 *
 * @module services/extensions/isolation/virtual-socket
 */
import { Duplex } from 'node:stream';
import { ISOLATION_LIMITS, type ConnMessage } from './ipc-protocol.js';

/** How a virtual socket reaches the other side. */
export interface VirtualSocketOptions {
  /** The connection id, shared by both ends. */
  cid: number;
  /**
   * Send one `conn-*` message to the other side. Returns `false` when it
   * could not. `onWritten`, when given, runs once the channel has written it.
   */
  send: (message: ConnMessage, onWritten?: () => void) => boolean;
  /**
   * Called on every frame written, and every frame received while this end
   * is not paused, so an idle timer can be reset.
   */
  onActivity?: () => void;
  /** Unread bytes this end holds before it cuts the connection (tests shorten it). */
  maxBufferedBytes?: number;
  /** Called once when this end is gone, for whatever reason. */
  onClose?: () => void;
}

/**
 * One end of a virtual connection.
 */
export class VirtualSocket extends Duplex {
  /** The connection id. */
  readonly cid: number;
  /** Never connecting: the "connection" exists the moment it is made. */
  readonly connecting = false;
  /** No address: nothing listens, and nothing here is on a network. */
  readonly remoteAddress: string | undefined = undefined;
  private remoteGone = false;
  /** This end asked the other to pause. */
  private pausedRemote = false;
  /** The other end asked this one to pause: the write callback waiting for `conn-resume`. */
  private heldWrite: (() => void) | null = null;
  private remotePaused = false;
  private readonly options: VirtualSocketOptions;

  /**
   * Make one end.
   *
   * @param options - See {@link VirtualSocketOptions}.
   */
  constructor(options: VirtualSocketOptions) {
    super({ allowHalfOpen: true });
    this.cid = options.cid;
    this.options = options;
    this.once('close', () => options.onClose?.());
  }

  /**
   * Bytes arrive with {@link VirtualSocket.receive}; a read only means the
   * reader has room again, so a paused peer may resume.
   */
  override _read(): void {
    if (!this.pausedRemote) return;
    this.pausedRemote = false;
    this.options.send({ type: 'conn-resume', cid: this.cid });
  }

  /**
   * Send a chunk as one or more frames.
   *
   * @param chunk - What the HTTP stack wrote.
   * @param _encoding - Unused (chunks are buffers).
   * @param callback - Called once the frames are handed to the channel.
   */
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const frame = ISOLATION_LIMITS.httpFrameBytes;
    // The write completes once its last frame is written to the channel (so
    // a fast writer is held to the channel's pace, not queued in memory) and
    // the other end has room: an end told to pause holds it until resume.
    const complete = (): void => {
      if (this.remotePaused) this.heldWrite = () => callback();
      else callback();
    };
    if (bytes.byteLength === 0) {
      complete();
      return;
    }
    for (let at = 0; at < bytes.byteLength; at += frame) {
      const end = Math.min(at + frame, bytes.byteLength);
      const piece = bytes.subarray(at, end);
      // A copy: the channel may serialize after the HTTP stack reuses its buffer.
      const message = { type: 'conn-data' as const, cid: this.cid, chunk: new Uint8Array(piece) };
      if (!this.options.send(message, end === bytes.byteLength ? complete : undefined)) {
        callback(new Error('The extension connection closed.'));
        return;
      }
    }
    this.options.onActivity?.();
  }

  /**
   * The HTTP stack finished writing: tell the other side.
   *
   * @param callback - Called once sent.
   */
  override _final(callback: (error?: Error | null) => void): void {
    this.options.send({ type: 'conn-end', cid: this.cid });
    callback();
  }

  /**
   * Tear down this end, telling the other side unless it went first.
   *
   * @param error - Why, if anything went wrong.
   * @param callback - Called once done.
   */
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.remoteGone) this.options.send({ type: 'conn-destroy', cid: this.cid });
    callback(error);
  }

  /**
   * Handle a `conn-*` message the other side sent for this connection.
   *
   * @param message - The message.
   */
  receive(message: ConnMessage): void {
    switch (message.type) {
      case 'conn-data': {
        if (this.destroyed) break;
        if (!this.pausedRemote) this.options.onActivity?.();
        const room = this.push(
          Buffer.from(message.chunk.buffer, message.chunk.byteOffset, message.chunk.byteLength)
        );
        const cap = this.options.maxBufferedBytes ?? ISOLATION_LIMITS.httpBufferBytes;
        if (this.readableLength > cap) {
          // It ignored the pause: cut the connection rather than hold more.
          this.destroy(new Error('The other side sent more than this connection can hold.'));
          break;
        }
        if (!room && !this.pausedRemote) {
          this.pausedRemote = true;
          this.options.send({ type: 'conn-pause', cid: this.cid });
        }
        break;
      }
      case 'conn-pause':
        this.remotePaused = true;
        break;
      case 'conn-resume': {
        this.remotePaused = false;
        const held = this.heldWrite;
        this.heldWrite = null;
        held?.();
        break;
      }
      case 'conn-end':
        this.push(null);
        break;
      case 'conn-destroy':
        this.remoteGone = true;
        this.destroy();
        break;
    }
  }

  /**
   * The other side is gone without a word (its process exited): drop this
   * end with `error`, sending nothing.
   *
   * @param error - What the HTTP stack on this side should see.
   */
  sever(error: Error): void {
    this.remoteGone = true;
    this.destroy(error);
  }

  /** A no-op: the router keeps its own idle timer. */
  setTimeout(_ms: number, _callback?: () => void): this {
    return this;
  }

  /** A no-op: there is no Nagle algorithm on an IPC channel. */
  setNoDelay(_noDelay?: boolean): this {
    return this;
  }

  /** A no-op: there is no TCP keep-alive on an IPC channel. */
  setKeepAlive(_enable?: boolean, _delay?: number): this {
    return this;
  }

  /** A no-op: the channel keeps the process alive, not the socket. */
  ref(): this {
    return this;
  }

  /** A no-op: the channel keeps the process alive, not the socket. */
  unref(): this {
    return this;
  }
}
