import type { CDPSession } from 'playwright-core';
import { parseBrowserBinding, type BrowserBinding } from '../contracts.js';
import { sameBinding } from '../input/binding.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MIME = new Map([
  ['text/plain', 'txt'],
  ['application/pdf', 'pdf'],
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
]);
/** Narrow fields read from the original CDP Fetch event; this type carries no permission. */
export interface OwnedResponseEvent {
  readonly requestId: string;
  readonly frameId: string;
  readonly resourceType: string;
  readonly request: Readonly<{ url: string }>;
  readonly responseStatusCode?: number;
  readonly responseErrorReason?: string;
  readonly responseHeaders?: readonly Readonly<{
    name: string;
    value: string;
  }>[];
}
/** Private completed artifact metadata contains neither native request IDs nor paths. */
export interface OwnedDownloadArtifact {
  readonly artifactId: string;
  readonly byteLength: number;
  readonly name: string;
  readonly mimeType: string;
}
/** Genuine host separately checks download, artifact and controller authority before each new effect. */
export interface OwnedDownloadSink {
  readonly binding: unknown;
  authorize(binding: BrowserBinding, signal: AbortSignal): Promise<void>;
  stage(
    name: string,
    mimeType: string,
    bytes: Uint8Array,
    signal: AbortSignal
  ): Promise<OwnedDownloadArtifact>;
}
/** One explicitly granted response in the exact original Page session; never a context-wide download allowance. */
export class OwnedResponseDownload {
  private readonly send: CDPSession['send'];
  private readonly on: CDPSession['on'];
  private readonly off: CDPSession['off'];
  private readonly authorize: OwnedDownloadSink['authorize'];
  private readonly stage: OwnedDownloadSink['stage'];
  private readonly binding: BrowserBinding;
  private readonly originals = new Set<Promise<unknown>>();
  private readonly selected: Promise<
    Readonly<{
      requestId: string;
      name: string;
      mimeType: string;
      expectedBytes?: number;
    }>
  >;
  private accept!: (
    value: Readonly<{
      requestId: string;
      name: string;
      mimeType: string;
      expectedBytes?: number;
    }>
  ) => void;
  private refuse!: (value: unknown) => void;
  private events = 0;
  private armed = false;
  private listening = false;
  private closed = false;
  private claimed = false;
  private root?: string;
  private requestId?: string;
  private stream?: string;
  private signal?: AbortSignal;
  private beginning?: Promise<void>;
  private completing?: Promise<void>;
  private closing?: Promise<void>;
  private first?: Readonly<{ value: unknown }>;
  private result?: OwnedDownloadArtifact;
  private readonly observe = (event: OwnedResponseEvent) => {
    // Closed admission cannot create new sends after the exact cleanup bank was reserved.
    // The original Fetch.disable cleanup owns remaining interceptions under unchanged browser deny.
    if (this.closed) return;
    if (++this.events > 64) {
      const refusal = new Error('DOWNLOAD_RESPONSE_CAPACITY_REFUSED');
      this.failure(refusal);
      this.refuse(refusal);
      return;
    }
    const task = this.own(async () => {
      if (this.closed) return;
      const requestId = event.requestId;
      if (typeof requestId !== 'string' || requestId.length > 256 || !requestId)
        throw new Error('DOWNLOAD_REQUEST_REFUSED');
      // This session enables only Response-stage interception. Request/auth/route owners retain their separate sessions.
      if (event.responseStatusCode === undefined && event.responseErrorReason === undefined)
        throw new Error('DOWNLOAD_RESPONSE_STAGE_REFUSED');
      if (
        !this.armed ||
        this.claimed ||
        event.frameId !== this.root ||
        event.resourceType !== 'Document'
      ) {
        await this.enter(() => this.send('Fetch.continueResponse', { requestId }));
        return;
      }
      const headers = event.responseHeaders;
      if (!headers || headers.length > 64) throw new Error('DOWNLOAD_HEADERS_REFUSED');
      let charged = 0;
      const values = new Map<string, string>();
      for (const header of headers) {
        if (typeof header.name !== 'string' || typeof header.value !== 'string')
          throw new Error('DOWNLOAD_HEADERS_REFUSED');
        charged += Buffer.byteLength(header.name) + Buffer.byteLength(header.value);
        if (charged > 8192) throw new Error('DOWNLOAD_HEADERS_REFUSED');
        const key = header.name.toLowerCase();
        if (
          values.has(key) &&
          ['content-type', 'content-disposition', 'content-length', 'content-encoding'].includes(
            key
          )
        )
          throw new Error('DOWNLOAD_HEADERS_REFUSED');
        values.set(key, header.value);
      }
      const url = new URL(event.request.url);
      const disposition = values.get('content-disposition') ?? '';
      const mimeType = (values.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
      if (
        event.responseErrorReason ||
        event.responseStatusCode !== 200 ||
        (values.has('content-encoding') &&
          (values.get('content-encoding') ?? '').toLowerCase() !== 'identity') ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        !/^attachment(?:\s*;|\s*$)/i.test(disposition) ||
        !MIME.has(mimeType)
      ) {
        await this.enter(() => this.send('Fetch.continueResponse', { requestId }));
        return;
      }
      const signal = this.signal;
      if (!signal) throw new Error('DOWNLOAD_UNARMED');
      await this.permission(signal);
      this.check(signal);
      if (this.claimed) {
        await this.enter(() => this.send('Fetch.continueResponse', { requestId }));
        return;
      }
      const length = values.get('content-length');
      if (length !== undefined && (!/^[0-9]{1,10}$/.test(length) || Number(length) > MAX_BYTES)) {
        await this.enter(() =>
          this.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' })
        );
        throw new Error('DOWNLOAD_SIZE_REFUSED');
      }
      // Filename is display metadata only. No website value becomes a path.
      const supplied = /(?:^|;)\s*filename="?([^";]*)/i.exec(disposition)?.[1] ?? '';
      const leaf = supplied.split(/[\\/]/).pop() ?? '';
      const cleaned = leaf
        .replace(/[^A-Za-z0-9._ -]/g, '_')
        .slice(0, 100)
        .replace(/^[. ]+/, '')
        .replace(/[. ]+$/, '');
      const name = cleaned || `download.${MIME.get(mimeType)}`;
      this.claimed = true;
      this.requestId = requestId;
      this.accept(
        Object.freeze({
          requestId,
          name,
          mimeType,
          ...(length === undefined ? {} : { expectedBytes: Number(length) }),
        })
      );
    });
    void task.catch((value) => {
      this.failure(value);
      this.refuse(value);
    });
  };
  constructor(
    session: CDPSession,
    sink: OwnedDownloadSink,
    private readonly current: () => boolean
  ) {
    this.selected = new Promise((accept, refuse) => {
      this.accept = accept;
      this.refuse = refuse;
    });
    void this.selected.catch(() => undefined);
    this.binding = Object.freeze(parseBrowserBinding(sink.binding));
    this.authorize = sink.authorize.bind(sink);
    this.stage = sink.stage.bind(sink);
    this.send = session.send.bind(session);
    this.on = session.on.bind(session);
    this.off = session.off.bind(session);
  }
  private failure(value: unknown): void {
    this.first ??= Object.freeze({ value });
  }
  private throwOriginalFailure(): void {
    if (this.first) throw this.first.value;
  }
  private check(signal: AbortSignal): void {
    signal.throwIfAborted();
    this.throwOriginalFailure();
    if (this.closed) throw new Error('DOWNLOAD_AUTHORITY_REFUSED');
    const admitted = this.current();
    this.throwOriginalFailure();
    signal.throwIfAborted();
    if (this.closed || !admitted) throw new Error('DOWNLOAD_AUTHORITY_REFUSED');
  }
  private enter<T>(effect: () => Promise<T>): Promise<T> {
    const signal = this.signal;
    if (!signal) throw new Error('DOWNLOAD_UNARMED');
    // Final current callback runs before the callback-free closed/first fence and actual captured native send.
    this.check(signal);
    return effect();
  }
  private async permission(signal: AbortSignal): Promise<void> {
    this.check(signal);
    await this.authorize(this.binding, signal);
    this.check(signal);
  }
  private own<T>(producer: () => Promise<T>): Promise<T> {
    const original = Promise.resolve().then(producer);
    this.originals.add(original);
    void original.then(
      () => this.originals.delete(original),
      (value) => {
        this.failure(value);
        this.originals.delete(original);
      }
    );
    return original;
  }
  /** Await original response-stage interception ACK before the canonical activation may enter. */
  begin(signal: AbortSignal): Promise<void> {
    if (this.beginning) return this.beginning;
    this.signal = signal;
    this.beginning = this.own(async () => {
      await this.permission(signal);
      const tree = await this.enter(() => this.send('Page.getFrameTree'));
      this.check(signal);
      if (!tree.frameTree.frame.id || tree.frameTree.frame.parentId)
        throw new Error('DOWNLOAD_FRAME_REFUSED');
      this.root = tree.frameTree.frame.id;
      this.listening = true;
      this.check(signal);
      this.on('Fetch.requestPaused', this.observe);
      await this.permission(signal);
      await this.enter(() =>
        this.send('Fetch.enable', {
          patterns: [
            {
              urlPattern: '*',
              resourceType: 'Document',
              requestStage: 'Response',
            },
          ],
          handleAuthRequests: false,
        })
      );
      this.check(signal);
      this.armed = true;
    });
    return this.beginning;
  }
  /** Read only the exact selected native response; bounded IO never changes browser download policy. */
  complete(binding: BrowserBinding, signal: AbortSignal): Promise<void> {
    if (this.completing) throw new Error('DOWNLOAD_REPLAY_REFUSED');
    this.completing = this.own(async () => {
      this.check(signal);
      if (!this.beginning || !sameBinding(binding, this.binding))
        throw new Error('DOWNLOAD_BINDING_REFUSED');
      await this.beginning;
      const selected = await this.selected;
      await this.permission(signal);
      const response = await this.enter(() =>
        this.send('Fetch.takeResponseBodyAsStream', {
          requestId: selected.requestId,
        })
      );
      this.stream = response.stream;
      this.check(signal);
      if (typeof this.stream !== 'string' || !this.stream || this.stream.length > 256)
        throw new Error('DOWNLOAD_STREAM_REFUSED');
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for (let reads = 0; reads < 64; reads++) {
          await this.permission(signal);
          const handle = this.stream;
          if (!handle) throw new Error('DOWNLOAD_STREAM_REFUSED');
          const part = await this.enter(() => this.send('IO.read', { handle, size: 65536 }));
          this.check(signal);
          if (
            typeof part.eof !== 'boolean' ||
            (part.base64Encoded !== undefined && typeof part.base64Encoded !== 'boolean')
          )
            throw new Error('DOWNLOAD_CHUNK_REFUSED');
          if (typeof part.data !== 'string' || part.data.length > 87384)
            throw new Error('DOWNLOAD_CHUNK_REFUSED');
          if (
            part.base64Encoded &&
            (!/^[A-Za-z0-9+/]*={0,2}$/.test(part.data) || part.data.length % 4 !== 0)
          )
            throw new Error('DOWNLOAD_CHUNK_REFUSED');
          const chunk = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8');
          if (chunk.length > 65536 || bytes + chunk.length > MAX_BYTES) {
            chunk.fill(0);
            throw new Error('DOWNLOAD_SIZE_REFUSED');
          }
          chunks.push(chunk);
          bytes += chunk.length;
          if (part.eof) {
            if (selected.expectedBytes !== undefined && bytes !== selected.expectedBytes)
              throw new Error('DOWNLOAD_TRUNCATED_REFUSED');
            if (!bytes) throw new Error('DOWNLOAD_EMPTY_REFUSED');
            await this.permission(signal);
            const joined = Buffer.concat(chunks, bytes);
            try {
              this.check(signal);
              this.result = Object.freeze(
                await this.stage(selected.name, selected.mimeType, joined, signal)
              );
            } finally {
              joined.fill(0);
            }
            this.check(signal);
            return;
          }
          if (!chunk.length) throw new Error('DOWNLOAD_PROGRESS_REFUSED');
        }
        throw new Error('DOWNLOAD_READ_CAPACITY_REFUSED');
      } finally {
        for (const chunk of chunks) chunk.fill(0);
      }
    });
    return this.completing;
  }
  /** Expose only completed private artifact metadata after the exact original native operation. */
  artifact(): OwnedDownloadArtifact {
    if (!this.result || this.first) throw new Error('DOWNLOAD_ARTIFACT_UNAVAILABLE');
    return this.result;
  }
  /** Original custody counts are observations, never transfer authority. */
  custody(): Readonly<{ pending: number; failed: boolean }> {
    return Object.freeze({
      pending: this.originals.size,
      failed: this.first !== undefined,
    });
  }
  /** Join entered reads before canceling the exact response, disabling only this session handler and cleanup. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.refuse(new Error('DOWNLOAD_CLOSED'));
    let resolve!: () => void, reject!: (value: unknown) => void;
    this.closing = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    if (this.listening)
      try {
        this.off('Fetch.requestPaused', this.observe);
      } catch (value) {
        this.failure(value);
      }
    void Promise.resolve().then(async () => {
      await Promise.allSettled([...this.originals]);
      for (const effect of [
        () => (this.stream ? this.send('IO.close', { handle: this.stream }) : Promise.resolve()),
        () =>
          this.requestId
            ? this.send('Fetch.failRequest', {
                requestId: this.requestId,
                errorReason: 'Aborted',
              })
            : Promise.resolve(),
        () => (this.listening ? this.send('Fetch.disable') : Promise.resolve()),
      ])
        try {
          await effect();
        } catch (value) {
          this.failure(value);
        }
      if (this.first) reject(this.first.value);
      else resolve();
    });
    void this.closing.catch(() => undefined);
    return this.closing;
  }
}
