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
import { TRANSCRIPT } from '../../config/constants.js';
import { validateBoundary } from '../../lib/boundary.js';

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
          text.startsWith('<task-notification>')
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

    const title = firstUserMessage
      ? firstUserMessage.slice(0, TRANSCRIPT.TITLE_MAX_LENGTH) +
        (firstUserMessage.length > TRANSCRIPT.TITLE_MAX_LENGTH ? '...' : '')
      : `Session ${sessionId.slice(0, TRANSCRIPT.SESSION_ID_PREVIEW_LENGTH)}`;

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

  /**
   * Read task state from an SDK session transcript.
   * Parses TaskCreate/TaskUpdate tool_use blocks and reconstructs final state.
   */
  async readTasks(vaultRoot: string, sessionId: string): Promise<TaskItem[]> {
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

export const transcriptReader = new TranscriptReader();
