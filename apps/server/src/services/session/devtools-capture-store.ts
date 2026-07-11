/**
 * Per-session DevTools capture store (DOR-213) — the server-side buffer the
 * injected preview shim feeds through the client's ingest call.
 *
 * A side `Map<sessionId, CaptureBuffer>` rather than a field on the per-turn
 * session object, because a preview emits console/network *between* agent turns
 * (continuously), so the buffer must outlive any single turn. Rings are bounded
 * (console/network) and the screenshot is single-slot; everything is in memory,
 * never persisted, and dropped on session close (wired into `disposeProjector`).
 * Cross-session isolation is structural: the map is keyed by session id and no
 * method ever reads across keys.
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
 */
export interface DevtoolsScreenshotEntry {
  /** PNG data URL of the rendered preview. */
  dataUrl: string;
  /** Epoch ms the screenshot was captured. */
  capturedAt: number;
  /** The `requestId` of the round-trip that produced it, when applicable. */
  requestId?: string;
}

/** One session's bounded capture buffer. */
export interface CaptureBuffer {
  /** Console lines + uncaught errors, oldest-evicted past the cap. */
  console: DevtoolsConsoleEntry[];
  /** `fetch`/XHR requests, oldest-evicted past the cap. */
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
}

/** A read-only snapshot of a session's buffer for callers that only inspect it. */
export type CaptureBufferView = Readonly<CaptureBuffer>;

/**
 * In-memory, bounded, per-session store of preview console/network/screenshot
 * captures. A singleton ({@link devtoolsCaptureStore}); construct fresh instances
 * only in tests.
 */
export class DevtoolsCaptureStore {
  private readonly buffers = new Map<string, CaptureBuffer>();

  /**
   * Append an ingest batch to a session's buffer, creating it on first ingest.
   * A `reset` batch (navigation boundary) clears console/network first so the new
   * page starts clean. Rings evict oldest past their caps; the store evicts the
   * least-recently-updated session past its own cap.
   *
   * @param sessionId - The session the preview belongs to.
   * @param batch - The validated ingest payload.
   */
  ingest(sessionId: string, batch: DevtoolsIngest): void {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      this.evictIfFull();
      buffer = { console: [], network: [], screenshot: null, lastSeq: 0, updatedAt: 0 };
      this.buffers.set(sessionId, buffer);
    }

    if (batch.reset) {
      buffer.console = [];
      buffer.network = [];
    }
    if (batch.documentId !== undefined) buffer.documentId = batch.documentId;
    if (batch.logicalUrl !== undefined) buffer.logicalUrl = batch.logicalUrl;

    if (batch.console.length > 0) {
      buffer.console.push(...batch.console);
      trim(buffer.console, WORKBENCH.DEVTOOLS_CONSOLE_BUFFER);
    }
    if (batch.network.length > 0) {
      buffer.network.push(...batch.network);
      trim(buffer.network, WORKBENCH.DEVTOOLS_NETWORK_BUFFER);
    }

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
    return this.buffers.get(sessionId);
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

/** Drop the oldest entries in place so `arr` holds at most `cap`. */
function trim<T>(arr: T[], cap: number): void {
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/** Process-wide capture store shared by the ingest route and the read tools. */
export const devtoolsCaptureStore = new DevtoolsCaptureStore();
