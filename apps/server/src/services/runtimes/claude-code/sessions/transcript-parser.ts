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
import { extractToolResultImages, type ToolResultImage } from '../tool-result-images.js';
import { apiErrorCode, buildApiErrorPart, isApiErrorRecord } from '../sdk/api-error-record.js';
import { mapSdkAnswersToIndices } from './question-answers.js';
import { applyToolResult } from './tool-result-outcome.js';
import { classifyOrigin } from './classify-origin.js';

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
  /**
   * The CLI's marker for a SYNTHETIC record it wrote to report an API failure
   * (an expired sign-in, a 5xx, a hit limit) rather than anything the agent
   * said. Paired with {@link TranscriptLine.error}; both are read by
   * `sdk/api-error-record.ts`.
   */
  isApiErrorMessage?: boolean;
  /**
   * The failure code on an API-error record, e.g. `authentication_failed`.
   * Typed `unknown` because a `system` record carries an OBJECT here, so every
   * read narrows before trusting it.
   */
  error?: unknown;
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
  /**
   * On an `image` block inside a tool result: where the bytes are. Verified
   * against a real `Read` of a PNG — the SDK writes
   * `{ type: 'base64', media_type: 'image/png', data: '<base64>' }`.
   */
  source?: { type?: string; media_type?: string; data?: string };
  /**
   * On a `tool_result`: whether the call FAILED. The one machine-readable
   * signal separating a tool that ran from one that was denied, timed out,
   * withdrawn, or errored — everything else about which is prose, read by
   * `sessions/tool-result-outcome.ts`.
   */
  is_error?: boolean;
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

/**
 * Extract text from a tool_result content block.
 *
 * Text ONLY, and that is now a statement rather than an omission: a tool result
 * can also carry an `image` block, and {@link extractToolResultImages} is the
 * sibling that reads those. Filtering them away here used to be the whole story
 * — a `Read` of a PNG produced the empty string and the picture was gone.
 */
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
 * Whether a `<relay_context>` record was published by a PERSON.
 *
 * Relay is agent-to-agent plumbing far more often than it is a person: the
 * block's `From:` line names the caller, and `classifyOrigin` already knows how
 * to read it — `relay.human.console*` is the operator, a bridged chat
 * (Telegram/Slack/webhook) is a person on the other end of a connection, and
 * `relay.agent.*` / `relay.session.*` / `relay.system.tasks.*` / `a2a-gateway`
 * are machines. That classifier is the single source of truth for the mapping;
 * nothing here re-derives it.
 *
 * @param text - Raw text of a record beginning with the relay block.
 */
function relayRecordIsFromAPerson(text: string): boolean {
  const { origin } = classifyOrigin(text);
  // Absent origin is the operator's own console (the unmarked default);
  // `channel` is a person writing from Telegram/Slack/a webhook. Everything
  // else the classifier names — agent, task, external — is not a person.
  return origin === undefined || origin === 'channel';
}

/**
 * The text a PERSON wrote in one `user` record's content, or null when nobody
 * did. Shared by both content shapes so the string and array branches of
 * {@link isPersonAuthoredUserRecord} can never drift on which wrappers mean
 * "not a person" — the array shape carries none of these wrappers in any
 * transcript observed so far, and that is exactly why the guard belongs in one
 * place rather than in the branch that happens to need it today.
 *
 * @param text - Extracted text of the record.
 * @returns What the person wrote, or null.
 */
function personAuthoredText(text: string): string | null {
  if (text.startsWith('<task-notification>')) return null;
  // DorkOS-steered corrective notes (DOR-1087) are runtime speech.
  if (text.startsWith('<dorkos-system-note>')) return null;
  // A local command's captured stdout/stderr, echoed back into the thread.
  if (text.startsWith('<local-command')) return null;
  // Bash-mode OUTPUT is the machine talking. The matching `<bash-input>` is the
  // person's typed command and deliberately still counts.
  if (text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>')) return null;
  if (text.startsWith('This session is being continued')) return null;

  let body = text;
  if (body.startsWith(`<${CONTEXT_TAG.relay_context}>`)) {
    if (!relayRecordIsFromAPerson(body)) return null;
    // Even from a person, only the content trailing the block is theirs.
    const trailing = stripRelayContext(body);
    if (!trailing) return null;
    body = trailing;
  }

  // The person typed a slash command — an interaction, even though the renderer
  // draws it as a command row rather than a message.
  if (body.startsWith('<command-message>') || body.startsWith('<command-name>')) {
    return extractCommandMeta(body) === null ? null : body;
  }

  const clean = stripSystemTags(body).trim();
  return clean.length > 0 ? clean : null;
}

/**
 * Whether a transcript record is a message the PERSON sent.
 *
 * The JSONL `user` role is a wire role, not an author, and DorkOS itself is one
 * of the things that writes on it. Tool results, resume bootstraps, skill
 * expansions, compaction summaries, background-task notifications, DorkOS's own
 * corrective notes, relay hand-offs from other agents, scheduled-task prompts
 * and room posts by other agents all arrive as `type: 'user'`. This answers the
 * different question "did a human write this?", which is what
 * `Session.userLastMessageAt` (BC-16) has to be derived from — a field that
 * counted any of them would move whenever a MACHINE acted, which is precisely
 * the reordering BC-16 exists to prevent.
 *
 * The rules are the ones {@link parseTranscript} already applies when it decides
 * to render a `user` bubble, plus the authorship questions a renderer never has
 * to ask:
 *
 * - A slash-command record (`<command-name>`) COUNTS. The renderer turns it into
 *   its own bubble kind rather than a user message, but the person typed it.
 * - A compaction summary does NOT count. The renderer shows it (it is real
 *   history); nobody wrote it.
 * - A relay record counts only when its `From:` names a person
 *   ({@link relayRecordIsFromAPerson}).
 *
 * **It cannot answer for every path, and the session-level gate is the other
 * half.** A scheduled task's prompt and a room post written by another agent
 * both reach the transcript as plain, unmarked user text — nothing in the
 * record distinguishes them from something you typed. `userLastMessageAt` is
 * therefore suppressed for whole sessions whose `origin` is `agent`, `task` or
 * `room` (`services/session/origin/user-last-message-origin.ts`), which covers those
 * two paths without guessing at content.
 *
 * @param line - One parsed transcript record.
 * @returns True when a person authored this record.
 */
export function isPersonAuthoredUserRecord(line: TranscriptLine): boolean {
  if (line.type !== 'user' || !line.message) return false;
  // CLI-internal records: resume bootstrap, prompt expansions, caveats.
  if (line.isMeta) return false;
  // A subagent's own turn, not this conversation's.
  if (line.isSidechain) return false;
  // Written by the compactor, not by anyone.
  if (line.isCompactSummary) return false;

  const content = line.message.content;

  if (Array.isArray(content)) {
    // A record carrying tool_result blocks is the harness answering the model.
    // Any text blocks alongside them are SDK-internal (same rule as the
    // renderer), so the whole record is not the person's.
    if (content.some((block) => block.type === 'tool_result')) return false;
    return personAuthoredText(extractTextContent(content)) !== null;
  }

  return personAuthoredText(typeof content === 'string' ? content : '') !== null;
}

/**
 * A record's ISO timestamp as epoch ms, or undefined when it has none or the
 * value is unparseable. A receipt without a time renders without one; a
 * receipt stamped `NaN` renders "Invalid Date".
 *
 * @param timestamp - The record's `timestamp` field, if any.
 */
/**
 * Whether an assistant record's content carries a `tool_use` block — the one
 * shape the API-error branch must not swallow, since it renders the notice and
 * drops everything else. Bare-string content carries none by construction.
 *
 * @param content - The record's `message.content`, in either encoding.
 */
function carriesToolUse(content: string | ContentBlock[]): boolean {
  return Array.isArray(content) && content.some((block) => block.type === 'tool_use');
}

function epochMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
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
 * One image a transcript read found, and the tool call it belongs behind.
 *
 * The anchor is a PART rather than a message id or an index, because object
 * identity is the only thing that survives
 * {@link mergeConsecutiveAssistantMessages}: it rebuilds the parts arrays but
 * carries the part objects over by reference. `attachTranscriptImages`
 * (`../media-capture.ts`) resolves the bytes and splices the picture in right
 * after its tool call.
 */
export interface TranscriptImageRef {
  /** The tool call whose result carried this image. */
  readonly toolCallPart: ToolCallPart;
  /** What the result carried, not yet stored. */
  readonly image: ToolResultImage;
}

/**
 * Parse an array of JSONL lines into HistoryMessage objects.
 *
 * Implements a state machine that tracks pending slash commands, tool call
 * correlation, and Skill tool args across user/assistant message pairs.
 *
 * @param lines - The transcript's JSONL lines.
 * @param images - Collects every image a tool result carried, in transcript
 *   order, for the caller to resolve. Storing bytes is I/O and this function
 *   does none, so it records WHERE each picture belongs and nothing more. Omit
 *   it and images are simply not read — the behaviour every caller that does
 *   not render a transcript still wants.
 */
export function parseTranscript(lines: string[], images?: TranscriptImageRef[]): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  let pendingCommand: { commandName: string; commandArgs: string; uuid?: string } | null = null;
  let pendingSkillArgs: string | null = null;
  // Metadata from a `compact_boundary` system record, held until the very next
  // `isCompactSummary` user record (which the boundary always precedes) so it can
  // be attached to that compaction message.
  let pendingCompactMetadata: CompactMetadata | null = null;
  const toolCallMap = new Map<string, HistoryToolCall>();
  const toolCallPartMap = new Map<string, ToolCallPart>();
  // When each call was made, from its assistant record's own timestamp. Paired
  // with the result record's timestamp it is how long a refused or expired
  // permission waited — the only place that number exists for a decision DorkOS
  // did not itself record.
  const toolCallStartedAt = new Map<string, number>();

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
            // Whatever the result carried that was not text. Anchored to the
            // tool call's PART so the caller can put the picture back exactly
            // where it happened; see {@link TranscriptImageRef}.
            const anchor = toolCallPartMap.get(block.tool_use_id);
            if (images && anchor) {
              for (const image of extractToolResultImages(block.tool_use_id, block.content)) {
                images.push({ toolCallPart: anchor, image });
              }
            }
            applyToolResult({
              tc: toolCallMap.get(block.tool_use_id),
              tcPart: toolCallPartMap.get(block.tool_use_id),
              resultText,
              isError: block.is_error,
              sdkAnswers,
              resolvedAt: epochMs(parsed.timestamp),
              startedAt: toolCallStartedAt.get(block.tool_use_id),
            });
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

      // DorkOS-steered corrective notes (DOR-1087) are runtime speech, not the
      // person's — never render them as a user bubble.
      if (text.startsWith('<dorkos-system-note>')) {
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

      // A synthetic API-error notice the CLI wrote (expired sign-in, 5xx, hit
      // limit) is a failure report, not speech. It becomes the SAME typed error
      // part the live stream produces, so a reload shows the same card — and,
      // for an expired sign-in, the same way out of it (DOR-1649).
      //
      // Two shape decisions, both defensive rather than observed. Every one of
      // the 249 records measured carries exactly one `text` block. This runs
      // BEFORE the array guard so a future bare-string notice is still read
      // rather than dropped by it; and it stands down entirely for a record
      // carrying a `tool_use` block, because this branch renders the notice and
      // nothing else, which would silently drop tool calls. Such a record falls
      // through to normal parsing instead — the pre-DOR-1649 behaviour, which
      // loses no data.
      if (isApiErrorRecord(parsed) && !carriesToolUse(contentBlocks)) {
        messages.push({
          id: parsed.uuid || crypto.randomUUID(),
          role: 'assistant',
          content: '',
          parts: [
            buildApiErrorPart(apiErrorCode(parsed), extractTextContent(contentBlocks).trim()),
          ],
          timestamp: parsed.timestamp,
        });
        continue;
      }

      if (!Array.isArray(contentBlocks)) continue;

      // The CLI pairs its resume bootstrap with a zero-token synthetic
      // assistant reply, which carries no error markers and is drawn nowhere.
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
          // `complete` is a PLACEHOLDER here, overwritten by `applyToolResult`
          // the moment the paired result is read — which is where the terminal
          // status is actually decided (DOR-1293).
          //
          // A call whose result never arrives KEEPS it, and that is deliberate.
          // The honest status would be `pending`, but `use-chat-session`'s scan
          // treats a pending interaction anywhere in the transcript as the
          // session waiting on you — so a question orphaned by a turn that died
          // would leave a closed session permanently claiming it needs an
          // answer. `questionOutcome` is a different field, which that scan
          // never reads, so the orphan says "unresolved" there instead (below)
          // and the lie is closed without inventing a live prompt.
          const tc: HistoryToolCall = {
            toolCallId: block.id,
            toolName: block.name,
            input: block.input ? JSON.stringify(block.input) : undefined,
            status: 'complete',
          };
          if (block.name === SDK_TOOL_NAMES.ASK_USER_QUESTION) {
            // Every question starts UNRESOLVED and stays that way unless
            // something says otherwise: `applyToolResult` overwrites it when the
            // paired result arrives, and recorded answers below settle it early.
            // A question that reaches a reader still wearing `unresolved` is one
            // whose transcript records no ending at all.
            tc.questionOutcome = 'unresolved';
          }
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
              // DorkOS writes answers back into the tool's input only after
              // somebody submitted them, so this question is answered NOW — the
              // paired result, when it comes, agrees. (It does not always come:
              // a turn can die between the submission and the result, and this
              // is what keeps that case from reading as unresolved.) A failing
              // result still wins, because `applyToolResult` runs later and a
              // recorded submission that the tool then rejected did not answer
              // anything.
              tc.questionOutcome = 'answered';
            }
          }
          if (block.name === SDK_TOOL_NAMES.SKILL && block.input) {
            const input = block.input as Record<string, unknown>;
            pendingSkillArgs = (input.args as string) || null;
          }
          toolCalls.push(tc);
          toolCallMap.set(block.id, tc);
          const startedAt = epochMs(parsed.timestamp);
          if (startedAt !== undefined) toolCallStartedAt.set(block.id, startedAt);

          const toolCallPart: ToolCallPart = {
            type: 'tool_call',
            toolCallId: block.id,
            toolName: block.name,
            input: block.input ? JSON.stringify(block.input) : undefined,
            status: 'complete',
            // Keyed off the tool NAME, matching `resolveToolCall`: a question
            // whose `questions` failed to parse is still a question, and a part
            // that said otherwise would take the approval arm downstream.
            ...(block.name === SDK_TOOL_NAMES.ASK_USER_QUESTION
              ? {
                  interactiveType: 'question' as const,
                  questions: tc.questions,
                  answers: tc.answers,
                  questionOutcome: tc.questionOutcome,
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
