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
 * It also holds the session's **driver table** (spec `canvas-agent-seat` §2.2):
 * which window is showing which browser document, so a driving command reaches
 * exactly one preview instead of whichever answered first. See
 * {@link DriverClaim}.
 *
 * @module services/session/devtools-capture-store
 */
import type {
  DevtoolsActionResult,
  DevtoolsConsoleEntry,
  DevtoolsIngest,
  DevtoolsNetworkEntry,
} from '@dorkos/shared/schemas';
import { WORKBENCH } from '../../config/constants.js';

/**
 * A rendered screenshot of the preview. Single-slot (latest wins), filled by
 * the `browser_screenshot` capture round-trip (DOR-213 Phase 3).
 *
 * Deliberately EXCLUDED from `approxBytes` and bounded by its OWN cap instead:
 * the ingest schema rejects a data URL past `DEVTOOLS_SCREENSHOT_MAX_CHARS`
 * (413), and the slot is single, so the per-session screenshot retention is
 * hard-capped at that constant. Folding it into the shared byte budget would
 * let one screenshot evict the console/network history the read tools exist to
 * surface — a worse trade than the separate, tighter bound.
 */
export interface DevtoolsScreenshotEntry {
  /** PNG data URL of the rendered preview. */
  dataUrl: string;
  /** Epoch ms the screenshot was captured. */
  capturedAt: number;
  /** The `requestId` of the round-trip that produced it, when applicable. */
  requestId?: string;
}

/**
 * The resolution the `browser_screenshot` tool awaits: the shim's capture
 * result for one `requestId` — a stored screenshot on success, or the shim's
 * error string when the page could not be rasterized (e.g. its CSP blocked the
 * injected rasterizer).
 */
export type ScreenshotOutcome =
  { ok: true; screenshot: DevtoolsScreenshotEntry } | { ok: false; error: string };

/**
 * One window's claim on one browser document — a row in the session's driver
 * table (spec `canvas-agent-seat` §2.2).
 *
 * The **driver seat** is the row with the greatest `activeAt`, and a driving
 * command with no `documentId` is addressed to it. The arbiter has to live
 * somewhere there is exactly one of, and that is here: one session can be open
 * in two windows at once, each with its own idea of which preview is in front,
 * so resolving "the active one" in the client would give two windows the same
 * answer and put the race back with `act` verbs in it.
 */
export interface DriverClaim {
  /** The `X-Client-Id` of the window holding the page. */
  clientId: string;
  /** The canvas document id of the browser tab it is holding. */
  documentId: string;
  /** Epoch ms of the most recent claim. Greatest wins the seat. */
  activeAt: number;
  /**
   * Whether the in-page shim ever handshook in that frame. False for a page
   * framed straight from the internet and for a dev server framed by its own
   * address: both render, and neither can be driven or read.
   */
  instrumented: boolean;
}

/** How many windows-and-pages one session remembers before evicting the oldest. */
const MAX_DRIVER_CLAIMS = 8;

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
  /** True once the console ring dropped an entry (count cap OR byte budget). */
  consoleEvicted: boolean;
  /** True once the network ring dropped an entry (count cap OR byte budget). */
  networkEvicted: boolean;
  /**
   * Which windows are showing which browser documents for this session, most
   * recent claim last. Lives on the buffer rather than beside it so it moves
   * across the first-turn canonical rekey for free ({@link
   * DevtoolsCaptureStore.rekeySession}), which is the same reason the buffer
   * itself has to move.
   */
  drivers: DriverClaim[];
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
  /**
   * True once the console ring evicted an entry — by the count cap OR the byte
   * budget. The read tools fold this into their `truncated` signal; a count-only
   * check would lie when large entries byte-evict below the count cap. Cleared
   * at a navigation boundary (`reset`), because the new page starts clean.
   */
  consoleEvicted: boolean;
  /** Network-ring counterpart of {@link CaptureBuffer.consoleEvicted}. */
  networkEvicted: boolean;
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
   * Pending `browser_screenshot` round-trips, keyed by requestId (session-
   * agnostic — see the rekey note in {@link ingest}). Entries are removed on
   * resolution or timeout, so the map never outgrows the in-flight captures.
   */
  private readonly screenshotWaiters = new Map<string, (outcome: ScreenshotOutcome) => void>();
  /**
   * Pending driving round-trips, keyed by requestId for exactly the reason the
   * screenshot waiters are: a session rekey between the request and the answer
   * must not strand a tool call.
   */
  private readonly actionWaiters = new Map<string, (result: DevtoolsActionResult) => void>();

  /**
   * Append an ingest batch to a session's buffer, creating it on first ingest.
   * A `reset` batch (navigation boundary) clears console/network first so the
   * new page starts clean. Bounds apply oldest-first, in order: per-ring entry
   * counts, then the per-session byte budget across both rings. The store itself
   * evicts the least-recently-updated session past its session cap.
   *
   * @param sessionId - The session the preview belongs to.
   * @param batch - The validated ingest payload.
   * @param clientId - The `X-Client-Id` of the window that posted it. Required
   *   to act on a seat claim (`batch.active`); a batch without one still
   *   ingests its captures and simply claims nothing.
   */
  ingest(sessionId: string, batch: DevtoolsIngest, clientId?: string): void {
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
        consoleEvicted: false,
        networkEvicted: false,
        drivers: [],
      };
      this.buffers.set(sessionId, buffer);
    }

    if (batch.reset) {
      buffer.console = [];
      buffer.network = [];
      buffer.approxBytes = 0;
      // A navigation boundary starts the new page clean — prior-page eviction
      // must not make the next read claim this page's capture is incomplete.
      buffer.consoleEvicted = false;
      buffer.networkEvicted = false;
    }
    if (batch.documentId !== undefined) buffer.documentId = batch.documentId;
    if (batch.logicalUrl !== undefined) buffer.logicalUrl = batch.logicalUrl;

    if (batch.console.length > 0) {
      const incoming = sized(batch.console);
      buffer.console.push(...incoming);
      buffer.approxBytes += bytesOf(incoming);
      this.trimCount(buffer, 'console', WORKBENCH.DEVTOOLS_CONSOLE_BUFFER);
    }
    if (batch.network.length > 0) {
      const incoming = sized(batch.network);
      buffer.network.push(...incoming);
      buffer.approxBytes += bytesOf(incoming);
      this.trimCount(buffer, 'network', WORKBENCH.DEVTOOLS_NETWORK_BUFFER);
    }
    this.trimBytes(buffer);

    if (batch.screenshot) {
      const { requestId, dataUrl, error } = batch.screenshot;
      let outcome: ScreenshotOutcome;
      if (dataUrl) {
        const entry: DevtoolsScreenshotEntry = { dataUrl, capturedAt: Date.now(), requestId };
        buffer.screenshot = entry; // single slot, latest wins
        outcome = { ok: true, screenshot: entry };
      } else {
        outcome = { ok: false, error: error ?? 'The preview returned no screenshot data.' };
      }
      // Waiters are keyed by requestId ALONE (not session id) so the
      // first-turn canonical rekey — the client may ingest under the canonical
      // id while the tool requested under the request UUID — can never strand
      // an awaiting `browser_screenshot` call.
      const resolve = this.screenshotWaiters.get(requestId);
      if (resolve) {
        this.screenshotWaiters.delete(requestId);
        resolve(outcome);
      }
    }

    if (batch.active !== undefined && clientId && batch.documentId) {
      this.applyClaim(
        buffer,
        clientId,
        batch.documentId,
        batch.active,
        batch.instrumented === true
      );
    }

    buffer.lastSeq = Math.max(buffer.lastSeq, batch.seq);
    buffer.updatedAt = Date.now();
  }

  /**
   * Take or release one window's claim on one browser document.
   *
   * A claim moves the row to the end of the list and stamps it now, which is
   * what takes the seat; a release removes it, and the seat falls to whatever
   * claim is left — to nobody when there is none. Capped oldest-first, so a
   * person who opens twenty previews over an afternoon does not accumulate
   * twenty rows.
   */
  private applyClaim(
    buffer: InternalBuffer,
    clientId: string,
    documentId: string,
    active: boolean,
    instrumented: boolean
  ): void {
    const index = buffer.drivers.findIndex(
      (claim) => claim.clientId === clientId && claim.documentId === documentId
    );
    if (!active) {
      if (index >= 0) buffer.drivers.splice(index, 1);
      return;
    }
    if (index >= 0) buffer.drivers.splice(index, 1);
    buffer.drivers.push({ clientId, documentId, activeAt: Date.now(), instrumented });
    if (buffer.drivers.length > MAX_DRIVER_CLAIMS) {
      buffer.drivers.splice(0, buffer.drivers.length - MAX_DRIVER_CLAIMS);
    }
  }

  /**
   * Which window a request should be addressed to, and for which page.
   *
   * With no `documentId` the answer is the **seat**: the most recent claim, the
   * window whose preview came to the front last. With one, it is the most recent
   * claim on exactly that document — so an agent that holds three previews can
   * say which. `undefined` means nothing matched, and the caller answers in a
   * sentence rather than minting a request nobody will ever reply to.
   *
   * @param sessionId - The session whose table to read.
   * @param documentId - The browser tab to address, or `undefined` for the seat.
   */
  resolveDriver(sessionId: string, documentId?: string): DriverClaim | undefined {
    const claims = this.buffers.get(sessionId)?.drivers;
    if (!claims || claims.length === 0) return undefined;
    // Stale rows are skipped, never returned. A window that is killed, suspended
    // or loses its network sends no release, and a seat nobody is sitting in
    // would make every verb address a client that no longer answers and wait out
    // its whole timeout — for the life of the session. A live window re-reports
    // every `DEVTOOLS_SEAT_REFRESH_MS`, so a row this old has missed three.
    const floor = Date.now() - WORKBENCH.DEVTOOLS_SEAT_STALE_MS;
    for (let i = claims.length - 1; i >= 0; i--) {
      const claim = claims[i];
      if (claim.activeAt < floor) continue;
      if (documentId === undefined || claim.documentId === documentId) return { ...claim };
    }
    return undefined;
  }

  /**
   * Whether any window is holding a browser document for this session at all.
   *
   * Separates "nothing is open" (open one) from "that page is not open any more"
   * (list what is), which are two different things for an agent to do next.
   *
   * @param sessionId - The session whose table to read.
   */
  hasDrivers(sessionId: string): boolean {
    const claims = this.buffers.get(sessionId)?.drivers;
    if (!claims) return false;
    // Live rows only, to stay the exact complement of {@link resolveDriver}: a
    // session whose only claim is stale has nothing open, and telling the agent
    // "no window has THAT page" when nothing is open at all would point it at
    // the wrong fix.
    const floor = Date.now() - WORKBENCH.DEVTOOLS_SEAT_STALE_MS;
    return claims.some((claim) => claim.activeAt >= floor);
  }

  /**
   * Await one driving round-trip's result. Resolves when the addressed window
   * posts an `act-result` for this `requestId`, or with `undefined` after
   * `timeoutMs` — never hangs, so a page that stopped answering costs a wait and
   * a plain sentence rather than a turn.
   *
   * @param requestId - The round-trip id the tool stamped on its request.
   * @param timeoutMs - How long to wait before giving up.
   */
  awaitAction(requestId: string, timeoutMs: number): Promise<DevtoolsActionResult | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.actionWaiters.delete(requestId);
        resolve(undefined);
      }, timeoutMs);
      this.actionWaiters.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /**
   * Deliver one driving result to whatever is awaiting it. Keyed by requestId
   * alone, like the screenshot path and for the same rekey reason. A result for
   * a request nobody is awaiting (the tool already timed out, the turn ended) is
   * dropped, which is why exactly one result per requestId is the shim's rule
   * rather than a thing this has to police.
   *
   * @param result - The validated result relayed from the in-page shim.
   */
  resolveAction(result: DevtoolsActionResult): void {
    const resolve = this.actionWaiters.get(result.requestId);
    if (!resolve) return;
    this.actionWaiters.delete(result.requestId);
    resolve(result);
  }

  /**
   * Await the capture outcome for one `browser_screenshot` round-trip. Resolves
   * when an ingest batch carrying `screenshot.requestId === requestId` arrives
   * (success or shim-side error), or with `undefined` after `timeoutMs` —
   * never hangs. One waiter per requestId; requestIds are single-use UUIDs.
   *
   * @param requestId - The round-trip id the tool stamped on its capture request.
   * @param timeoutMs - How long to wait before giving up.
   */
  awaitScreenshot(requestId: string, timeoutMs: number): Promise<ScreenshotOutcome | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.screenshotWaiters.delete(requestId);
        resolve(undefined);
      }, timeoutMs);
      this.screenshotWaiters.set(requestId, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
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
      consoleEvicted: buffer.consoleEvicted,
      networkEvicted: buffer.networkEvicted,
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

  /** Drop every buffer and every pending waiter (test isolation). */
  clear(): void {
    this.buffers.clear();
    this.screenshotWaiters.clear();
    this.actionWaiters.clear();
  }

  /**
   * Drop a ring's oldest entries past its count cap, keeping bytes in sync and
   * flagging the ring as evicted so readers can report an honest `truncated`.
   */
  private trimCount(buffer: InternalBuffer, ring: 'console' | 'network', capCount: number): void {
    // Widened so splice's union-of-arrays result satisfies bytesOf's generic.
    const entries: Sized<unknown>[] = buffer[ring];
    if (entries.length <= capCount) return;
    const dropped = entries.splice(0, entries.length - capCount);
    buffer.approxBytes -= bytesOf(dropped);
    buffer[ring === 'console' ? 'consoleEvicted' : 'networkEvicted'] = true;
  }

  /**
   * Enforce the per-session byte budget, evicting oldest-first: whichever ring's
   * head entry is older (by capture timestamp) loses it, until under budget.
   * Flags the losing ring as evicted (see {@link CaptureBuffer.consoleEvicted}).
   */
  private trimBytes(buffer: InternalBuffer): void {
    while (buffer.approxBytes > WORKBENCH.DEVTOOLS_SESSION_MAX_BYTES) {
      const c = buffer.console[0];
      const n = buffer.network[0];
      if (!c && !n) break; // unreachable: bytes track ring contents
      const fromConsole = Boolean(c && (!n || c.entry.timestamp <= n.entry.timestamp));
      const ring = fromConsole ? buffer.console : buffer.network;
      const dropped = ring.shift();
      if (dropped) {
        buffer.approxBytes -= dropped.bytes;
        buffer[fromConsole ? 'consoleEvicted' : 'networkEvicted'] = true;
      }
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
