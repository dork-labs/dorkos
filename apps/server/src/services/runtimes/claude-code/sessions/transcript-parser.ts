import type {
  HistoryMessage,
  QuestionItem,
  MessagePart,
  ToolCallPart,
  HistoryToolCall,
  ErrorCategory,
  BackgroundTaskStatus,
} from '@dorkos/shared/types';
import { SDK_TOOL_NAMES } from '@dorkos/shared/constants';

export interface TranscriptLine {
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
  /** SDK-provided structured answers for AskUserQuestion tool results */
  toolUseResult?: {
    questions?: QuestionItem[];
    answers?: Record<string, string>;
    commandName?: string;
  };
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  // Error block fields
  error_type?: string;
  message?: string;
  category?: string;
  details?: string;
  // Subagent block fields
  task_id?: string;
  description?: string;
  status?: string;
  tool_uses?: number;
  last_tool_name?: string;
  duration_ms?: number;
  summary?: string;
  // Hook block fields
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}

/** Extract text from a tool_result content block. */
export function extractToolResultContent(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
}

/** Extract text from a message content field (string or ContentBlock[]). */
export function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
}

/** Extract command name and args from a command metadata message. */
export function extractCommandMeta(
  text: string
): { commandName: string; commandArgs: string } | null {
  const nameMatch = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  if (!nameMatch) return null;
  const commandName = '/' + nameMatch[1].replace(/^\//, '');
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const commandArgs = argsMatch ? argsMatch[1].trim() : '';
  return { commandName, commandArgs };
}

/** Strip system-injected tags (reminders, git status, UI state) from text. */
export function stripSystemTags(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<git_status>[\s\S]*?<\/git_status>/g, '')
    .replace(/<ui_state>[\s\S]*?<\/ui_state>/g, '')
    .trim();
}

/**
 * Map SDK's toolUseResult.answers (keyed by question text) to index-keyed record.
 * SDK stores answers as { "Question text": "Answer value" }.
 * Client expects { "0": "Answer value", "1": "..." }.
 */
export function mapSdkAnswersToIndices(
  sdkAnswers: Record<string, string>,
  questions: QuestionItem[]
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [questionText, answerText] of Object.entries(sdkAnswers)) {
    const qIdx = questions.findIndex((q) => q.question === questionText);
    if (qIdx !== -1) {
      answers[String(qIdx)] = answerText;
    }
  }
  // If SDK answer keys are already indices (our DorkOS format), use directly
  if (Object.keys(answers).length === 0) {
    for (const [key, value] of Object.entries(sdkAnswers)) {
      if (/^\d+$/.test(key)) {
        answers[key] = value;
      }
    }
  }
  return answers;
}

/**
 * Parse answers from AskUserQuestion tool_result text (fallback).
 * Format: `..."Question text"="Answer text", "Q2"="A2". You can now...`
 */
export function parseQuestionAnswers(
  resultText: string,
  questions: QuestionItem[]
): Record<string, string> {
  const answers: Record<string, string> = {};
  const pairRegex = /"([^"]+?)"\s*=\s*"([^"]+?)"/g;
  let match;
  while ((match = pairRegex.exec(resultText)) !== null) {
    const [, questionText, answerText] = match;
    const qIdx = questions.findIndex((q) => q.question === questionText);
    if (qIdx !== -1) {
      answers[String(qIdx)] = answerText;
    }
  }
  return answers;
}

/**
 * Strip relay context wrapper, returning the user content or null if pure metadata.
 *
 * @param text - Raw message text potentially wrapped in relay_context tags
 * @returns The user content after the closing tag, or null if pure metadata/malformed
 * @internal Exported for testing only.
 */
export function stripRelayContext(text: string): string | null {
  if (!text.startsWith('<relay_context>')) return text;
  const closingTag = '</relay_context>';
  const idx = text.indexOf(closingTag);
  if (idx === -1) return null; // Malformed, no closing tag
  const content = text.slice(idx + closingTag.length).trim();
  return content || null; // Empty content = pure metadata
}

/**
 * Apply a tool_result block to the matching HistoryToolCall and ToolCallPart entries.
 *
 * Mutates `tc` and `tcPart` in place with `result` and, for AskUserQuestion,
 * the resolved `answers` record.
 *
 * @param tc - The HistoryToolCall to update, or undefined if not tracked.
 * @param tcPart - The ToolCallPart to update, or undefined if not tracked.
 * @param resultText - Extracted text content from the tool_result block.
 * @param sdkAnswers - Optional SDK-provided answers keyed by question text.
 */
export function applyToolResult(
  tc: HistoryToolCall | undefined,
  tcPart: ToolCallPart | undefined,
  resultText: string,
  sdkAnswers: Record<string, string> | undefined
): void {
  if (tc) {
    tc.result = resultText;
    if (tc.toolName === SDK_TOOL_NAMES.ASK_USER_QUESTION && tc.questions && !tc.answers) {
      tc.answers = sdkAnswers
        ? mapSdkAnswersToIndices(sdkAnswers, tc.questions)
        : parseQuestionAnswers(resultText, tc.questions);
    }
  }
  if (tcPart) {
    tcPart.result = resultText;
    if (
      tcPart.toolName === SDK_TOOL_NAMES.ASK_USER_QUESTION &&
      tcPart.questions &&
      !tcPart.answers
    ) {
      tcPart.answers = sdkAnswers
        ? mapSdkAnswersToIndices(sdkAnswers, tcPart.questions as QuestionItem[])
        : parseQuestionAnswers(resultText, tcPart.questions as QuestionItem[]);
    }
  }
}

/**
 * Build a command HistoryMessage from a pending command and UUID.
 *
 * @param commandName - Slash command name, e.g. `/test`.
 * @param commandArgs - Optional arguments following the command name.
 * @param uuid - Optional UUID for the message; falls back to a random UUID.
 */
export function buildCommandMessage(
  commandName: string,
  commandArgs: string,
  uuid?: string
): HistoryMessage {
  const displayContent = commandArgs ? `${commandName} ${commandArgs}` : commandName;
  return {
    id: uuid || crypto.randomUUID(),
    role: 'user',
    content: displayContent,
    messageType: 'command',
    commandName,
    commandArgs: commandArgs || undefined,
  };
}

/**
 * Parse an array of JSONL lines into HistoryMessage objects.
 *
 * Implements a state machine that tracks pending slash commands, tool call
 * correlation, and Skill tool args across user/assistant message pairs.
 */
export function parseTranscript(lines: string[]): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  let pendingCommand: { commandName: string; commandArgs: string } | null = null;
  let pendingSkillArgs: string | null = null;
  const toolCallMap = new Map<string, HistoryToolCall>();
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

      if (Array.isArray(msgContent)) {
        let hasToolResult = false;
        const textParts: string[] = [];
        const sdkAnswers = parsed.toolUseResult?.answers;

        for (const block of msgContent) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            hasToolResult = true;
            const resultText = extractToolResultContent(block.content);
            applyToolResult(
              toolCallMap.get(block.tool_use_id),
              toolCallPartMap.get(block.tool_use_id),
              resultText,
              sdkAnswers
            );
          } else if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }

        // When tool_result blocks are present, any text blocks are SDK-internal
        // (skill expansion prompts, system context), never user-authored content.
        // Process tool results but suppress the text parts.
        if (hasToolResult) {
          if (parsed.toolUseResult?.commandName) {
            const cmdName = '/' + parsed.toolUseResult.commandName.replace(/^\//, '');
            pendingCommand = { commandName: cmdName, commandArgs: pendingSkillArgs || '' };
            pendingSkillArgs = null;
          }
          continue;
        }

        if (pendingCommand) {
          const { commandName, commandArgs } = pendingCommand;
          pendingCommand = null;
          messages.push(buildCommandMessage(commandName, commandArgs, parsed.uuid));
          continue;
        }

        if (textParts.length > 0) {
          const cleanText = stripSystemTags(textParts.join('\n'));
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

      let text = typeof msgContent === 'string' ? msgContent : '';

      if (text.startsWith('<task-notification>')) {
        continue;
      }

      // Strip relay context wrapper, preserving the actual user content after </relay_context>
      if (text.startsWith('<relay_context>')) {
        const userContent = stripRelayContext(text);
        if (!userContent) continue; // Pure metadata or malformed
        text = userContent; // Fall through to process as normal user message
      }

      if (text.startsWith('<command-message>') || text.startsWith('<command-name>')) {
        const meta = extractCommandMeta(text);
        if (meta) {
          pendingCommand = meta;
        }
        continue;
      }

      if (text.startsWith('<local-command')) {
        pendingCommand = null;
        continue;
      }

      if (pendingCommand) {
        const { commandName, commandArgs } = pendingCommand;
        pendingCommand = null;
        messages.push(buildCommandMessage(commandName, commandArgs, parsed.uuid));
        continue;
      }

      if (text.startsWith('This session is being continued')) {
        messages.push({
          id: parsed.uuid || crypto.randomUUID(),
          role: 'user',
          content: text,
          messageType: 'compaction',
        });
        continue;
      }

      const cleanText = stripSystemTags(text);
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
        if (block.type === 'thinking' && block.thinking) {
          parts.push({ type: 'thinking', text: block.thinking, isStreaming: false });
        } else if (block.type === 'text' && block.text) {
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
          if (block.name === SDK_TOOL_NAMES.ASK_USER_QUESTION && block.input) {
            if (Array.isArray(block.input.questions)) {
              tc.questions = block.input.questions as QuestionItem[];
            }
            if (block.input.answers && typeof block.input.answers === 'object') {
              tc.answers = block.input.answers as Record<string, string>;
            }
          }
          if (block.name === SDK_TOOL_NAMES.SKILL && block.input) {
            const input = block.input as Record<string, unknown>;
            pendingSkillArgs = (input.args as string) || null;
          }
          toolCalls.push(tc);
          toolCallMap.set(block.id, tc);

          const toolCallPart: ToolCallPart = {
            type: 'tool_call',
            toolCallId: block.id,
            toolName: block.name,
            input: block.input ? JSON.stringify(block.input) : undefined,
            status: 'complete',
            ...(tc.questions
              ? {
                  interactiveType: 'question' as const,
                  questions: tc.questions,
                  answers: tc.answers,
                }
              : {}),
          };
          parts.push(toolCallPart);
          toolCallPartMap.set(block.id, toolCallPart);
        } else if (block.type === 'error') {
          // Error blocks → ErrorPart (snake_case SDK fields → camelCase client fields)
          parts.push({
            type: 'error',
            message: block.message ?? '',
            category: (block.category as ErrorCategory) ?? undefined,
            details: block.details ?? undefined,
          });
        } else if (block.type === 'subagent') {
          // Legacy subagent blocks → BackgroundTaskPart (backward compat: old JSONL → new schema)
          const rawStatus = (block.status as BackgroundTaskStatus) ?? 'running';
          parts.push({
            type: 'background_task',
            taskId: block.task_id ?? block.id ?? '',
            taskType: 'agent',
            status: rawStatus,
            startedAt: 0,
            description: block.description ?? '',
            toolUses: block.tool_uses,
            lastToolName: block.last_tool_name,
            durationMs: block.duration_ms,
            summary: block.summary,
          });
        }
        // Note: hook blocks are not top-level MessageParts — hooks live inside
        // ToolCallPart.hooks. No standalone hook part extraction is performed here.
      }

      if (parts.length === 0) continue;

      const text = parts
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
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

  return mergeConsecutiveAssistantMessages(messages);
}

/**
 * Merge consecutive assistant messages into a single message per turn.
 *
 * The SDK may emit separate JSONL entries for thinking and text blocks within
 * a single assistant turn. The client's streaming model treats these as one
 * message with multiple parts, so the parser must do the same to prevent
 * duplicates when history loads.
 *
 * Uses the last message's ID so that `getLastMessageIds()` returns the correct
 * value for Phase 3 client-server ID reconciliation.
 */
function mergeConsecutiveAssistantMessages(messages: HistoryMessage[]): HistoryMessage[] {
  const merged: HistoryMessage[] = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === 'assistant' && msg.role === 'assistant') {
      prev.id = msg.id;
      prev.parts = [...(prev.parts ?? []), ...(msg.parts ?? [])];
      if (msg.content) {
        prev.content = prev.content ? prev.content + '\n' + msg.content : msg.content;
      }
      if (msg.toolCalls) {
        prev.toolCalls = [...(prev.toolCalls ?? []), ...msg.toolCalls];
      }
      if (msg.timestamp) prev.timestamp = msg.timestamp;
    } else {
      const copy = { ...msg };
      if (copy.parts) copy.parts = [...copy.parts];
      merged.push(copy);
    }
  }
  return merged;
}
