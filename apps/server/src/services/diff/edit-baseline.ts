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
 * session's stream tears down. A restarted session has no baseline and falls back
 * to the git-HEAD / empty ladder — honest and safe, never a blind clobber.
 *
 * @module services/diff/edit-baseline
 */
import fs from 'node:fs/promises';
import { reconstructPreImage } from './reconstruct.js';

/** How a stored baseline's bytes were obtained. `'empty'` is a resolution-time origin, never stored. */
export type BaselineOrigin = 'pre-tool' | 'reconstructed' | 'head';

/** One file's captured pre-edit state for a session. */
export interface Baseline {
  /** The file's bytes as they were before this session's first edit (binary-safe). */
  bytes: Buffer;
  /** Server epoch ms the baseline was captured. */
  capturedAt: number;
  /** How the bytes were obtained (for diagnostics + the response's `capturedFrom`). */
  capturedFrom: BaselineOrigin;
}

/**
 * In-memory per-session pre-edit baseline store. First-touch-wins per
 * `(sessionId, absPath)`; binary-safe; cleared on session teardown.
 */
export class EditBaselineStore {
  /** `sessionId → (absPath → Baseline)`. */
  private readonly sessions = new Map<string, Map<string, Baseline>>();

  /**
   * Capture a file's current on-disk bytes as this session's baseline, unless one
   * already exists for the pair (first-touch-wins). Called at the runtime's pre-
   * tool boundary before an edit-family tool runs. A path that does not yet exist
   * on disk (a `Write` creating a new file) captures an EMPTY baseline, so the
   * whole file reads as added — the correct pre-image for a new file.
   *
   * @param sessionId - Session the edit belongs to.
   * @param absPath - Absolute path the agent is about to edit.
   * @returns `true` when a baseline now exists for the pair (captured here or
   *   already present), `false` when the disk read failed for a non-ENOENT
   *   reason so the caller may try the reconstruct fallback.
   */
  async captureFromDisk(sessionId: string, absPath: string): Promise<boolean> {
    if (this.has(sessionId, absPath)) return true;
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Write-first on a new file: its pre-image is empty.
        bytes = Buffer.alloc(0);
      } else {
        // A read error (permissions, ELOOP) must not break the edit — skip the
        // snapshot and signal the caller to try the reconstruct/HEAD ladder.
        return false;
      }
    }
    this.set(sessionId, absPath, { bytes, capturedAt: Date.now(), capturedFrom: 'pre-tool' });
    return true;
  }

  /**
   * Fallback capture (§Q1 Fallback A): reconstruct the pre-image by reverse-
   * applying an `Edit`/`MultiEdit` input against current disk and store it. Used
   * only when {@link captureFromDisk} could not snapshot (a runtime without a
   * synchronous pre-tool seam, or a post-restart miss). A no-op when a baseline
   * already exists, the file can't be read, or the input isn't reversible (e.g.
   * a `Write`) — the resolve ladder then falls through to HEAD / empty.
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
   * Store a baseline directly (used by the resolution ladder's reconstruct/HEAD
   * fallbacks to memoize a computed pre-image). First-touch-wins.
   *
   * @param sessionId - Session the baseline belongs to.
   * @param absPath - Absolute path keyed.
   * @param baseline - The pre-image bytes + origin.
   */
  set(sessionId: string, absPath: string, baseline: Baseline): void {
    let forSession = this.sessions.get(sessionId);
    if (!forSession) {
      forSession = new Map<string, Baseline>();
      this.sessions.set(sessionId, forSession);
    }
    if (forSession.has(absPath)) return;
    forSession.set(absPath, baseline);
  }

  /** Whether a baseline exists for the pair. */
  has(sessionId: string, absPath: string): boolean {
    return this.sessions.get(sessionId)?.has(absPath) ?? false;
  }

  /** The stored baseline for the pair, or `undefined` when none was captured. */
  get(sessionId: string, absPath: string): Baseline | undefined {
    return this.sessions.get(sessionId)?.get(absPath);
  }

  /**
   * Advance a file's baseline to its current on-disk bytes (finish-review), so
   * subsequent agent edits diff from the just-reviewed state. Overwrites any
   * existing baseline; a no-op when the session has no baseline for the path yet
   * (nothing has been captured to advance).
   *
   * @param sessionId - Session whose baseline to advance.
   * @param absPath - Absolute path to advance.
   */
  async advance(sessionId: string, absPath: string): Promise<void> {
    const forSession = this.sessions.get(sessionId);
    if (!forSession?.has(absPath)) return;
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        bytes = Buffer.alloc(0);
      } else {
        return;
      }
    }
    forSession.set(absPath, { bytes, capturedAt: Date.now(), capturedFrom: 'pre-tool' });
  }

  /**
   * List the session's tracked paths whose baseline differs from current disk —
   * i.e. files with unreviewed agent edits. Reads each file once; a path whose
   * baseline equals disk (already reverted/reviewed) is omitted.
   *
   * @param sessionId - Session to inspect.
   * @returns Absolute paths with pending (unreviewed) edits.
   */
  async listPending(sessionId: string): Promise<string[]> {
    const forSession = this.sessions.get(sessionId);
    if (!forSession) return [];
    const pending: string[] = [];
    for (const [absPath, baseline] of forSession) {
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
}

/** Process-wide singleton — the capture wiring, routes, and in-process transport share it. */
export const editBaselineStore = new EditBaselineStore();
