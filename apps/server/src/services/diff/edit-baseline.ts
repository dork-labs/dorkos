/**
 * Per-session pre-edit baseline store — the diff base for the review surface
 * (DOR-212, ADR 260711-142049).
 *
 * When an agent is about to edit a file, DorkOS captures the file's on-disk bytes
 * BEFORE the edit applies and keys them by `(sessionId, absPath)`, first-touch-
 * wins. Every later edit to the same file keeps that same baseline, so the diff
 * is always `baseline → current disk` — precisely the agent's changes this
 * session, isolated from the operator's own pre-existing uncommitted work and
 * independent of git.
 *
 * Baselines are held as raw `Buffer`s (binary-safe from day one, so the image-
 * diff chunk needs no capture changes), in-memory only, and dropped when the
 * session's stream tears down. Memory is bounded twice over: a file larger than
 * {@link FILE_LIMITS.MAX_TEXT_FILE_BYTES} is never buffered (an `oversize`
 * marker is stored instead, so resolution degrades honestly), and each session
 * has a total byte budget ({@link DIFF.MAX_SESSION_BASELINE_BYTES}) enforced by
 * evicting the oldest baselines. A missing/evicted baseline falls back to the
 * git-HEAD / empty ladder — disclosed to the operator, never a blind clobber.
 *
 * @module services/diff/edit-baseline
 */
import fs from 'node:fs/promises';
import { FILE_LIMITS, DIFF } from '../../config/constants.js';
import { reconstructPreImage } from './reconstruct.js';

/** How a stored baseline's bytes were obtained. `'empty'` is a resolution-time origin, never stored. */
export type BaselineOrigin = 'pre-tool' | 'reconstructed' | 'head';

/** One file's captured pre-edit state for a session. */
export interface Baseline {
  /**
   * The file's bytes as they were before this session's first edit (binary-
   * safe). Empty when {@link oversize} is set — an oversize file's bytes are
   * never buffered.
   */
  bytes: Buffer;
  /** Server epoch ms the baseline was captured. */
  capturedAt: number;
  /** How the bytes were obtained (for diagnostics + the response's `capturedFrom`). */
  capturedFrom: BaselineOrigin;
  /**
   * The file exceeded {@link FILE_LIMITS.MAX_TEXT_FILE_BYTES} at capture time,
   * so its pre-image was deliberately NOT stored. Resolution must skip this
   * entry (degrading to the HEAD/empty rung, which the client discloses) rather
   * than treat the empty `bytes` as a real pre-image.
   */
  oversize?: boolean;
}

/** A session's baselines plus their running byte total (for the budget). */
interface SessionBaselines {
  entries: Map<string, Baseline>;
  totalBytes: number;
}

/**
 * In-memory per-session pre-edit baseline store. First-touch-wins per
 * `(sessionId, absPath)`; binary-safe; size-guarded per file and byte-budgeted
 * per session (oldest evicted); cleared on session teardown.
 */
export class EditBaselineStore {
  /** `sessionId → { absPath → Baseline, totalBytes }`. */
  private readonly sessions = new Map<string, SessionBaselines>();

  /**
   * Create a store with an optional byte budget override.
   *
   * @param maxSessionBytes - Per-session baseline byte budget (defaults to
   *   {@link DIFF.MAX_SESSION_BASELINE_BYTES}; injectable for tests).
   */
  constructor(private readonly maxSessionBytes: number = DIFF.MAX_SESSION_BASELINE_BYTES) {}

  /**
   * Capture a file's current on-disk bytes as this session's baseline, unless one
   * already exists for the pair (first-touch-wins). Called at the runtime's pre-
   * tool boundary before an edit-family tool runs. A path that does not yet exist
   * on disk (a `Write` creating a new file) captures an EMPTY baseline, so the
   * whole file reads as added — the correct pre-image for a new file. A file over
   * {@link FILE_LIMITS.MAX_TEXT_FILE_BYTES} stores an `oversize` marker instead
   * of its bytes (the text-diff read path rejects such files anyway, so buffering
   * them would be pure memory waste).
   *
   * @param sessionId - Session the edit belongs to.
   * @param absPath - Absolute path the agent is about to edit.
   * @returns `true` when a baseline (or oversize marker) now exists for the pair,
   *   `false` when the disk read failed for a non-ENOENT reason so the caller may
   *   try the reconstruct fallback.
   */
  async captureFromDisk(sessionId: string, absPath: string): Promise<boolean> {
    if (this.has(sessionId, absPath)) return true;
    const read = await this.readForCapture(absPath);
    if (read === null) return false;
    this.set(sessionId, absPath, {
      bytes: read.bytes,
      capturedAt: Date.now(),
      capturedFrom: 'pre-tool',
      ...(read.oversize ? { oversize: true } : {}),
    });
    return true;
  }

  /**
   * Fallback capture (§Q1 Fallback A): reconstruct the pre-image by reverse-
   * applying an `Edit`/`MultiEdit` input against current disk and store it. Used
   * only when {@link captureFromDisk} could not snapshot (a runtime without a
   * synchronous pre-tool seam, or a post-restart miss). A no-op when a baseline
   * already exists, the file can't be read (or is oversize/binary), or the input
   * isn't reversible (e.g. a `Write`) — the resolve ladder then falls through to
   * HEAD / empty.
   *
   * @param sessionId - Session the edit belongs to.
   * @param absPath - Absolute path the agent edited.
   * @param toolName - The edit-family tool name.
   * @param input - The tool's parsed input object.
   */
  async captureFromToolInput(
    sessionId: string,
    absPath: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<void> {
    if (this.has(sessionId, absPath)) return;
    let current: string;
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile() || stat.size > FILE_LIMITS.MAX_TEXT_FILE_BYTES) return;
      const buf = await fs.readFile(absPath);
      // A binary file can't be reversed by string replacement; leave it to HEAD.
      if (buf.includes(0)) return;
      current = buf.toString('utf8');
    } catch {
      return;
    }
    const preImage = reconstructPreImage(toolName, input, current);
    if (preImage === null) return;
    this.set(sessionId, absPath, {
      bytes: Buffer.from(preImage, 'utf8'),
      capturedAt: Date.now(),
      capturedFrom: 'reconstructed',
    });
  }

  /**
   * Store a baseline directly. First-touch-wins; enforces the per-session byte
   * budget by evicting the oldest baselines when the new entry would exceed it.
   *
   * @param sessionId - Session the baseline belongs to.
   * @param absPath - Absolute path keyed.
   * @param baseline - The pre-image bytes + origin.
   */
  set(sessionId: string, absPath: string, baseline: Baseline): void {
    let forSession = this.sessions.get(sessionId);
    if (!forSession) {
      forSession = { entries: new Map<string, Baseline>(), totalBytes: 0 };
      this.sessions.set(sessionId, forSession);
    }
    if (forSession.entries.has(absPath)) return;
    forSession.entries.set(absPath, baseline);
    forSession.totalBytes += baseline.bytes.byteLength;
    this.evictToBudget(forSession);
  }

  /** Whether a baseline exists for the pair. */
  has(sessionId: string, absPath: string): boolean {
    return this.sessions.get(sessionId)?.entries.has(absPath) ?? false;
  }

  /** The stored baseline for the pair, or `undefined` when none was captured. */
  get(sessionId: string, absPath: string): Baseline | undefined {
    return this.sessions.get(sessionId)?.entries.get(absPath);
  }

  /**
   * Advance a file's baseline to its current on-disk bytes (finish-review), so
   * subsequent agent edits diff from the just-reviewed state. Overwrites any
   * existing baseline (byte accounting updated); a no-op when the session has no
   * baseline for the path yet. A file that grew past the size cap becomes an
   * `oversize` marker rather than a buffered blob.
   *
   * @param sessionId - Session whose baseline to advance.
   * @param absPath - Absolute path to advance.
   */
  async advance(sessionId: string, absPath: string): Promise<void> {
    const forSession = this.sessions.get(sessionId);
    const existing = forSession?.entries.get(absPath);
    if (!forSession || !existing) return;
    const read = await this.readForCapture(absPath);
    if (read === null) return;
    forSession.totalBytes -= existing.bytes.byteLength;
    forSession.entries.set(absPath, {
      bytes: read.bytes,
      capturedAt: Date.now(),
      capturedFrom: 'pre-tool',
      ...(read.oversize ? { oversize: true } : {}),
    });
    forSession.totalBytes += read.bytes.byteLength;
    this.evictToBudget(forSession);
  }

  /**
   * List the session's tracked paths whose baseline differs from current disk —
   * i.e. files with unreviewed agent edits. Reads each file once; a path whose
   * baseline equals disk (already reverted/reviewed) is omitted. An `oversize`
   * entry is always pending (the agent touched it; its bytes can't be compared
   * without buffering what the cap exists to avoid).
   *
   * @param sessionId - Session to inspect.
   * @returns Absolute paths with pending (unreviewed) edits.
   */
  async listPending(sessionId: string): Promise<string[]> {
    const forSession = this.sessions.get(sessionId);
    if (!forSession) return [];
    const pending: string[] = [];
    for (const [absPath, baseline] of forSession.entries) {
      if (baseline.oversize) {
        pending.push(absPath);
        continue;
      }
      let current: Buffer;
      try {
        current = await fs.readFile(absPath);
      } catch {
        // Unreadable/deleted since capture — a deletion IS a pending change.
        pending.push(absPath);
        continue;
      }
      if (!current.equals(baseline.bytes)) pending.push(absPath);
    }
    return pending;
  }

  /** Drop every baseline for a session (called on stream teardown / eviction). */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Read a file's bytes for capture, size-guarded. Returns empty bytes for a
   * missing file (a new file's pre-image), an `oversize` marker result past the
   * text cap, and `null` on any other failure (permissions, a directory) so the
   * caller can fall back.
   */
  private async readForCapture(
    absPath: string
  ): Promise<{ bytes: Buffer; oversize?: boolean } | null> {
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) return null;
      if (stat.size > FILE_LIMITS.MAX_TEXT_FILE_BYTES) {
        return { bytes: Buffer.alloc(0), oversize: true };
      }
      return { bytes: await fs.readFile(absPath) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Write-first on a new file: its pre-image is empty.
        return { bytes: Buffer.alloc(0) };
      }
      // A read error (permissions, ELOOP) must not break the edit — skip the
      // snapshot and let the caller fall back to the reconstruct/HEAD ladder.
      return null;
    }
  }

  /**
   * Enforce the per-session byte budget by dropping the OLDEST baselines until
   * under {@link DIFF.MAX_SESSION_BASELINE_BYTES}. An evicted file's later diff
   * resolves via the HEAD/empty rung, which the client discloses — bounded
   * memory costs fidelity, never safety.
   */
  private evictToBudget(forSession: SessionBaselines): void {
    if (forSession.totalBytes <= this.maxSessionBytes) return;
    const oldestFirst = [...forSession.entries.entries()].sort(
      (a, b) => a[1].capturedAt - b[1].capturedAt
    );
    for (const [absPath, baseline] of oldestFirst) {
      if (forSession.totalBytes <= this.maxSessionBytes) break;
      forSession.entries.delete(absPath);
      forSession.totalBytes -= baseline.bytes.byteLength;
    }
  }
}

/** Process-wide singleton — the capture wiring, routes, and in-process transport share it. */
export const editBaselineStore = new EditBaselineStore();
