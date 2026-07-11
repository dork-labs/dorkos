/**
 * Per-session DevTools capture store (DOR-213) — the server-side buffer the
 * injected preview shim feeds through the client's ingest call.
 *
 * A side `Map<sessionId, buffer>` rather than a field on the per-turn session
 * object, because a preview emits console/network *between* agent turns
 * (continuously), so the buffer must outlive any single turn. Rings are bounded
 * two ways — a per-ring entry-count cap AND an approximate per-session byte
 * budget (count caps alone don't bound memory: the schema still permits ~56 KB
 * per console entry) — with oldest-first eviction for both. The screenshot is
 * single-slot; everything is in memory, never persisted, and dropped on session
 * close (wired into `disposeProjector`). Cross-session isolation is structural:
 * the map is keyed by session id and no method ever reads across keys.
 *
 * @module services/session/devtools-capture-store
 */
import type {
  DevtoolsConsoleEntry,
  DevtoolsIngest,
  DevtoolsNetworkEntry,
} from '@dorkos/shared/schemas';
import { WORKBENCH } from '../../config/constants.js';

/**
 * A rendered screenshot of the preview. Single-slot (latest wins). The slot is
 * defined now; the on-demand capture round-trip that fills it lands with the
 * `browser_screenshot` tool in a follow-up phase.
 *
 * NOTE (Phase 3): the screenshot slot is currently EXCLUDED from `approxBytes` —
 * nothing writes it yet, so there is nothing to account. When the capture
 * round-trip lands, its PNG data URL (potentially hundreds of KB) must be folded
 * into the byte accounting (or bounded by its own dimension/size cap) so the
 * per-session budget stays honest.
 */
export interface DevtoolsScreenshotEntry {
  /** PNG data URL of the rendered preview. */
  dataUrl: string;
  /** Epoch ms the screenshot was captured. */
  capturedAt: number;
  /** The `requestId` of the round-trip that produced it, when applicable. */
  requestId?: string;
}

/** An entry retained with its approximate serialized size (byte accounting). */
interface Sized<T> {
  entry: T;
  bytes: number;
}

/** The store's internal per-session state — entries carry their sizes. */
interface InternalBuffer {
  console: Sized<DevtoolsConsoleEntry>[];
  network: Sized<DevtoolsNetworkEntry>[];
  screenshot: DevtoolsScreenshotEntry | null;
  documentId?: string;
  logicalUrl?: string;
  lastSeq: number;
  updatedAt: number;
  /** Running approximate byte total across both rings. */
  approxBytes: number;
}

/** One session's capture buffer, as read by callers. */
export interface CaptureBuffer {
  /** Console lines + uncaught errors, oldest-evicted past the caps. */
  console: DevtoolsConsoleEntry[];
  /** `fetch`/XHR requests, oldest-evicted past the caps. */
  network: DevtoolsNetworkEntry[];
  /** Latest screenshot, or `null` until one is captured. */
  screenshot: DevtoolsScreenshotEntry | null;
  /** The canvas document id of the preview currently feeding this buffer. */
  documentId?: string;
  /** The logical URL of that preview (never a signed token URL). */
  logicalUrl?: string;
  /** Highest `seq` ingested — lets a reader reason about gaps. */
  lastSeq: number;
  /** Epoch ms of the last ingest (drives least-recently-updated eviction). */
  updatedAt: number;
  /** Approximate retained bytes across both rings (serialized-JSON chars). */
  approxBytes: number;
}

/** A read-only snapshot of a session's buffer for callers that only inspect it. */
export type CaptureBufferView = Readonly<CaptureBuffer>;

/** Approximate an entry's retained size as its serialized-JSON length. */
function sizeOf(entry: unknown): number {
  try {
    return JSON.stringify(entry)?.length ?? 0;
  } catch {
    // Entries arrive via JSON.parse so this is unreachable in practice; treat an
    // unmeasurable entry as budget-free rather than failing the ingest.
    return 0;
  }
}

/** Wrap incoming entries with their sizes. */
function sized<T>(entries: T[]): Sized<T>[] {
  return entries.map((entry) => ({ entry, bytes: sizeOf(entry) }));
}

/** Sum of the sizes carried by a run of sized entries. */
function bytesOf<T>(entries: Sized<T>[]): number {
  return entries.reduce((sum, s) => sum + s.bytes, 0);
}

/**
 * In-memory, bounded, per-session store of preview console/network/screenshot
 * captures. A singleton ({@link devtoolsCaptureStore}); construct fresh instances
 * only in tests.
 */
export class DevtoolsCaptureStore {
  private readonly buffers = new Map<string, InternalBuffer>();

  /**
   * Append an ingest batch to a session's buffer, creating it on first ingest.
   * A `reset` batch (navigation boundary) clears console/network first so the
   * new page starts clean. Bounds apply oldest-first, in order: per-ring entry
   * counts, then the per-session byte budget across both rings. The store itself
   * evicts the least-recently-updated session past its session cap.
   *
   * @param sessionId - The session the preview belongs to.
   * @param batch - The validated ingest payload.
   */
  ingest(sessionId: string, batch: DevtoolsIngest): void {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      this.evictIfFull();
      buffer = {
        console: [],
        network: [],
        screenshot: null,
        lastSeq: 0,
        updatedAt: 0,
        approxBytes: 0,
      };
      this.buffers.set(sessionId, buffer);
    }

    if (batch.reset) {
      buffer.console = [];
      buffer.network = [];
      buffer.approxBytes = 0;
    }
    if (batch.documentId !== undefined) buffer.documentId = batch.documentId;
    if (batch.logicalUrl !== undefined) buffer.logicalUrl = batch.logicalUrl;

    if (batch.console.length > 0) {
      const incoming = sized(batch.console);
      buffer.console.push(...incoming);
      buffer.approxBytes += bytesOf(incoming);
      this.trimCount(buffer, buffer.console, WORKBENCH.DEVTOOLS_CONSOLE_BUFFER);
    }
    if (batch.network.length > 0) {
      const incoming = sized(batch.network);
      buffer.network.push(...incoming);
      buffer.approxBytes += bytesOf(incoming);
      this.trimCount(buffer, buffer.network, WORKBENCH.DEVTOOLS_NETWORK_BUFFER);
    }
    this.trimBytes(buffer);

    buffer.lastSeq = Math.max(buffer.lastSeq, batch.seq);
    buffer.updatedAt = Date.now();
  }

  /**
   * Return a session's capture buffer, or `undefined` when none exists (no
   * preview has ingested for it). The read tools resolve the buffer through here.
   *
   * @param sessionId - The session to read.
   */
  read(sessionId: string): CaptureBufferView | undefined {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) return undefined;
    return {
      console: buffer.console.map((s) => s.entry),
      network: buffer.network.map((s) => s.entry),
      screenshot: buffer.screenshot,
      documentId: buffer.documentId,
      logicalUrl: buffer.logicalUrl,
      lastSeq: buffer.lastSeq,
      updatedAt: buffer.updatedAt,
      approxBytes: buffer.approxBytes,
    };
  }

  /**
   * Drop a session's buffer on close/eviction. Idempotent.
   *
   * @param sessionId - The session whose buffer to discard.
   */
  dropSession(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  /**
   * Move a buffer from `oldId` to `newId`, preserving it across the first-turn
   * canonical-id rekey (mirrors `rekeyProjector`). No-op when ids match or there
   * is nothing under `oldId`.
   *
   * @param oldId - The id the buffer is currently keyed under.
   * @param newId - The canonical id to move it to.
   */
  rekeySession(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const buffer = this.buffers.get(oldId);
    if (!buffer) return;
    this.buffers.delete(oldId);
    this.buffers.set(newId, buffer);
  }

  /** Number of sessions currently holding a buffer (tests + diagnostics). */
  get size(): number {
    return this.buffers.size;
  }

  /** Drop every buffer (test isolation). */
  clear(): void {
    this.buffers.clear();
  }

  /** Drop a ring's oldest entries past its count cap, keeping bytes in sync. */
  private trimCount<T>(buffer: InternalBuffer, ring: Sized<T>[], capCount: number): void {
    if (ring.length <= capCount) return;
    const dropped = ring.splice(0, ring.length - capCount);
    buffer.approxBytes -= bytesOf(dropped);
  }

  /**
   * Enforce the per-session byte budget, evicting oldest-first: whichever ring's
   * head entry is older (by capture timestamp) loses it, until under budget.
   */
  private trimBytes(buffer: InternalBuffer): void {
    while (buffer.approxBytes > WORKBENCH.DEVTOOLS_SESSION_MAX_BYTES) {
      const c = buffer.console[0];
      const n = buffer.network[0];
      if (!c && !n) break; // unreachable: bytes track ring contents
      const ring =
        c && (!n || c.entry.timestamp <= n.entry.timestamp) ? buffer.console : buffer.network;
      const dropped = ring.shift();
      if (dropped) buffer.approxBytes -= dropped.bytes;
    }
  }

  /** Evict the least-recently-updated buffer when at the session cap. */
  private evictIfFull(): void {
    if (this.buffers.size < WORKBENCH.DEVTOOLS_MAX_SESSIONS) return;
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, buf] of this.buffers) {
      if (buf.updatedAt < oldestAt) {
        oldestAt = buf.updatedAt;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) this.buffers.delete(oldestId);
  }
}

/** Process-wide capture store shared by the ingest route and the read tools. */
export const devtoolsCaptureStore = new DevtoolsCaptureStore();
