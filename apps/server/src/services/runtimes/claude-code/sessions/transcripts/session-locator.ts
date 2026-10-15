/**
 * Find a Claude Code session's transcript from its id alone.
 *
 * A read that holds only a session id (a shared link, a second window, the
 * durable event stream) has to learn which project folder the transcript lives
 * in. The filesystem is the only record, so the first answer is a walk of every
 * account's `projects/` folders — about two hundred folders on a busy machine,
 * once for each of the detail, history, tasks and stream reads a chat opens.
 *
 * This module makes that walk happen at most once per session:
 *
 * - **Remembered paths.** A transcript never moves once written, so the path a
 *   walk found stays right while the file exists. The memo is checked by
 *   reading the file, never trusted blind: a deleted transcript reads as absent
 *   and falls back to a fresh walk.
 * - **The caller's directory first.** When the caller named a directory
 *   (`?cwd=`), its project folder is checked in every account before any walk.
 *   The hint only says where to LOOK: the answer is still the directory the
 *   transcript records, so a stale or wrong hint cannot move a session.
 *
 * Ambiguity keeps its meaning where it can be seen cheaply. A walk refuses an id
 * found in two places, as before, and so does the hinted check when two accounts
 * hold the id under the same project. An id found once is remembered, and is not
 * re-walked to look for a later copy.
 *
 * @module services/runtimes/claude-code/sessions/transcripts/session-locator
 */
import fs from 'fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'path';
import type { Session } from '@dorkos/shared/types';
import { isWithinDirectory } from '@dorkos/shared/paths';
import { AmbiguousSessionError } from '../../../../session/resolution/session-lookup-error.js';
import { resolveClaudeRootSet } from '../../claude-config-dir.js';
import { projectSlug } from '../project-slug.js';
import { validateBoundaryOrDorkHome } from '../../../../../lib/boundary.js';

/** Session ids are SDK UUIDs; anything else cannot name a transcript file. */
const SESSION_ID = /^[a-f0-9-]{36}$/i;

/**
 * Reads a transcript's metadata. Must throw an `ENOENT` error for a missing
 * file and must return a COPY the locator may change.
 */
export type ReadSessionMeta = (filePath: string, sessionId: string) => Promise<Session>;

/** Options for {@link SessionLocator.find}. */
export interface FindSessionOptions {
  /** A directory the caller believes the session ran in. Searched first. */
  cwdHint?: string;
}

/** What the locator remembers about one session. */
interface Located {
  filePath: string;
  /** The directory found by scanning past the head, when the head had none. */
  scannedCwd?: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * The first `cwd` any record carries, for a transcript whose head read had
 * none (an oversized bookkeeping record can push it past the head buffer).
 */
async function scanForCwd(filePath: string): Promise<string | undefined> {
  const input = createReadStream(filePath);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof record?.cwd === 'string' && record.cwd) return record.cwd;
    }
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }
}

/** Remembering session-id → transcript resolver; one per transcript reader. */
export class SessionLocator {
  private readonly located = new Map<string, Located>();

  /**
   * Build a locator over a metadata reader.
   *
   * @param readMeta - Reads a transcript's metadata, see {@link ReadSessionMeta}.
   */
  constructor(private readonly readMeta: ReadSessionMeta) {}

  /** Forget every remembered path; for when the set of accounts changes. */
  clear(): void {
    this.located.clear();
  }

  /** How many sessions have a remembered path. For tests and diagnostics. */
  get size(): number {
    return this.located.size;
  }

  /**
   * Find a session by id: its remembered path, then the caller's directory,
   * then a walk of every account's project folders.
   *
   * @param sessionId - SDK session id.
   * @param options - An optional directory hint, see {@link FindSessionOptions}.
   * @returns The session with its recorded directory, or null when no account has it.
   * @throws AmbiguousSessionError when a walk or the hinted check finds two copies.
   */
  async find(sessionId: string, options: FindSessionOptions = {}): Promise<Session | null> {
    if (!SESSION_ID.test(sessionId)) return null;

    const roots = resolveClaudeRootSet();
    const remembered = this.located.get(sessionId);
    // A remembered path only answers while its account is still configured.
    if (remembered && roots.some((root) => isWithinDirectory(remembered.filePath, root))) {
      const session = await this.open(sessionId, remembered);
      if (session) return session;
    }
    this.located.delete(sessionId);

    if (options.cwdHint) {
      const slug = projectSlug(options.cwdHint);
      const hit = await this.settle(
        sessionId,
        roots.map((root) => path.join(root, 'projects', slug, `${sessionId}.jsonl`))
      );
      if (hit) return hit;
    }

    const candidates: string[] = [];
    for (const root of roots) {
      const projects = path.join(root, 'projects');
      let entries;
      try {
        entries = await fs.readdir(projects, { withFileTypes: true });
      } catch (error) {
        if (!isMissing(error)) throw error;
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          candidates.push(path.join(projects, entry.name, `${sessionId}.jsonl`));
        }
      }
    }
    return this.settle(sessionId, candidates);
  }

  /**
   * Open every candidate; remember and return the one hit, refuse two. Nothing
   * is remembered until every candidate is read, so a concurrent lookup cannot
   * take the fast path to one copy of an id that has two.
   */
  private async settle(sessionId: string, filePaths: string[]): Promise<Session | null> {
    const hits: { session: Session; located: Located }[] = [];
    for (const filePath of filePaths) {
      const located: Located = { filePath };
      const session = await this.open(sessionId, located);
      if (session) hits.push({ session, located });
    }
    if (hits.length > 1) throw new AmbiguousSessionError();
    const [hit] = hits;
    if (!hit) return null;
    this.located.set(sessionId, hit.located);
    return hit.session;
  }

  /**
   * Read one candidate transcript. Null when the file is missing or records no
   * directory; the boundary check runs on every answer, remembered or not.
   */
  private async open(sessionId: string, located: Located): Promise<Session | null> {
    let session: Session;
    try {
      session = await this.readMeta(located.filePath, sessionId);
      if (!session.cwd) {
        located.scannedCwd ??= await scanForCwd(located.filePath);
        session.cwd = located.scannedCwd;
      }
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!session.cwd) return null;
    await validateBoundaryOrDorkHome(session.cwd);
    return session;
  }
}
