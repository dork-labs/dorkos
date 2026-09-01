import fs from 'fs/promises';
import path from 'path';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type {
  Session,
  PermissionMode,
  HistoryMessage,
  HistoryToolCall,
  TaskItem,
  SessionListWarning,
} from '@dorkos/shared/types';
import {
  parseTranscript,
  extractTextContent,
  isPersonAuthoredUserRecord,
  stripSystemTags,
} from './transcript-parser.js';
import type { TranscriptImageRef, TranscriptLine } from './transcript-parser.js';
import { classifyOrigin } from './classify-origin.js';
import { deriveSessionTitle } from '../../shared/derive-title.js';
import { projectSlug } from './project-slug.js';
import { parseTasks } from './task-reader.js';
import { SessionRootIndex, accountForTranscript } from './session-root-index.js';
import { sumContextTokens } from '../sdk/context-tokens.js';
import { resolveActiveClaudeRoot, resolveClaudeRootSet } from '../claude-config-dir.js';
import { TRANSCRIPT } from '../../../../config/constants.js';
// The DorkHome-aware seam: a session's transcript is keyed off its working
// directory, which for the system agent (DorkBot) and marketplace agents is
// {dorkHome}/agents/* — legitimately outside a narrow DORKOS_BOUNDARY. Reading
// those transcripts (snapshot/hydration/live-follow) must not 403, so this
// session-transcript surface uses the agents-subtree seam. It still rejects
// dork-home siblings like the encrypted credential store and boundary-external paths.
import { validateBoundaryOrDorkHome } from '../../../../lib/boundary.js';
import { dropUserLastMessageAtWithoutOperator } from '../../../session/origin/user-last-message-origin.js';
import { logger } from '../../../../lib/logger.js';

export type { HistoryMessage, HistoryToolCall };

/**
 * Translate the permission mode the SDK recorded in a transcript into the
 * DorkOS mode a session row reports, or `undefined` when the value is not one
 * this build knows.
 *
 * Every mode Claude Code declares needs its own entry here. A missing arm does
 * not fail loudly — it silently reports a permissive session as `default`, so
 * the list tells the operator a session is prompting on every tool while it is
 * really running unattended. `dangerously-skip` is the SDK's older spelling of
 * `bypassPermissions` and still appears in transcripts written by older CLIs.
 */
function normalizeTranscriptPermissionMode(sdkMode: string): PermissionMode | undefined {
  switch (sdkMode) {
    case 'bypassPermissions':
    case 'dangerously-skip':
      return 'bypassPermissions';
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'auto':
      return 'auto';
    case 'dontAsk':
      return 'dontAsk';
    case 'default':
      return 'default';
    default:
      return undefined;
  }
}

/**
 * Single source of truth for session data — reads SDK JSONL transcript files
 * from `{claudeRoot}/projects/{slug}/`, where `claudeRoot` is a Claude Code
 * account's config directory (`~/.claude` by default; see
 * {@link resolveActiveClaudeRoot}).
 *
 * Reads span EVERY account the operator has, not just the active one (spec
 * `claude-code-accounts`). Listing unions the accounts and tags each session
 * with the one it came from; a read that holds only a session id finds its
 * account through {@link SessionRootIndex}. What a NEW session runs on — the
 * active account — is a separate question, and the only place this class asks it
 * is the fallback path for a session that does not exist yet.
 *
 * Provides session listing, metadata extraction, full message history parsing,
 * task state reconstruction, and incremental byte-offset reading for sync.
 * Uses a metadata cache keyed by file mtime to avoid re-parsing unchanged files.
 */
export class TranscriptReader {
  /**
   * Extracted metadata per session id, valid while the transcript it came from is
   * unchanged. `filePath` is part of the validity check, not just the mtime:
   * session ids are unique to one account in practice, but the key here is the
   * bare id, so a hit from a DIFFERENT account's file would report that account's
   * metadata for this one. Comparing the path makes the collision a cache miss
   * rather than a wrong answer, and costs a string compare on the hot path.
   */
  private metaCache = new Map<
    string,
    { session: Session; mtimeMs: number; hidden: boolean; filePath: string }
  >();

  /**
   * Session → owning Claude account. Memoized, and cleared together with
   * {@link metaCache} because both are answers about the current account set.
   */
  private rootIndex = new SessionRootIndex();

  /**
   * Drop the cached metadata for a session so the next listSessions/getSession
   * re-extracts it. Called after a rename so the SDK-persisted title surfaces
   * immediately, even when the rename does not change the transcript's mtime.
   */
  invalidate(sessionId: string): void {
    this.metaCache.delete(sessionId);
  }

  /**
   * Drop EVERY cached answer — session metadata and remembered accounts alike.
   *
   * For when the set of accounts itself changes: after a switch, a session's
   * account can be one this reader has never probed, and a row cached under the
   * old set carries the old account. Per-session {@link invalidate} cannot
   * express that, since the change is not about any one session.
   */
  invalidateAll(): void {
    this.metaCache.clear();
    this.rootIndex.clear();
  }

  /**
   * The SDK project-slug naming this working directory's transcript folder.
   *
   * Delegates to {@link projectSlug}, which mirrors the SDK's computation
   * exactly — including the `realpath`, NFC and 200-character-truncation
   * clauses this used to omit (DOR-782). Omitting them was silent: a symlinked
   * checkout, a decomposed-Unicode path, or a path past 200 characters produced
   * a directory name that does not exist, so the session cold-started instead
   * of resuming.
   */
  getProjectSlug(cwd: string): string {
    return projectSlug(cwd);
  }

  /**
   * The ACTIVE account's projects root (`{activeRoot}/projects`) holding one
   * slug directory per working directory.
   *
   * Where a session that does not exist yet would be written. Reads enumerate
   * {@link getProjectsRootSet} instead — an existing session may live under any
   * account, not just this one.
   */
  getProjectsRoot(): string {
    return path.join(resolveActiveClaudeRoot(), 'projects');
  }

  /**
   * Every account's projects root, active first — what the fleet-wide
   * session-list watcher watches and what listing enumerates.
   *
   * Possibly EMPTY: an account with no `projects/` is excluded even when it is
   * the active one, so a machine where Claude Code has never run has nothing to
   * enumerate. That is "no sessions", never an error (spec §9).
   */
  getProjectsRootSet(): string[] {
    return resolveClaudeRootSet().map((root) => path.join(root, 'projects'));
  }

  /**
   * Resolve the ACTIVE account's transcripts directory for a given vault root.
   * The write-side answer, and the fallback for a transcript no account holds.
   */
  getTranscriptsDir(vaultRoot: string): string {
    return path.join(this.getProjectsRoot(), this.getProjectSlug(vaultRoot));
  }

  /**
   * Locate a session's transcript across every account.
   *
   * @returns The transcript path and the account holding it, or null when none does.
   */
  private async locateTranscript(
    vaultRoot: string,
    sessionId: string
  ): Promise<{ filePath: string; root: string } | null> {
    const slug = this.getProjectSlug(vaultRoot);
    const root = await this.rootIndex.forTranscript(slug, sessionId);
    if (root === undefined) return null;
    return { root, filePath: path.join(root, 'projects', slug, `${sessionId}.jsonl`) };
  }

  /**
   * The path to read a session's transcript from: the account that holds it,
   * else the active account's slug dir so the caller's own ENOENT handling
   * reports the session as absent exactly as it did before multi-account.
   */
  private async transcriptPath(vaultRoot: string, sessionId: string): Promise<string> {
    const located = await this.locateTranscript(vaultRoot, sessionId);
    return located?.filePath ?? path.join(this.getTranscriptsDir(vaultRoot), `${sessionId}.jsonl`);
  }

  /**
   * Check whether a JSONL transcript exists for the given session ID, in ANY
   * account, and report which account that is. Lightweight stat-only check (no
   * parsing). Skips boundary validation since the caller is expected to have
   * already validated.
   *
   * Returns the account as well as the verdict because the probe has to resolve
   * it either way and the caller needs it: `SessionStore.ensureForMessage` binds
   * it onto the live session as `accountRoot`, which is how a resumed turn runs
   * on the account that created the session instead of whichever is active. A
   * second method would mean a second walk of the accounts for one answer.
   *
   * @returns `exists`, plus `root` — the owning account — when it does.
   */
  async hasTranscript(
    vaultRoot: string,
    sessionId: string
  ): Promise<{ exists: boolean; root?: string }> {
    const located = await this.locateTranscript(vaultRoot, sessionId);
    return located ? { exists: true, root: located.root } : { exists: false };
  }

  /**
   * List all sessions by scanning SDK JSONL transcript files.
   * Extracts metadata (title, timestamps, preview) from file content and stats.
   *
   * The warnings-dropping form of {@link listSessionsAcrossAccounts} — use that
   * one where a partially-read list must be reported as partial.
   */
  async listSessions(vaultRoot: string): Promise<Session[]> {
    return (await this.listSessionsAcrossAccounts(vaultRoot)).sessions;
  }

  /**
   * List this project's sessions from EVERY Claude account, and report the
   * accounts that could not be read.
   *
   * The union is the point: with three accounts registered, a list covering only
   * the active one shows a fraction of the history and looks exactly like a
   * complete list. Each session is tagged with the account it came from
   * (`Session.account`), set during extraction from the path it was found at.
   *
   * Degrades per account (spec AC6): an account whose slug dir is simply absent
   * contributes nothing and says nothing — the normal case for a project that
   * account has never worked on. An account that exists but cannot be READ
   * (permissions, I/O) contributes one warning and zero sessions, and never
   * fails the call, so the accounts that DO read still list.
   *
   * Every returned session carries a cwd: a transcript whose head records carry
   * none (oversized or unparseable first lines) is attributed to the project
   * directory it was listed from — its own slug dir — so exact-match cwd scoping
   * downstream can never orphan it (ADR 260707-193314). Copies, never mutates:
   * the shared metaCache also serves the fleet-wide watcher, which has no
   * vaultRoot to attribute with.
   */
  async listSessionsAcrossAccounts(
    vaultRoot: string
  ): Promise<{ sessions: Session[]; warnings: SessionListWarning[] }> {
    await validateBoundaryOrDorkHome(vaultRoot);
    const slug = this.getProjectSlug(vaultRoot);
    const sessions: Session[] = [];
    const warnings: SessionListWarning[] = [];
    const seen = new Set<string>();

    for (const projectsRoot of this.getProjectsRootSet()) {
      try {
        const found = await this.listSessionsInDir(path.join(projectsRoot, slug));
        for (const session of found) {
          // One row per id, first account (the active one) wins. Real machines
          // never produce a collision — ids are UUIDs and each transcript exists
          // under one account — but a duplicated id must not reach clients as two
          // rows claiming to be the same session, and this is also the order every
          // single-session read resolves in (SessionRootIndex, active first), so
          // the row and the session it opens agree.
          if (seen.has(session.id)) continue;
          seen.add(session.id);
          sessions.push(session.cwd === undefined ? { ...session, cwd: vaultRoot } : session);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const account = path.dirname(projectsRoot);
        logger.warn('[TranscriptReader] account listing degraded', { projectsRoot, error: reason });
        warnings.push({
          runtime: 'claude-code',
          // Every warning from this loop carries the same `runtime`, so the
          // account is the only thing that distinguishes two of them. It travels
          // as its own field rather than only inside the sentence, because the
          // sidebar keys and names its notices by it (spec §Consequence for the
          // UI); a reader must be able to see WHICH account failed without
          // parsing a message.
          account,
          message: `Claude account ${account} could not be read: ${reason}`,
        });
      }
    }

    // One ordering across the union — each account's own sort is only per-account.
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions, warnings };
  }

  /**
   * List the sessions in one slug directory under {@link getProjectsRoot}.
   * Used directly by the fleet-wide session-list watcher, which enumerates
   * slug dirs from the filesystem (no user-supplied path → no boundary check);
   * each session's true working directory comes from its JSONL head, not the
   * lossy slug.
   *
   * Filters out two classes of noise before returning: whole-file sidechain
   * (subagent) transcripts, and empty transcripts that carry no `user`/
   * `assistant` record (queue-operation/mode/title bookkeeping only) — see
   * {@link extractSessionMeta} for how `hidden` is decided. Hidden entries are
   * still cached under their mtime so a later edit (e.g. gaining a real user
   * message) is picked up on the next mtime change; only the returned array
   * excludes them. {@link getSession} is unaffected — fetching a hidden
   * session by id still returns it.
   *
   * An absent directory lists as `[]`, which is load-bearing in two places: a
   * project an account has never worked on contributes nothing to the union, and
   * the watcher's `unlinkDir` rescan needs an empty listing to emit the
   * `session_removed` events for a slug dir that just disappeared. Any OTHER
   * read failure THROWS, so a directory that exists but cannot be read is
   * reported rather than silently downgraded to "no sessions here" — the caller
   * turns it into a warning (spec AC6), and the watcher's rescan logs it instead
   * of announcing every session in that project as removed.
   *
   * @param transcriptsDir - Absolute path of a `{claudeRoot}/projects/{slug}` dir.
   */
  async listSessionsInDir(transcriptsDir: string): Promise<Session[]> {
    let files: string[];
    try {
      files = (await fs.readdir(transcriptsDir)).filter((f) => f.endsWith('.jsonl'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const sessions: Session[] = [];

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(transcriptsDir, file);

      try {
        const fileStat = await fs.stat(filePath);
        const cached = this.metaCache.get(sessionId);
        if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.filePath === filePath) {
          if (!cached.hidden) sessions.push(cached.session);
          continue;
        }
        const { session, hidden } = await this.extractSessionMeta(filePath, sessionId, fileStat);
        this.metaCache.set(sessionId, { session, mtimeMs: fileStat.mtimeMs, hidden, filePath });
        if (!hidden) sessions.push(session);
      } catch {
        // Skip unreadable files
      }
    }

    // Sort by updatedAt descending (most recent first)
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions;
  }

  /**
   * Get metadata for a single session. Both the head (title/timestamps) and the
   * tail (latest model/context/auto-compaction) are read inside
   * {@link extractSessionMeta} — the single tail-read path shared with the list.
   *
   * Unfiltered by design: unlike {@link listSessionsInDir}, a sidechain or
   * empty transcript is still returned when fetched directly by id — those
   * are list-noise, not invalid sessions.
   */
  async getSession(vaultRoot: string, sessionId: string): Promise<Session | null> {
    await validateBoundaryOrDorkHome(vaultRoot);
    const filePath = await this.transcriptPath(vaultRoot, sessionId);
    try {
      const { session } = await this.extractSessionMeta(filePath, sessionId);
      // Attribute a head-record-less transcript to the directory it was
      // fetched from — same rule as listSessions (ADR 260707-193314).
      if (session.cwd === undefined) session.cwd = vaultRoot;
      return session;
    } catch {
      return null;
    }
  }

  /**
   * Read the tail of a JSONL file to get the most recent model, permissionMode,
   * context tokens, auto-compaction marker, and the time the person last wrote.
   * Reads the last {@link TRANSCRIPT.TAIL_BUFFER_BYTES} (64 KB), which holds the
   * final assistant messages, any recent `compact_boundary` record, and — for
   * ~90% of conversations touched in the last week — the person's own last turn.
   *
   * `userLastMessageAt` rides this SAME pass on purpose: the session list is
   * read on every cockpit boot, and re-reading transcripts to answer "when did
   * the person last write" would turn a bounded tail read into a whole-file
   * scan per session. The cost of the extra answer is one
   * {@link isPersonAuthoredUserRecord} call per `user` record already parsed
   * here — no additional open, read, or stat.
   *
   * @param filePath - Absolute path of the transcript file.
   * @param fileSize - The transcript's byte size from the caller's existing
   *   `fs.stat` — threaded in so the tail read adds no second stat syscall
   *   (the sole caller, {@link extractSessionMeta}, already holds the stat).
   */
  private async readTailStatus(
    filePath: string,
    fileSize: number
  ): Promise<{
    model?: string;
    permissionMode?: PermissionMode;
    contextTokens?: number;
    lastAutoCompactAt?: string;
    userLastMessageAt?: string;
  }> {
    const TAIL_SIZE = TRANSCRIPT.TAIL_BUFFER_BYTES;
    try {
      const fileHandle = await fs.open(filePath, 'r');
      try {
        const readOffset = Math.max(0, fileSize - TAIL_SIZE);
        const buffer = Buffer.alloc(Math.min(TAIL_SIZE, fileSize));
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, readOffset);
        const chunk = buffer.toString('utf-8', 0, bytesRead);
        const lines = chunk.split('\n').filter((l) => l.trim());

        let model: string | undefined;
        let permissionMode: PermissionMode | undefined;
        let contextTokens: number | undefined;
        let lastAutoCompactAt: string | undefined;
        let userLastMessageAt: string | undefined;

        // Iterate forward — last occurrence wins
        for (const line of lines) {
          let parsed: TranscriptLine;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (parsed.type === 'assistant' && parsed.message?.model) {
            model = parsed.message.model;
            if (parsed.message.usage) {
              const u = parsed.message.usage;
              contextTokens = sumContextTokens({
                inputTokens: u.input_tokens,
                cacheReadTokens: u.cache_read_input_tokens,
                cacheCreationTokens: u.cache_creation_input_tokens,
              });
            }
          }
          if (parsed.type === 'user' && parsed.permissionMode) {
            // An unrecognized mode degrades to the SAFEST posture, never a
            // permissive one.
            permissionMode = normalizeTranscriptPermissionMode(parsed.permissionMode) ?? 'default';
          }
          // When the PERSON last wrote (BC-16). A record with no timestamp is
          // skipped rather than dated from the file's mtime — that would be
          // `updatedAt` wearing this field's name.
          if (parsed.timestamp && isPersonAuthoredUserRecord(parsed)) {
            userLastMessageAt = parsed.timestamp;
          }
          // Auto-triggered compaction is a context-pressure signal; a manual
          // compaction is user-driven and deliberately ignored. The top-level
          // record timestamp is the marker's "as of" time.
          if (
            parsed.type === 'system' &&
            parsed.subtype === 'compact_boundary' &&
            parsed.compactMetadata?.trigger === 'auto' &&
            parsed.timestamp
          ) {
            lastAutoCompactAt = parsed.timestamp;
          }
        }

        return { model, permissionMode, contextTokens, lastAutoCompactAt, userLastMessageAt };
      } finally {
        await fileHandle.close();
      }
    } catch {
      return {};
    }
  }

  /**
   * Extract session metadata from a JSONL file. Reads the first ~8KB for
   * title/permissionMode/timestamps, then folds in a single tail read (64KB)
   * so both the list path and {@link getSession} carry the latest model, a
   * best-effort `contextTokens` reading, any auto-compaction marker, and the
   * time the person last wrote — the enriched result is what
   * {@link listSessionsInDir} caches under the file mtime, so an unchanged
   * transcript pays for neither read again.
   *
   * Also decides `hidden`, the list-noise verdict {@link listSessionsInDir}
   * filters on: true when the transcript is a whole-file sidechain (subagent)
   * recording, or when it is provably empty of real conversation — the entire
   * file fit inside the head read and none of its lines were a `user`/
   * `assistant` record. The size check is what makes emptiness provable: a
   * transcript whose first user message sits beyond the head buffer is never
   * hidden, protecting the oversized-head sessions attributed by ADR
   * 260707-193314.
   */
  private async extractSessionMeta(
    filePath: string,
    sessionId: string,
    fileStat?: Awaited<ReturnType<typeof fs.stat>>
  ): Promise<{ session: Session; hidden: boolean }> {
    const stat = fileStat ?? (await fs.stat(filePath));

    // Read only the head of the file (8KB) — metadata is always in the first few lines
    const fileHandle = await fs.open(filePath, 'r');
    let chunk: string;
    try {
      const buffer = Buffer.alloc(TRANSCRIPT.HEAD_BUFFER_BYTES);
      const { bytesRead } = await fileHandle.read(buffer, 0, TRANSCRIPT.HEAD_BUFFER_BYTES, 0);
      chunk = buffer.toString('utf-8', 0, bytesRead);
    } finally {
      await fileHandle.close();
    }

    const lines = chunk.split('\n').filter((l) => l.trim());

    let firstUserMessage = '';
    let firstRawUserMessage = '';
    let permissionMode: PermissionMode = 'default';
    let firstTimestamp = '';
    let model: string | undefined;
    let cwd: string | undefined;
    // List-noise detection (see the hidden-verdict TSDoc above).
    let sawConversation = false;
    let sawFirstConversationLine = false;
    let sidechain = false;

    for (const line of lines) {
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.type === 'user' || parsed.type === 'assistant') {
        sawConversation = true;
        if (!sawFirstConversationLine) {
          sidechain = parsed.isSidechain === true;
          sawFirstConversationLine = true;
        }
      }

      // Extract permission mode from init message or user messages
      if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.permissionMode) {
        // Init only ever RAISES what we know: an unrecognized value leaves the
        // running answer alone rather than overwriting it with a guess.
        const initMode = normalizeTranscriptPermissionMode(parsed.permissionMode);
        if (initMode) permissionMode = initMode;
      }
      if (parsed.type === 'user' && parsed.permissionMode) {
        // A user record is the authoritative per-turn mode; an unrecognized one
        // degrades to the SAFEST posture, never a permissive one.
        permissionMode = normalizeTranscriptPermissionMode(parsed.permissionMode) ?? 'default';
      }

      // Extract model from assistant messages
      if (!model && parsed.type === 'assistant' && parsed.message?.model) {
        model = parsed.message.model;
      }

      // Extract timestamps
      if (parsed.timestamp && !firstTimestamp) {
        firstTimestamp = parsed.timestamp;
      }

      // Extract cwd (before title extraction — the continue statements below skip the rest of the loop)
      if (!cwd && parsed.cwd) {
        cwd = parsed.cwd;
      }

      // Extract first user message for title
      if (!firstUserMessage && parsed.type === 'user' && parsed.message) {
        const text = extractTextContent(parsed.message.content);
        if (!firstRawUserMessage) {
          firstRawUserMessage = text;
        }
        if (
          text.startsWith('<local-command') ||
          text.startsWith('<command-name>') ||
          text.startsWith('<command-message>') ||
          text.startsWith('<task-notification>') ||
          text.startsWith('<dorkos-system-note>') ||
          text.startsWith('<relay_context>')
        ) {
          continue;
        }
        if (text.startsWith('This session is being continued')) {
          continue;
        }
        const cleanText = stripSystemTags(text);
        if (!cleanText.trim()) continue;

        firstUserMessage = cleanText.trim();
      }

      // Once we have all head metadata, stop early
      if (firstUserMessage && firstTimestamp && model && cwd) break;
    }

    const derivedTitle =
      deriveSessionTitle(firstUserMessage) ||
      `Session ${sessionId.slice(0, TRANSCRIPT.SESSION_ID_PREVIEW_LENGTH)}`;
    // Which Claude account this session belongs to: the root the file was found
    // under, read straight off the path — no syscall, no config read. Resolved
    // here rather than at the assignment below because the SDK title lookup is
    // gated on it (see `resolveSdkTitle`).
    const account = accountForTranscript(filePath);
    // The Claude Agent SDK is the source of truth for session titles (set at
    // creation, via renameSession, or auto-generated). Prefer the persisted
    // title; fall back to the first-message derivation for untitled sessions.
    const title = (await this.resolveSdkTitle(sessionId, cwd, account)) ?? derivedTitle;
    const { origin, originLabel } = classifyOrigin(firstRawUserMessage);

    const session: Session = {
      id: sessionId,
      title,
      createdAt: firstTimestamp || stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      lastMessagePreview: undefined,
      permissionMode,
      runtime: 'claude-code',
      model,
      origin,
      originLabel,
      cwd,
    };

    // Fold in the tail read: the latest model overlays the head's, and a
    // best-effort context reading + auto-compaction marker ride onto the row.
    // Absent tail values leave the head-derived fields untouched and the
    // optional reading fields unset (an honest "unknown" downstream). The
    // already-known stat size is threaded in so the tail adds one open, not
    // an open plus a redundant stat. (`Number()` collapses the BigIntStats
    // union from the fileStat parameter's `ReturnType<typeof fs.stat>` type;
    // transcripts are far below Number.MAX_SAFE_INTEGER.)
    const tailStatus = await this.readTailStatus(filePath, Number(stat.size));
    if (tailStatus.model) session.model = tailStatus.model;
    if (tailStatus.permissionMode) session.permissionMode = tailStatus.permissionMode;
    if (tailStatus.contextTokens) session.contextTokens = tailStatus.contextTokens;
    if (tailStatus.lastAutoCompactAt) session.lastAutoCompactAt = tailStatus.lastAutoCompactAt;
    if (tailStatus.userLastMessageAt) session.userLastMessageAt = tailStatus.userLastMessageAt;
    // …and take it straight back off a session no operator ever wrote in. An
    // agent hand-off's or a scheduled run's prompt reaches the transcript as
    // plain user text with nothing in the record to mark it, so the session's
    // own origin is what answers (BC-16). The `room` case has no transcript
    // marker at all and is handled by the route overlay that knows the binding.
    dropUserLastMessageAtWithoutOperator(session);

    // Set conditionally like the readings above, so an unattributable path leaves
    // the field absent (an honest "unknown") rather than carrying a derived guess.
    if (account) session.account = account;

    // Provably empty means the whole file fit in the head read and still had
    // no conversation — a larger transcript's user message could simply live
    // past the head buffer, so size is what turns "none found" into "none
    // exist" (see the TSDoc above; ADR 260707-193314).
    const provablyEmpty = Number(stat.size) <= TRANSCRIPT.HEAD_BUFFER_BYTES && !sawConversation;
    const hidden = sidechain || provablyEmpty;

    return { session, hidden };
  }

  /**
   * Read the SDK-persisted custom title for a session, if one exists — and only
   * for a session on the ACTIVE account.
   *
   * The Claude Agent SDK owns session titles and persists them across restarts,
   * so we read the stored value rather than derive and overlay our own. Returns
   * undefined when the SDK has no custom title — untitled sessions then keep the
   * first-message derivation, which filters slash-commands and system tags more
   * carefully than the SDK's raw first prompt.
   *
   * ## The account gate is a chosen, bounded degradation, not an oversight
   *
   * `getSessionInfo` runs IN-PROCESS and its options carry no config dir, so the
   * only way to read a title from a NON-active account is the same env lock
   * rename and fork use — mutating `process.env.CLAUDE_CONFIG_DIR`
   * process-globally. This call sits on the session-LISTING path, once per
   * session per mtime change, so wrapping it would serialize every listing behind
   * a process-global mutation: a systemic risk traded for a cosmetic gain (spec
   * D8).
   *
   * So the honest consequence, written down rather than hidden: a custom title
   * you set on account B may not display while account A is active — that
   * session shows its first-message derivation instead. The alternative was
   * reverse-engineering the SDK's title sidecar, which is exactly the
   * implementation-detail dependency D4 refuses.
   *
   * @param sessionId - SDK session UUID
   * @param cwd - The session's working directory; scopes the lookup to one project
   * @param account - The account the transcript was found under; the lookup is
   *   skipped unless it is the active one.
   */
  private async resolveSdkTitle(
    sessionId: string,
    cwd: string | undefined,
    account: string
  ): Promise<string | undefined> {
    if (!cwd) return undefined;
    if (path.resolve(account) !== path.resolve(resolveActiveClaudeRoot())) return undefined;
    try {
      const info = await getSessionInfo(sessionId, { dir: cwd });
      return info?.customTitle?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Read messages from an SDK session transcript.
   *
   * @param vaultRoot - The session's working directory.
   * @param sessionId - SDK session UUID.
   * @param images - Collects the images tool results carried, for the caller to
   *   resolve through the attachment store. This class stays a JSONL parser and
   *   learns nothing about where DorkOS keeps bytes — the same division that
   *   keeps approval receipts out of here (see `getMessageHistory`).
   */
  async readTranscript(
    vaultRoot: string,
    sessionId: string,
    images?: TranscriptImageRef[]
  ): Promise<HistoryMessage[]> {
    await validateBoundaryOrDorkHome(vaultRoot);
    const filePath = await this.transcriptPath(vaultRoot, sessionId);

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return [];
    }

    const lines = content.split('\n').filter((l) => l.trim());
    return parseTranscript(lines, images);
  }

  /**
   * List available SDK session transcript IDs, across every account. Ids are
   * unique to one account, so the union needs no tie-breaking; it is deduplicated
   * anyway rather than relying on that.
   */
  async listTranscripts(vaultRoot: string): Promise<string[]> {
    await validateBoundaryOrDorkHome(vaultRoot);
    const slug = this.getProjectSlug(vaultRoot);
    const ids = new Set<string>();
    for (const projectsRoot of this.getProjectsRootSet()) {
      try {
        const files = await fs.readdir(path.join(projectsRoot, slug));
        for (const file of files) {
          if (file.endsWith('.jsonl')) ids.add(file.replace('.jsonl', ''));
        }
      } catch {
        // An account with no directory for this project, or one that cannot be
        // read, simply contributes no ids — same shape as before multi-account.
      }
    }
    return [...ids];
  }

  /** Get an ETag for a session transcript (mtime + size) for HTTP caching. */
  async getTranscriptETag(vaultRoot: string, sessionId: string): Promise<string | null> {
    await validateBoundaryOrDorkHome(vaultRoot);
    const filePath = await this.transcriptPath(vaultRoot, sessionId);
    try {
      const stat = await fs.stat(filePath);
      return `"${stat.mtimeMs}-${stat.size}"`;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the SDK todo file path for a given session ID, in the session's OWN
   * account.
   *
   * Todos are flat under `{claudeRoot}/todos/`, so a bare session id is enough to
   * find them — no working directory needed, which is what let this path stay
   * account-blind by signature (spec C1). Resolving it against the ACTIVE account
   * would silently serve another client's todo list, or none. Falls back to the
   * active account when no account holds the file, so a session with no todos
   * still reads as ENOENT exactly as before.
   */
  private async resolveTodoFilePath(sessionId: string): Promise<string> {
    const root = (await this.rootIndex.forTodoFile(sessionId)) ?? resolveActiveClaudeRoot();
    return path.join(root, 'todos', `${sessionId}.json`);
  }

  /**
   * Read task items from the SDK's dedicated todo file
   * (`{claudeRoot}/todos/{sessionId}.json`, in the session's own account).
   * Returns null when the file does not exist; throws on other filesystem errors.
   */
  async readTodosFromFile(sessionId: string): Promise<TaskItem[] | null> {
    let raw: string;
    try {
      raw = await fs.readFile(await this.resolveTodoFilePath(sessionId), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('[readTodosFromFile] malformed JSON in todo file', { sessionId });
      return null;
    }

    if (!Array.isArray(parsed)) {
      logger.warn('[readTodosFromFile] expected array in todo file', { sessionId });
      return null;
    }

    return parsed.map((entry: Record<string, unknown>, index: number) => ({
      id: (entry.id as string) ?? String(index + 1),
      subject: entry.content as string,
      status: ((entry.status as string) ?? 'pending') as TaskItem['status'],
      activeForm: entry.activeForm as string | undefined,
    }));
  }

  /** Get an ETag for a session's todo file (mtime + size) for HTTP caching. */
  async getTodoFileETag(sessionId: string): Promise<string | null> {
    try {
      const stat = await fs.stat(await this.resolveTodoFilePath(sessionId));
      return `"${stat.mtimeMs}-${stat.size}"`;
    } catch {
      return null;
    }
  }

  /**
   * Read task state — tries the SDK todo file first, falls back to JSONL transcript parsing.
   *
   * The todo-file path (`readTodosFromFile`, above) mints `id: String(index +
   * 1)` for any entry with no id of its own — a positional counter in the
   * same shape `task-reader.ts`'s `parseTasks` used to use before DOR-1441,
   * and the same failure class: it can drift from a real SDK task id.
   * Verified dormant today (`~/.claude{,2,3}/todos` do not exist on this
   * machine, so the JSONL fallback below — which DOES use the fixed
   * `parseTasks` — is what actually serves), but if that file reappears this
   * path reintroduces the drift undetected. Left as-is rather than refactored
   * here: fixing it belongs in its own reviewed change, same as the
   * account-routing note above.
   */
  async readTasks(vaultRoot: string, sessionId: string): Promise<TaskItem[]> {
    // File-first: SDK todo file is the authoritative source when present. The
    // boundary check below therefore does NOT gate this read — an ordering that
    // predates multi-account and is left exactly as it was, because reordering it
    // would change who can read a todo file and that belongs in its own reviewed
    // change. The path it reads is still fully derived (account root + session id),
    // never assembled from `vaultRoot`.
    const fileTasks = await this.readTodosFromFile(sessionId);
    if (fileTasks !== null) return fileTasks;

    // Fallback: parse TaskCreate/TaskUpdate tool_use blocks from JSONL transcript
    await validateBoundaryOrDorkHome(vaultRoot);
    const filePath = await this.transcriptPath(vaultRoot, sessionId);

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return [];
    }

    const lines = content.split('\n').filter((l) => l.trim());
    return parseTasks(lines);
  }

  /**
   * Read new content from a transcript file starting from a byte offset.
   * Returns the new content and the updated file size (new offset).
   */
  async readFromOffset(
    vaultRoot: string,
    sessionId: string,
    fromOffset: number
  ): Promise<{ content: string; newOffset: number }> {
    await validateBoundaryOrDorkHome(vaultRoot);
    const filePath = await this.transcriptPath(vaultRoot, sessionId);
    const stat = await fs.stat(filePath);

    if (stat.size <= fromOffset) {
      return { content: '', newOffset: fromOffset };
    }

    const fileHandle = await fs.open(filePath, 'r');
    try {
      const newBytes = stat.size - fromOffset;
      const buffer = Buffer.alloc(newBytes);
      await fileHandle.read(buffer, 0, newBytes, fromOffset);
      return {
        content: buffer.toString('utf-8'),
        newOffset: stat.size,
      };
    } finally {
      await fileHandle.close();
    }
  }
}
