import fs from 'fs/promises';
import path from 'path';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type {
  Session,
  PermissionMode,
  HistoryMessage,
  HistoryToolCall,
  TaskItem,
} from '@dorkos/shared/types';
import { parseTranscript, extractTextContent, stripSystemTags } from './transcript-parser.js';
import type { TranscriptLine } from './transcript-parser.js';
import { parseTasks } from './task-reader.js';
import { sumContextTokens } from '../sdk/context-tokens.js';
import { resolveClaudeConfigDir } from '../claude-config-dir.js';
import { TRANSCRIPT } from '../../../../config/constants.js';
import { validateBoundary } from '../../../../lib/boundary.js';
import { logger } from '../../../../lib/logger.js';

export type { HistoryMessage, HistoryToolCall };

/**
 * Single source of truth for session data — reads SDK JSONL transcript files
 * from `$CLAUDE_CONFIG_DIR/projects/{slug}/` (defaulting to
 * `~/.claude/projects/{slug}/`; see {@link resolveClaudeConfigDir}).
 *
 * Provides session listing, metadata extraction, full message history parsing,
 * task state reconstruction, and incremental byte-offset reading for sync.
 * Uses a metadata cache keyed by file mtime to avoid re-parsing unchanged files.
 */
export class TranscriptReader {
  private metaCache = new Map<string, { session: Session; mtimeMs: number }>();

  /**
   * Drop the cached metadata for a session so the next listSessions/getSession
   * re-extracts it. Called after a rename so the SDK-persisted title surfaces
   * immediately, even when the rename does not change the transcript's mtime.
   */
  invalidate(sessionId: string): void {
    this.metaCache.delete(sessionId);
  }

  /** Convert a working directory path to an SDK project slug (filesystem-safe). */
  getProjectSlug(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
  }

  /**
   * The SDK projects root (`$CLAUDE_CONFIG_DIR/projects`, defaulting to
   * `~/.claude/projects`) holding one slug directory per working directory.
   * The fleet-wide session-list watcher watches this root.
   */
  getProjectsRoot(): string {
    return path.join(resolveClaudeConfigDir(), 'projects');
  }

  /** Resolve the SDK transcripts directory for a given vault root. */
  getTranscriptsDir(vaultRoot: string): string {
    return path.join(this.getProjectsRoot(), this.getProjectSlug(vaultRoot));
  }

  /**
   * Check whether a JSONL transcript file exists for the given session ID.
   * Lightweight stat-only check (no parsing). Skips boundary validation
   * since the caller is expected to have already validated.
   */
  async hasTranscript(vaultRoot: string, sessionId: string): Promise<boolean> {
    const filePath = path.join(this.getTranscriptsDir(vaultRoot), `${sessionId}.jsonl`);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all sessions by scanning SDK JSONL transcript files.
   * Extracts metadata (title, timestamps, preview) from file content and stats.
   *
   * Every returned session carries a cwd: a transcript whose head records
   * carry none (oversized or unparseable first lines) is attributed to the
   * project directory it was listed from — its own slug dir — so exact-match
   * cwd scoping downstream can never orphan it (ADR 260707-193314). Copies,
   * never mutates: the shared metaCache also serves the fleet-wide watcher,
   * which has no vaultRoot to attribute with.
   */
  async listSessions(vaultRoot: string): Promise<Session[]> {
    await validateBoundary(vaultRoot);
    const sessions = await this.listSessionsInDir(this.getTranscriptsDir(vaultRoot));
    return sessions.map((s) => (s.cwd === undefined ? { ...s, cwd: vaultRoot } : s));
  }

  /**
   * List the sessions in one slug directory under {@link getProjectsRoot}.
   * Used directly by the fleet-wide session-list watcher, which enumerates
   * slug dirs from the filesystem (no user-supplied path → no boundary check);
   * each session's true working directory comes from its JSONL head, not the
   * lossy slug.
   *
   * @param transcriptsDir - Absolute path of a `~/.claude/projects/{slug}` dir.
   */
  async listSessionsInDir(transcriptsDir: string): Promise<Session[]> {
    let files: string[];
    try {
      files = (await fs.readdir(transcriptsDir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }

    const sessions: Session[] = [];

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(transcriptsDir, file);

      try {
        const fileStat = await fs.stat(filePath);
        const cached = this.metaCache.get(sessionId);
        if (cached && cached.mtimeMs === fileStat.mtimeMs) {
          sessions.push(cached.session);
          continue;
        }
        const meta = await this.extractSessionMeta(filePath, sessionId, fileStat);
        this.metaCache.set(sessionId, { session: meta, mtimeMs: fileStat.mtimeMs });
        sessions.push(meta);
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
   */
  async getSession(vaultRoot: string, sessionId: string): Promise<Session | null> {
    await validateBoundary(vaultRoot);
    const filePath = path.join(this.getTranscriptsDir(vaultRoot), `${sessionId}.jsonl`);
    try {
      const session = await this.extractSessionMeta(filePath, sessionId);
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
   * context tokens, and auto-compaction marker. Reads the last ~16KB which
   * typically contains the final assistant messages and any recent
   * `compact_boundary` record.
   */
  private async readTailStatus(filePath: string): Promise<{
    model?: string;
    permissionMode?: PermissionMode;
    contextTokens?: number;
    lastAutoCompactAt?: string;
  }> {
    const TAIL_SIZE = TRANSCRIPT.TAIL_BUFFER_BYTES;
    try {
      const stat = await fs.stat(filePath);
      const fileHandle = await fs.open(filePath, 'r');
      try {
        const readOffset = Math.max(0, stat.size - TAIL_SIZE);
        const buffer = Buffer.alloc(Math.min(TAIL_SIZE, stat.size));
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, readOffset);
        const chunk = buffer.toString('utf-8', 0, bytesRead);
        const lines = chunk.split('\n').filter((l) => l.trim());

        let model: string | undefined;
        let permissionMode: PermissionMode | undefined;
        let contextTokens: number | undefined;
        let lastAutoCompactAt: string | undefined;

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
            const sdkMode = parsed.permissionMode;
            if (sdkMode === 'bypassPermissions' || sdkMode === 'dangerously-skip') {
              permissionMode = 'bypassPermissions';
            } else if (sdkMode === 'plan') {
              permissionMode = 'plan';
            } else if (sdkMode === 'acceptEdits') {
              permissionMode = 'acceptEdits';
            } else {
              permissionMode = 'default';
            }
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

        return { model, permissionMode, contextTokens, lastAutoCompactAt };
      } finally {
        await fileHandle.close();
      }
    } catch {
      return {};
    }
  }

  /**
   * Extract session metadata from a JSONL file. Reads the first ~8KB for
   * title/permissionMode/timestamps, then folds in a single tail read (~16KB)
   * so both the list path and {@link getSession} carry the latest model, a
   * best-effort `contextTokens` reading, and any auto-compaction marker — the
   * enriched result is what {@link listSessionsInDir} caches under the file
   * mtime, so an unchanged transcript pays for neither read again.
   */
  private async extractSessionMeta(
    filePath: string,
    sessionId: string,
    fileStat?: Awaited<ReturnType<typeof fs.stat>>
  ): Promise<Session> {
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
    let permissionMode: PermissionMode = 'default';
    let firstTimestamp = '';
    let model: string | undefined;
    let cwd: string | undefined;

    for (const line of lines) {
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      // Extract permission mode from init message or user messages
      if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.permissionMode) {
        const sdkMode = parsed.permissionMode as string;
        if (sdkMode === 'bypassPermissions' || sdkMode === 'dangerously-skip') {
          permissionMode = 'bypassPermissions';
        } else if (sdkMode === 'plan') {
          permissionMode = 'plan';
        } else if (sdkMode === 'acceptEdits') {
          permissionMode = 'acceptEdits';
        }
      }
      if (parsed.type === 'user' && parsed.permissionMode) {
        const sdkMode = parsed.permissionMode as string;
        if (sdkMode === 'bypassPermissions' || sdkMode === 'dangerously-skip') {
          permissionMode = 'bypassPermissions';
        } else if (sdkMode === 'plan') {
          permissionMode = 'plan';
        } else if (sdkMode === 'acceptEdits') {
          permissionMode = 'acceptEdits';
        } else {
          permissionMode = 'default';
        }
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
        if (
          text.startsWith('<local-command') ||
          text.startsWith('<command-name>') ||
          text.startsWith('<command-message>') ||
          text.startsWith('<task-notification>') ||
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

    const derivedTitle = firstUserMessage
      ? firstUserMessage.slice(0, TRANSCRIPT.TITLE_MAX_LENGTH) +
        (firstUserMessage.length > TRANSCRIPT.TITLE_MAX_LENGTH ? '...' : '')
      : `Session ${sessionId.slice(0, TRANSCRIPT.SESSION_ID_PREVIEW_LENGTH)}`;
    // The Claude Agent SDK is the source of truth for session titles (set at
    // creation, via renameSession, or auto-generated). Prefer the persisted
    // title; fall back to the first-message derivation for untitled sessions.
    const title = (await this.resolveSdkTitle(sessionId, cwd)) ?? derivedTitle;

    const session: Session = {
      id: sessionId,
      title,
      createdAt: firstTimestamp || stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      lastMessagePreview: undefined,
      permissionMode,
      runtime: 'claude-code',
      model,
      cwd,
    };

    // Fold in the tail read: the latest model overlays the head's, and a
    // best-effort context reading + auto-compaction marker ride onto the row.
    // Absent tail values leave the head-derived fields untouched and the
    // optional reading fields unset (an honest "unknown" downstream).
    const tailStatus = await this.readTailStatus(filePath);
    if (tailStatus.model) session.model = tailStatus.model;
    if (tailStatus.permissionMode) session.permissionMode = tailStatus.permissionMode;
    if (tailStatus.contextTokens) session.contextTokens = tailStatus.contextTokens;
    if (tailStatus.lastAutoCompactAt) session.lastAutoCompactAt = tailStatus.lastAutoCompactAt;

    return session;
  }

  /**
   * Read the SDK-persisted custom title for a session, if one exists.
   *
   * The Claude Agent SDK owns session titles and persists them across restarts,
   * so we read the stored value rather than derive and overlay our own. Returns
   * undefined when the SDK has no custom title — untitled sessions then keep the
   * first-message derivation, which filters slash-commands and system tags more
   * carefully than the SDK's raw first prompt.
   *
   * @param sessionId - SDK session UUID
   * @param cwd - The session's working directory; scopes the lookup to one project
   */
  private async resolveSdkTitle(
    sessionId: string,
    cwd: string | undefined
  ): Promise<string | undefined> {
    if (!cwd) return undefined;
    try {
      const info = await getSessionInfo(sessionId, { dir: cwd });
      return info?.customTitle?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Read messages from an SDK session transcript.
   */
  async readTranscript(vaultRoot: string, sessionId: string): Promise<HistoryMessage[]> {
    await validateBoundary(vaultRoot);
    const transcriptsDir = this.getTranscriptsDir(vaultRoot);
    const filePath = path.join(transcriptsDir, `${sessionId}.jsonl`);

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return [];
    }

    const lines = content.split('\n').filter((l) => l.trim());
    return parseTranscript(lines);
  }

  /**
   * List available SDK session transcript IDs.
   */
  async listTranscripts(vaultRoot: string): Promise<string[]> {
    await validateBoundary(vaultRoot);
    const transcriptsDir = this.getTranscriptsDir(vaultRoot);
    try {
      const files = await fs.readdir(transcriptsDir);
      return files.filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', ''));
    } catch {
      return [];
    }
  }

  /** Get an ETag for a session transcript (mtime + size) for HTTP caching. */
  async getTranscriptETag(vaultRoot: string, sessionId: string): Promise<string | null> {
    await validateBoundary(vaultRoot);
    const filePath = path.join(this.getTranscriptsDir(vaultRoot), `${sessionId}.jsonl`);
    try {
      const stat = await fs.stat(filePath);
      return `"${stat.mtimeMs}-${stat.size}"`;
    } catch {
      return null;
    }
  }

  /** Resolve the SDK todo file path for a given session ID. */
  private getTodoFilePath(sessionId: string): string {
    return path.join(resolveClaudeConfigDir(), 'todos', `${sessionId}.json`);
  }

  /**
   * Read task items from the SDK's dedicated todo file (`~/.claude/todos/{sessionId}.json`).
   * Returns null when the file does not exist; throws on other filesystem errors.
   */
  async readTodosFromFile(sessionId: string): Promise<TaskItem[] | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.getTodoFilePath(sessionId), 'utf-8');
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
      const stat = await fs.stat(this.getTodoFilePath(sessionId));
      return `"${stat.mtimeMs}-${stat.size}"`;
    } catch {
      return null;
    }
  }

  /**
   * Read task state — tries the SDK todo file first, falls back to JSONL transcript parsing.
   */
  async readTasks(vaultRoot: string, sessionId: string): Promise<TaskItem[]> {
    // File-first: SDK todo file is the authoritative source when present
    const fileTasks = await this.readTodosFromFile(sessionId);
    if (fileTasks !== null) return fileTasks;

    // Fallback: parse TaskCreate/TaskUpdate tool_use blocks from JSONL transcript
    await validateBoundary(vaultRoot);
    const transcriptsDir = this.getTranscriptsDir(vaultRoot);
    const filePath = path.join(transcriptsDir, `${sessionId}.jsonl`);

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
    await validateBoundary(vaultRoot);
    const filePath = path.join(this.getTranscriptsDir(vaultRoot), `${sessionId}.jsonl`);
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
