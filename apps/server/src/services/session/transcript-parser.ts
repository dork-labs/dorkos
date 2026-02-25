import type {
  HistoryMessage,
  QuestionItem,
  MessagePart,
  ToolCallPart,
  HistoryToolCall,
} from '@dorkos/shared/types';

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
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
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

/** Strip system-reminder tags from text. */
export function stripSystemTags(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
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
            const tc = toolCallMap.get(block.tool_use_id);
            if (tc) {
              tc.result = resultText;
              if (tc.toolName === 'AskUserQuestion' && tc.questions && !tc.answers) {
                tc.answers = sdkAnswers
                  ? mapSdkAnswersToIndices(sdkAnswers, tc.questions)
                  : parseQuestionAnswers(resultText, tc.questions);
              }
            }
            const tcPart = toolCallPartMap.get(block.tool_use_id);
            if (tcPart) {
              tcPart.result = resultText;
              if (tcPart.toolName === 'AskUserQuestion' && tcPart.questions && !tcPart.answers) {
                tcPart.answers = sdkAnswers
                  ? mapSdkAnswersToIndices(sdkAnswers, tcPart.questions as QuestionItem[])
                  : parseQuestionAnswers(resultText, tcPart.questions as QuestionItem[]);
              }
            }
          } else if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
        }

        if (hasToolResult && textParts.length === 0) {
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
          const displayContent = commandArgs ? `${commandName} ${commandArgs}` : commandName;
          messages.push({
            id: parsed.uuid || crypto.randomUUID(),
            role: 'user',
            content: displayContent,
            messageType: 'command',
            commandName,
            commandArgs: commandArgs || undefined,
          });
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

      const text = typeof msgContent === 'string' ? msgContent : '';

      if (text.startsWith('<task-notification>')) {
        continue;
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
        const displayContent = commandArgs ? `${commandName} ${commandArgs}` : commandName;
        messages.push({
          id: parsed.uuid || crypto.randomUUID(),
          role: 'user',
          content: displayContent,
          messageType: 'command',
          commandName,
          commandArgs: commandArgs || undefined,
        });
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
        if (block.type === 'text' && block.text) {
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
          if (block.name === 'AskUserQuestion' && block.input) {
            if (Array.isArray(block.input.questions)) {
              tc.questions = block.input.questions as QuestionItem[];
            }
            if (block.input.answers && typeof block.input.answers === 'object') {
              tc.answers = block.input.answers as Record<string, string>;
            }
          }
          if (block.name === 'Skill' && block.input) {
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
        }
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

  return messages;
}
