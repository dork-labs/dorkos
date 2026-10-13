/**
 * The shapes of the records in a Claude Code transcript (JSONL), as the parser
 * and the readers beside it consume them. Split out of `transcript-parser.ts`
 * so that module holds the parsing.
 *
 * @module services/runtimes/claude-code/sessions/transcripts/transcript-records
 */
import type { QuestionItem } from '@dorkos/shared/types';

/** One JSONL record as Claude Code writes it, with the fields DorkOS reads. */
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
   * The AI-generated title on a standalone `type: 'ai-title'` record (no
   * `message`, no `timestamp` — just this field and `sessionId`). The SDK
   * appends a fresh one as the conversation evolves; the transcript can carry
   * many, and the LAST one in file order is the current title.
   */
  aiTitle?: string;
  /**
   * The operator-set title on a standalone `type: 'custom-title'` record,
   * written by `/rename` (SDK `renameSession`). Same shape as `ai-title`:
   * no `message`, no `timestamp`, last one wins.
   */
  customTitle?: string;
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

/** One content block inside a record's message. */
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
