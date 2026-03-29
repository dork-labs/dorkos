import fs from 'fs/promises';
import path from 'path';
import os from 'os';
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
import { TRANSCRIPT } from '../../../config/constants.js';
import { validateBoundary } from '../../../lib/boundary.js';
import { logger } from '../../../lib/logger.js';

export type { HistoryMessage, HistoryToolCall };

/**
 * Single source of truth for session data — reads SDK JSONL transcript files
 * from `~/.claude/projects/{slug}/`.
 *
 * Provides session listing, metadata extraction, full message history parsing,
 * task state reconstruction, and incremental byte-offset reading for sync.
 * Uses a metadata cache keyed by file mtime to avoid re-parsing unchanged files.
 */
export class TranscriptReader {
  private metaCache = new Map<string, { session: Session; mtimeMs: number }>();
  private customTitles = new Map<string, string>();

  /** Cache a custom title for a session, overlaying the derived title on next read. */
  setCustomTitle(sessionId: string, title: string): void {
    this.customTitles.set(sessionId, title);
    // Invalidate the metadata cache so the next listSessions/getSession picks up the title
    for (const [key, entry] of this.metaCache) {
      if (entry.session.id === sessionId) {
        this.metaCache.delete(key);
        break;
      }
    }
  }

  /** Convert a working directory path to an SDK project slug (filesystem-safe). */
  getProjectSlug(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
  }

  /** Resolve the SDK transcripts directory for a given vault root. */
  getTranscriptsDir(vaultRoot: string): string {
    const slug = this.getProjectSlug(vaultRoot);
    return path.join(os.homedir(), '.claude', 'projects', slug);
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
   */
  async listSessions(vaultRoot: string): Promise<Session[]> {
    await validateBoundary(vaultRoot);
    const transcriptsDir = this.getTranscriptsDir(vaultRoot);

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
   * Get metadata for a single session.
   * Reads both head (for title/timestamps) and tail (for latest model/context).
   */
  async getSession(vaultRoot: string, sessionId: string): Promise<Session | null> {
    await validateBoundary(vaultRoot);
    const filePath = path.join(this.getTranscriptsDir(vaultRoot), `${sessionId}.jsonl`);
    try {
      const session = await this.extractSessionMeta(filePath, sessionId);
      // Enrich with latest status from file tail
      const tailStatus = await this.readTailStatus(filePath);
      if (tailStatus.model) session.model = tailStatus.model;
      if (tailStatus.permissionMode) session.permissionMode = tailStatus.permissionMode;
      if (tailStatus.contextTokens) session.contextTokens = tailStatus.contextTokens;
      return session;
    } catch {
      return null;
    }
  }

  /**
   * Read the tail of a JSONL file to get the most recent model, permissionMode, and context tokens.
   * Reads the last ~16KB which typically contains the final assistant messages.
   */
  private async readTailStatus(filePath: string): Promise<{
    model?: string;
    permissionMode?: PermissionMode;
    contextTokens?: number;
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
              contextTokens =
                (u.input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0);
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
        }

        return { model, permissionMode, contextTokens };
      } finally {
        await fileHandle.close();
      }
    } catch {
      return {};
    }
  }

  /**
   * Extract session metadata from a JSONL file.
   * Reads only the first ~8KB for title/permissionMode, and uses file stat for timestamps.
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
    // Custom title (from SDK renameSession) takes priority over derived title
    const title = this.customTitles.get(sessionId) ?? derivedTitle;

    return {
      id: sessionId,
      title,
      createdAt: firstTimestamp || stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      lastMessagePreview: undefined,
      permissionMode,
      model,
      cwd,
    };
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
    return path.join(os.homedir(), '.claude', 'todos', `${sessionId}.json`);
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
