import type {
  HistoryMessage,
  QuestionItem,
  MessagePart,
  ToolCallPart,
  HistoryToolCall,
  ErrorCategory,
  BackgroundTaskStatus,
  CompactMetadata,
} from '@dorkos/shared/types';
import { SDK_TOOL_NAMES } from '@dorkos/shared/constants';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { mapSdkAnswersToIndices, parseQuestionAnswers } from './question-answers.js';

export interface TranscriptLine {
  type: string;
  uuid?: string;
  /**
   * CLI-internal record (resume bootstrap, prompt expansions, caveats). The
   * CLI never renders these; neither does DorkOS.
   */
  isMeta?: boolean;
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
  /**
   * Top-level content of a `system` record (e.g. `local_command` output, where
   * the SDK stores the `<local-command-stdout>…</local-command-stdout>` text
   * here rather than under `message`).
   */
  content?: string;
  /** Marks the post-compaction continuation summary user record (SDK `isCompactSummary`). */
  isCompactSummary?: boolean;
  /**
   * Marks a subagent/sidechain record — a Task-tool subagent's own turn, not
   * the parent session's conversation. Absent or `false` on the parent
   * session's own `user`/`assistant` records.
   */
  isSidechain?: boolean;
  /**
   * Compaction metadata on a `system`/`compact_boundary` record (SDK
   * `compactMetadata`, already camelCase on disk). Only the token/trigger fields
   * are consumed here; `preservedSegment`/`preservedMessages` are ignored.
   */
  compactMetadata?: {
    trigger?: 'manual' | 'auto';
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
  };
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

/**
 * Extract the inner text of a `<local-command-stdout>` / `<local-command-stderr>`
 * wrapper, the form the SDK uses to persist a local slash command's output.
 *
 * @param content - Raw `local_command` system-record content.
 * @returns The captured output text, or null when `content` is not such a
 *   wrapper (e.g. a `<local-command-caveat>` note), so callers can skip it.
 * @internal Exported for testing only.
 */
export function extractLocalCommandOutput(content: string): string | null {
  const match = content.match(/<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>/);
  return match ? match[2] : null;
}

/**
 * Strip system-injected tags from rendered text: the `<system-reminder>` block
 * plus every {@link CONTEXT_TAG} value (git_status, ui_state, queue_note, env,
 * relay_context, …). Driving the loop off `CONTEXT_TAG` means this can NEVER
 * drift from the adapter's `renderContextEntry` formatter — adding a
 * `ContextKind` is automatically stripped here with no edit.
 *
 * NOTE: two relay mechanisms coexist by design (codebase comment-why rule).
 * This function strips a `<relay_context>` block IN PLACE (the tag and its
 * contents are removed wherever they appear). {@link stripRelayContext} is the
 * position-sensitive variant used only in the message pipeline: it SPLITS on
 * the `</relay_context>` boundary and returns the trailing user content (or
 * null for pure metadata). Both key off `CONTEXT_TAG.relay_context`, so they
 * can never disagree on the tag name.
 */
export function stripSystemTags(text: string): string {
  let result = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  for (const tag of Object.values(CONTEXT_TAG)) {
    const re = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'g');
    result = result.replace(re, '');
  }
  return result.trim();
}

/**
 * Strip the relay-context wrapper, returning the user content that FOLLOWS the
 * closing tag, or null for pure metadata. This is the position-sensitive
 * counterpart to {@link stripSystemTags}: relay messages prepend the block and
 * the real user content trails it, so the message pipeline must SPLIT on the
 * boundary (not remove-in-place) to recover the prompt. Keyed off the same
 * `CONTEXT_TAG.relay_context` tag name so it stays in lockstep with the strip.
 *
 * @param text - Raw message text potentially wrapped in relay_context tags
 * @returns The user content after the closing tag, or null if pure metadata/malformed
 * @internal Exported for testing only.
 */
export function stripRelayContext(text: string): string | null {
  const openTag = `<${CONTEXT_TAG.relay_context}>`;
  const closingTag = `</${CONTEXT_TAG.relay_context}>`;
  if (!text.startsWith(openTag)) return text;
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
  let pendingCommand: { commandName: string; commandArgs: string; uuid?: string } | null = null;
  let pendingSkillArgs: string | null = null;
  // Metadata from a `compact_boundary` system record, held until the very next
  // `isCompactSummary` user record (which the boundary always precedes) so it can
  // be attached to that compaction message.
  let pendingCompactMetadata: CompactMetadata | null = null;
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
      // Synthetic CLI records: the resume bootstrap ("Continue from where you
      // left off." — written on every `query({resume})` turn DorkOS triggers),
      // skill/command prompt expansions, and local-command caveats. The CLI
      // hides every isMeta record from its own UI; render none of them. A
      // pending slash command still flushes here because the (isMeta)
      // expansion record is what follows the command metadata record.
      // Compaction summaries are NOT isMeta and are unaffected.
      if (parsed.isMeta) {
        if (pendingCommand) {
          const { commandName, commandArgs } = pendingCommand;
          pendingCommand = null;
          messages.push(buildCommandMessage(commandName, commandArgs, parsed.uuid));
        }
        continue;
      }

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
          // Carry this record's own uuid so a local command whose output flushes
          // the bubble (see the `local_command` branch) gets a stable id that
          // won't collide with the separate output message.
          pendingCommand = { ...meta, uuid: parsed.uuid };
        }
        continue;
      }

      if (text.startsWith('<local-command')) {
        pendingCommand = null;
        continue;
      }

      // The post-compaction continuation summary. `isCompactSummary` is the
      // authoritative SDK flag; the text-prefix check is a fallback for older
      // transcripts written before the flag existed. The adjacent
      // `compact_boundary` record (always immediately prior) supplies the token
      // counts and trigger captured in `pendingCompactMetadata`. This is checked
      // BEFORE the pending-command flush: a `/compact` run between a slash
      // command and its (later) caveat record would otherwise let the stale
      // pendingCommand consume this summary, dropping the compaction row.
      if (parsed.isCompactSummary || text.startsWith('This session is being continued')) {
        const compaction: HistoryMessage = {
          id: parsed.uuid || crypto.randomUUID(),
          role: 'user',
          content: text,
          messageType: 'compaction',
        };
        if (pendingCompactMetadata) {
          compaction.compactMetadata = pendingCompactMetadata;
          pendingCompactMetadata = null;
        }
        messages.push(compaction);
        continue;
      }

      if (pendingCommand) {
        const { commandName, commandArgs } = pendingCommand;
        pendingCommand = null;
        messages.push(buildCommandMessage(commandName, commandArgs, parsed.uuid));
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

      // The CLI pairs its resume bootstrap with a zero-token synthetic
      // assistant reply. Other synthetic messages (API error notices) stay
      // visible — they carry real failure information.
      if (
        parsed.message.model === '<synthetic>' &&
        extractTextContent(contentBlocks).trim() === 'No response requested.'
      ) {
        continue;
      }

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
              // Recorded answers (post-fix) are keyed by question text. Normalize
              // to the client's index-keyed canonical form; legacy index-keyed
              // recordings pass through via the digit-key fallback.
              const rawAnswers = block.input.answers as Record<string, string>;
              tc.answers = tc.questions
                ? mapSdkAnswersToIndices(rawAnswers, tc.questions)
                : rawAnswers;
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
    } else if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
      // Hold the boundary's token/trigger metadata for the `isCompactSummary`
      // user record that immediately follows it. (`local_command` output is the
      // other rendered `system` subtype — handled in the branch below.)
      const meta = parsed.compactMetadata;
      pendingCompactMetadata = meta
        ? {
            ...(meta.trigger !== undefined ? { trigger: meta.trigger } : {}),
            ...(meta.preTokens !== undefined ? { preTokens: meta.preTokens } : {}),
            ...(meta.postTokens !== undefined ? { postTokens: meta.postTokens } : {}),
            ...(meta.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
          }
        : null;
    } else if (parsed.type === 'system' && parsed.subtype === 'local_command') {
      // Purely-local slash commands (/context, /usage, /rename, …) run
      // client-side. The SDK never streams their output as an SDKMessage — it
      // only writes a `local_command` system record to the transcript — so this
      // durable path is the sole place to render them (DOR-126).
      const raw = typeof parsed.content === 'string' ? parsed.content : '';

      // Some local commands (e.g. /rename, /resume) record their invocation
      // here rather than as a user record; surface the command bubble for them.
      if (raw.startsWith('<command-name>')) {
        const meta = extractCommandMeta(raw);
        if (meta) {
          messages.push(buildCommandMessage(meta.commandName, meta.commandArgs, parsed.uuid));
        }
        continue;
      }

      // The command's captured stdout/stderr. Skip non-output records (caveats)
      // and empty output (e.g. /clear writes an empty stdout wrapper).
      const output = extractLocalCommandOutput(raw);
      if (output === null || !output.trim()) continue;

      // Flush a deferred command bubble (e.g. /context, whose `<command-name>`
      // arrived as a user record) so it precedes its output, then render the
      // output as its own message.
      if (pendingCommand) {
        const { commandName, commandArgs, uuid } = pendingCommand;
        pendingCommand = null;
        messages.push(buildCommandMessage(commandName, commandArgs, uuid));
      }
      messages.push({
        id: parsed.uuid || crypto.randomUUID(),
        role: 'user',
        content: output,
        messageType: 'local_command_output',
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
