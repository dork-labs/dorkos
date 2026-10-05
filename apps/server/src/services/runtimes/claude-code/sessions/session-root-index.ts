/**
 * Which Claude account a given session lives under.
 *
 * An operator can run several Claude Code accounts, each one a config directory
 * with its own `projects/` transcripts and its own `todos/` sidecars (spec
 * `claude-code-accounts`). A session belongs permanently to exactly one of them:
 * its transcript exists under that root and nowhere else, so that root is also
 * the only one that can resume it. Nothing records the pairing — the filesystem
 * is the record (D3) — so a read holding only a session id has to look.
 *
 * This module is that lookup. It probes {@link resolveClaudeRootSet} in order,
 * first match wins, and remembers the winner so a repeated read (incremental
 * transcript sync, todo polling) does not re-probe every account. What it
 * memoizes is only WHICH ROOT, never whether the file is still there: callers
 * re-read the resolved path, so a deleted transcript or todo file still reads as
 * absent.
 *
 * @module services/runtimes/claude-code/sessions/session-root-index
 */
import fs from 'fs/promises';
import path from 'path';
import { resolveClaudeRootSet } from '../claude-config-dir.js';

/**
 * The Claude root a transcript at `<root>/projects/<slug>/<id>.jsonl` lives
 * under — three path segments up, which is the SDK's layout and therefore
 * structural rather than a guess.
 *
 * Derived from the path the caller already resolved, so listing pays nothing to
 * tag a session with its account: no extra syscall, no config read, and the
 * spelling matches the root the caller enumerated from (after `path.join`
 * normalizes any trailing separator).
 *
 * @param transcriptPath - Absolute path of a `{root}/projects/{slug}/{id}.jsonl` file.
 * @returns The account's absolute config directory.
 */
export function accountForTranscript(transcriptPath: string): string {
  return path.dirname(path.dirname(path.dirname(transcriptPath)));
}

/**
 * Memoizing session → Claude-root resolver.
 *
 * One instance per {@link TranscriptReader}; its memo is cleared alongside the
 * reader's metadata cache, since both are answers about a set of accounts that
 * an account switch changes.
 */
export class SessionRootIndex {
  /**
   * Probe key → winning root. Only HITS are stored (a miss may become a hit).
   *
   * Keys join their parts with `\0`, which no path segment can contain, so two
   * different probes can never collide. Always spell it as the two-character
   * ESCAPE: a raw U+0000 in the source makes git classify this file as binary,
   * and GitHub then renders it as "Binary file not shown" — hiding a core module
   * from review.
   */
  private roots = new Map<string, string>();

  /**
   * Forget every remembered root. Called when the account set itself may have
   * changed, which is the only thing that can move an answer here.
   */
  clear(): void {
    this.roots.clear();
  }

  /**
   * The account holding this session's transcript.
   *
   * @param slug - Project slug of the session's working directory.
   * @param sessionId - SDK session id.
   * @returns The account's config directory, or undefined when no account has it.
   */
  async forTranscript(slug: string, sessionId: string): Promise<string | undefined> {
    // The slug is part of the key so a hit still means "the transcript is under
    // THIS project", which is what the existence probes downstream promise.
    return this.find(
      `transcript\0${slug}\0${sessionId}`,
      path.join('projects', slug, `${sessionId}.jsonl`)
    );
  }

  /**
   * The account holding this session's SDK todo file. Needs no slug — todos are
   * flat under `<root>/todos/` — which is why a session id alone can find them.
   *
   * @param sessionId - SDK session id.
   * @returns The account's config directory, or undefined when no account has it.
   */
  async forTodoFile(sessionId: string): Promise<string | undefined> {
    return this.find(`todo\0${sessionId}`, path.join('todos', `${sessionId}.json`));
  }

  /**
   * First root in the set that holds `relativePath`, memoized under `cacheKey`.
   *
   * ## Why a MISS is deliberately not remembered
   *
   * A miss is not a durable fact. The commonest miss by far is a session's todo
   * file, which does not exist when the session starts and appears the moment the
   * agent writes its first plan — so a negative memo would mean that plan never
   * shows up for the session the operator is watching. Only hits are stored,
   * because only a hit is permanent (a transcript never moves between accounts).
   *
   * The cost of re-probing is bounded and small: per call, one `statSync` and one
   * `access` per REGISTERED account (one on a default install, three on the
   * operator's machine), on a path that goes on to read a file anyway. What it
   * buys is a todo list that appears when it is written rather than after a cache
   * expiry, which is the trade this reader is for.
   */
  private async find(cacheKey: string, relativePath: string): Promise<string | undefined> {
    const remembered = this.roots.get(cacheKey);
    if (remembered !== undefined) return remembered;
    // Possibly empty: an account with no `projects/` is excluded even when it is
    // the active one, so a freshly authenticated machine has no roots to probe.
    // That is "no sessions", not an error (spec §9).
    for (const root of resolveClaudeRootSet()) {
      try {
        await fs.access(path.join(root, relativePath));
      } catch {
        continue;
      }
      this.roots.set(cacheKey, root);
      return root;
    }
    return undefined;
  }
}

/**
 * Whether any account already holds a transcript named `sessionId`, in ANY
 * project folder.
 *
 * Asked before a new session is launched under the id DorkOS handed out
 * (DOR-2712). The per-folder probe can miss a transcript a conversation left
 * in another folder (it moved, or the caller named another cwd), and launching
 * under an id already on disk would give two transcripts one id. A taken id is
 * left to the SDK, which mints its own.
 *
 * Walks every project folder of every registered account: a few hundred
 * `access` calls on a cold launch, the only time it is asked. An account or
 * folder that cannot be read counts as not holding it.
 *
 * @param sessionId - The id a new session would launch under.
 */
export async function transcriptIdTaken(sessionId: string): Promise<boolean> {
  for (const root of resolveClaudeRootSet()) {
    const projectsRoot = path.join(root, 'projects');
    let slugs: string[];
    try {
      slugs = await fs.readdir(projectsRoot);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      try {
        await fs.access(path.join(projectsRoot, slug, `${sessionId}.jsonl`));
        return true;
      } catch {
        // Not in this folder.
      }
    }
  }
  return false;
}
