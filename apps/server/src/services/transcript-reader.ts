import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Session, PermissionMode, HistoryMessage, HistoryToolCall, QuestionItem, TaskItem, TaskStatus, MessagePart, ToolCallPart } from '@lifeos/shared/types';

export type { HistoryMessage, HistoryToolCall };

interface TranscriptLine {
  type: string;
  uuid?: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  timestamp?: string;
  sessionId?: string;
  permissionMode?: string;
  subtype?: string;
  cwd?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  // tool_use fields
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  // tool_result fields
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

export class TranscriptReader {
  private metaCache = new Map<string, { session: Session; mtimeMs: number }>();

  getProjectSlug(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
  }

  getTranscriptsDir(vaultRoot: string): string {
    const slug = this.getProjectSlug(vaultRoot);
    return path.join(os.homedir(), '.claude', 'projects', slug);
  }

  /**
   * List all sessions by scanning SDK JSONL transcript files.
   * Extracts metadata (title, timestamps, preview) from file content and stats.
   */
  async listSessions(vaultRoot: string): Promise<Session[]> {
    const transcriptsDir = this.getTranscriptsDir(vaultRoot);

    let files: string[];
    try {
      files = (await fs.readdir(transcriptsDir)).filter(f => f.endsWith('.jsonl'));
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
    const TAIL_SIZE = 16384;
    try {
      const stat = await fs.stat(filePath);
      const fileHandle = await fs.open(filePath, 'r');
      try {
        const readOffset = Math.max(0, stat.size - TAIL_SIZE);
        const buffer = Buffer.alloc(Math.min(TAIL_SIZE, stat.size));
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, readOffset);
        const chunk = buffer.toString('utf-8', 0, bytesRead);
        const lines = chunk.split('\n').filter(l => l.trim());

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
    const stat = fileStat ?? await fs.stat(filePath);

    // Read only the head of the file (8KB) — metadata is always in the first few lines
    const fileHandle = await fs.open(filePath, 'r');
    let chunk: string;
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await fileHandle.read(buffer, 0, 8192, 0);
      chunk = buffer.toString('utf-8', 0, bytesRead);
    } finally {
      await fileHandle.close();
    }

    const lines = chunk.split('\n').filter(l => l.trim());

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

      // Extract first user message for title
      if (!firstUserMessage && parsed.type === 'user' && parsed.message) {
        const text = this.extractTextContent(parsed.message.content);
        if (text.startsWith('<local-command') || text.startsWith('<command-name>')) {
          continue;
        }
        const cleanText = this.stripSystemTags(text);
        if (!cleanText.trim()) continue;

        firstUserMessage = cleanText.trim();
      }

      // Extract cwd (usually on the first line)
      if (!cwd && parsed.cwd) {
        cwd = parsed.cwd;
      }

      // Once we have all head metadata, stop early
      if (firstUserMessage && firstTimestamp && model && cwd) break;
    }

    const title = firstUserMessage
      ? firstUserMessage.slice(0, 80) + (firstUserMessage.length > 80 ? '...' : '')
      : `Session ${sessionId.slice(0, 8)}`;

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
  async readTranscript(
    vaultRoot: string,
    sessionId: string
  ): Promise<HistoryMessage[]> {
    const transcriptsDir = this.getTranscriptsDir(vaultRoot);
    const filePath = path.join(transcriptsDir, `${sessionId}.jsonl`);

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return [];
    }

    const messages: HistoryMessage[] = [];
    const lines = content.split('\n').filter(l => l.trim());
    // Map tool_use_id → HistoryToolCall for correlating results
    const toolCallMap = new Map<string, HistoryToolCall>();
    // Map tool_use_id → ToolCallPart for correlating results into parts
    const toolCallPartMap = new Map<string, ToolCallPart>();

    for (const line of lines) {
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.type === 'user' && parsed.message) {
        const msgContent = parsed.message.content;

        // Check for tool_result blocks in array content (auto-generated user messages)
        if (Array.isArray(msgContent)) {
          let hasToolResult = false;
          const textParts: string[] = [];

          for (const block of msgContent) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              hasToolResult = true;
              const resultText = this.extractToolResultContent(block.content);
              const tc = toolCallMap.get(block.tool_use_id);
              if (tc) {
                tc.result = resultText;
              }
              const tcPart = toolCallPartMap.get(block.tool_use_id);
              if (tcPart) {
                tcPart.result = resultText;
              }
            } else if (block.type === 'text' && block.text) {
              textParts.push(block.text);
            }
          }

          // If this user message is purely tool results, skip it as a visible message
          if (hasToolResult && textParts.length === 0) continue;

          // Otherwise it has human text alongside tool results
          if (textParts.length > 0) {
            const cleanText = this.stripSystemTags(textParts.join('\n'));
            if (cleanText.trim()) {
              messages.push({
                id: parsed.uuid || crypto.randomUUID(),
                role: 'user',
                content: cleanText,
              });
            }
          }
          continue;
        }

        // Plain string content (normal user message)
        const text = typeof msgContent === 'string' ? msgContent : '';
        if (text.startsWith('<local-command') || text.startsWith('<command-name>')) {
          continue;
        }
        const cleanText = this.stripSystemTags(text);
        if (!cleanText.trim()) continue;

        messages.push({
          id: parsed.uuid || crypto.randomUUID(),
          role: 'user',
          content: cleanText,
        });
      } else if (parsed.type === 'assistant' && parsed.message) {
        const contentBlocks = parsed.message.content;
        if (!Array.isArray(contentBlocks)) continue;

        const parts: MessagePart[] = [];
        const toolCalls: HistoryToolCall[] = [];

        for (const block of contentBlocks) {
          if (block.type === 'text' && block.text) {
            // Merge adjacent text parts
            const lastPart = parts[parts.length - 1];
            if (lastPart && lastPart.type === 'text') {
              lastPart.text += '\n' + block.text;
            } else {
              parts.push({ type: 'text', text: block.text });
            }
          } else if (block.type === 'tool_use' && block.name && block.id) {
            const tc: HistoryToolCall = {
              toolCallId: block.id,
              toolName: block.name,
              input: block.input ? JSON.stringify(block.input) : undefined,
              status: 'complete',
            };
            // Preserve question/answer data for AskUserQuestion tool calls
            if (block.name === 'AskUserQuestion' && block.input) {
              if (Array.isArray(block.input.questions)) {
                tc.questions = block.input.questions as QuestionItem[];
              }
              if (block.input.answers && typeof block.input.answers === 'object') {
                tc.answers = block.input.answers as Record<string, string>;
              }
            }
            toolCalls.push(tc);
            toolCallMap.set(block.id, tc);

            // Add tool call part inline to preserve ordering
            const toolCallPart: ToolCallPart = {
              type: 'tool_call',
              toolCallId: block.id,
              toolName: block.name,
              input: block.input ? JSON.stringify(block.input) : undefined,
              status: 'complete',
              ...(tc.questions ? {
                interactiveType: 'question' as const,
                questions: tc.questions,
                answers: tc.answers,
              } : {}),
            };
            parts.push(toolCallPart);
            toolCallPartMap.set(block.id, toolCallPart);
          }
        }

        if (parts.length === 0) continue;

        // Derive flat content from text parts
        const text = parts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map(p => p.text)
          .join('\n')
          .trim();

        messages.push({
          id: parsed.uuid || crypto.randomUUID(),
          role: 'assistant',
          content: text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          parts,
          timestamp: parsed.timestamp,
        });
      }
    }

    return messages;
  }

  /**
   * List available SDK session transcript IDs.
   */
  async listTranscripts(vaultRoot: string): Promise<string[]> {
    const transcriptsDir = this.getTranscriptsDir(vaultRoot);
    try {
      const files = await fs.readdir(transcriptsDir);
      return files
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace('.jsonl', ''));
    } catch {
      return [];
    }
  }

  /**
   * Read task state from an SDK session transcript.
   * Parses TaskCreate/TaskUpdate tool_use blocks and reconstructs final state.
   */
  async readTasks(vaultRoot: string, sessionId: string): Promise<TaskItem[]> {
    const transcriptsDir = this.getTranscriptsDir(vaultRoot);
    const filePath = path.join(transcriptsDir, `${sessionId}.jsonl`);

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return [];
    }

    const lines = content.split('\n').filter(l => l.trim());
    const tasks = new Map<string, TaskItem>();
    let nextId = 1;

    for (const line of lines) {
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.type !== 'assistant') continue;
      const message = parsed.message;
      if (!message?.content || !Array.isArray(message.content)) continue;

      for (const block of message.content) {
        if (block.type !== 'tool_use') continue;
        if (!block.name || !['TaskCreate', 'TaskUpdate'].includes(block.name)) continue;
        const input = block.input;
        if (!input) continue;

        if (block.name === 'TaskCreate') {
          const id = String(nextId++);
          tasks.set(id, {
            id,
            subject: (input.subject as string) ?? '',
            description: input.description as string | undefined,
            activeForm: input.activeForm as string | undefined,
            status: 'pending',
          });
        } else if (block.name === 'TaskUpdate' && input.taskId) {
          const existing = tasks.get(input.taskId as string);
          if (existing) {
            if (input.status) existing.status = input.status as TaskStatus;
            if (input.subject) existing.subject = input.subject as string;
            if (input.activeForm) existing.activeForm = input.activeForm as string;
            if (input.description) existing.description = input.description as string;
            if (input.addBlockedBy) existing.blockedBy = [...(existing.blockedBy ?? []), ...(input.addBlockedBy as string[])];
            if (input.addBlocks) existing.blocks = [...(existing.blocks ?? []), ...(input.addBlocks as string[])];
            if (input.owner) existing.owner = input.owner as string;
          }
        }
      }
    }

    return Array.from(tasks.values());
  }

  private extractToolResultContent(content: string | ContentBlock[] | undefined): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('\n');
  }

  private extractTextContent(content: string | ContentBlock[]): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('\n');
  }

  private stripSystemTags(text: string): string {
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  }
}

export const transcriptReader = new TranscriptReader();
