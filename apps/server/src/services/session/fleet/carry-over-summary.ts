/**
 * The default background a carried-over session starts with (spec
 * `claude-account-fleet` D9, "Carry-over"): a mechanical digest of where the
 * previous session stopped, written so it stands on its own.
 *
 * **No model is ever called here, on any path.** The account the work is moving
 * off has run out, so it cannot run one, and a digest built from facts is the
 * same every time it is built. What it holds: the previous session and account,
 * the limit and its reset, the folder, git branch, `git status --short` and
 * `git diff --stat`, the files the session edited, its last tool step, its
 * first request and its last six messages, then a pointer to the full
 * transcript. Tool output is never included.
 *
 * {@link extractTranscriptFacts} and {@link buildCarryOverSummary} are pure;
 * {@link gatherCarryOverSummary} reads git and the transcript through injected
 * lookups.
 *
 * @module services/session/fleet/carry-over-summary
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HistoryMessage } from '@dorkos/shared/types';
import { SEED_CONTEXT_MAX_LENGTH } from '@dorkos/shared/schemas';
import { internalGitArgs } from '../../../lib/git-safety.js';
import { isInsideRoomsDir } from '../../core/agent-identity/index.js';
import { projectSlug } from '../../runtimes/claude-code/sessions/project-slug.js';

/** How many recent user and assistant messages the summary keeps. */
export const RECENT_MESSAGE_COUNT = 6;

/** The longest a kept message may be, in characters. */
export const MESSAGE_MAX_CHARS = 800;

/** The longest one git section may be, in characters. */
export const GIT_SECTION_MAX_CHARS = 2_000;

/** How many trailing transcript messages are scanned for edited files. */
const TOUCHED_FILES_SCAN = 200;

/** The tools whose target is a file the session changed. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** The closing line the spec quotes, after the transcript pointer. */
export const TRANSCRIPT_POINTER_LINE =
  'If you need more than this summary, read the end of that file first.';

/** One kept message. */
export interface SummaryMessage {
  /** Who said it. */
  role: 'user' | 'assistant';
  /** What was said, trimmed. */
  text: string;
}

/** What a transcript contributes to the summary. */
export interface TranscriptFacts {
  /** Files the session edited, in the order first touched. */
  touchedFiles: string[];
  /** The last tool the session ran, and what it ran on. */
  lastToolStep?: { name: string; target?: string };
  /** The session's first request. */
  firstUserMessage?: string;
  /** The last {@link RECENT_MESSAGE_COUNT} user and assistant messages, oldest first. */
  recentMessages: SummaryMessage[];
}

/** Everything the summary is built from. */
export interface CarryOverSummaryInput extends TranscriptFacts {
  /** The previous session's id. */
  sessionId: string;
  /** What the operator calls the account that ran out. */
  accountLabel: string;
  /** The window that stopped the turn. */
  window: string;
  /** When it resets, or `null` when unknown. */
  resetsAt: string | null;
  /** The folder the session worked in. */
  cwd: string;
  /** The git branch, when the folder is a repository. */
  gitBranch?: string;
  /** `git status --short`, bounded. */
  gitStatus?: string;
  /** `git diff --stat`, bounded. */
  gitDiffStat?: string;
  /** The previous transcript's absolute path, when known. */
  transcriptPath: string | null;
}

/** Cut a string to `max` characters, marking the cut. */
function bound(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function parseInput(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What a tool ran on, read from its input: a file, a path, a command, a pattern or a URL. */
function targetOf(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return bound(value, 200);
  }
  return undefined;
}

/** Whether a message is a plain user or assistant message (not a command, a compaction, …). */
function isConversation(message: HistoryMessage): boolean {
  return message.messageType === undefined;
}

/**
 * Read the facts the summary needs out of a transcript. Pure; tool output is
 * never read.
 *
 * @param messages - The transcript, oldest first.
 */
export function extractTranscriptFacts(messages: readonly HistoryMessage[]): TranscriptFacts {
  const touched: string[] = [];
  const seen = new Set<string>();
  let lastToolStep: TranscriptFacts['lastToolStep'];
  for (const message of messages.slice(-TOUCHED_FILES_SCAN)) {
    for (const call of message.toolCalls ?? []) {
      const input = parseInput(call.input);
      const target = targetOf(input);
      lastToolStep = { name: call.toolName, ...(target ? { target } : {}) };
      if (!EDIT_TOOLS.has(call.toolName)) continue;
      const file = input.file_path ?? input.notebook_path;
      if (typeof file === 'string' && file && !seen.has(file)) {
        seen.add(file);
        touched.push(file);
      }
    }
  }
  const conversation = messages.filter((m) => isConversation(m) && m.content.trim().length > 0);
  const first = conversation.find((m) => m.role === 'user');
  const recentMessages = conversation.slice(-RECENT_MESSAGE_COUNT).map((m) => ({
    role: m.role,
    text: bound(m.content, MESSAGE_MAX_CHARS),
  }));
  return {
    touchedFiles: touched,
    ...(lastToolStep ? { lastToolStep } : {}),
    ...(first ? { firstUserMessage: bound(first.content, MESSAGE_MAX_CHARS) } : {}),
    recentMessages,
  };
}

/** A window key in words. */
function windowWords(window: string): string {
  if (window === 'five_hour') return 'the 5-hour limit';
  if (window === 'seven_day') return 'the weekly limit';
  if (window === 'seven_day_opus') return 'the weekly Opus limit';
  if (window === 'seven_day_sonnet') return 'the weekly Sonnet limit';
  if (window === 'unknown') return 'its usage limit';
  return `the ${window} limit`;
}

function render(input: CarryOverSummaryInput, recent: SummaryMessage[], withDiff: boolean): string {
  const lines: string[] = [
    'This session continues work from another session, which stopped because its Claude account ran out of usage. Here is where it stopped.',
    '',
    `Previous session: ${input.sessionId}, on ${input.accountLabel}.`,
    `It hit ${windowWords(input.window)}${input.resetsAt ? `, which resets at ${input.resetsAt}` : ''}.`,
    `Folder: ${input.cwd}`,
  ];
  if (input.gitBranch) lines.push(`Git branch: ${input.gitBranch}`);
  if (input.gitStatus) lines.push('', 'git status --short:', input.gitStatus);
  if (withDiff && input.gitDiffStat) lines.push('', 'git diff --stat:', input.gitDiffStat);
  if (input.touchedFiles.length > 0) {
    lines.push('', 'Files it edited:', ...input.touchedFiles.map((f) => `- ${f}`));
  }
  if (input.lastToolStep) {
    const { name, target } = input.lastToolStep;
    lines.push('', `Its last step: ${name}${target ? ` on ${target}` : ''}`);
  }
  if (input.firstUserMessage) lines.push('', 'The first request:', input.firstUserMessage);
  if (recent.length > 0) {
    lines.push('', 'The last messages, oldest first:');
    for (const message of recent) lines.push(`[${message.role}] ${message.text}`);
  }
  if (input.transcriptPath) {
    lines.push(
      '',
      `The full transcript is ${input.transcriptPath} (session ${input.sessionId}). ${TRANSCRIPT_POINTER_LINE}`
    );
  }
  return lines.join('\n');
}

/**
 * Build the summary, capped at `SEED_CONTEXT_MAX_LENGTH`: over the cap, the
 * oldest kept message goes first, then the diff stat, and only then is the
 * whole cut.
 *
 * @param input - The facts to summarize.
 */
export function buildCarryOverSummary(input: CarryOverSummaryInput): string {
  const recent = [...input.recentMessages];
  let text = render(input, recent, true);
  while (text.length > SEED_CONTEXT_MAX_LENGTH && recent.length > 0) {
    recent.shift();
    text = render(input, recent, true);
  }
  if (text.length > SEED_CONTEXT_MAX_LENGTH) text = render(input, recent, false);
  return text.length > SEED_CONTEXT_MAX_LENGTH ? bound(text, SEED_CONTEXT_MAX_LENGTH) : text;
}

/** The lookups {@link gatherCarryOverSummary} needs. */
export interface SummaryDeps {
  /** Run git in a folder; its output, or `undefined` on any failure. */
  runGit: (cwd: string, args: string[]) => Promise<string | undefined>;
  /** The session's transcript, oldest first. */
  readHistory: () => Promise<HistoryMessage[]>;
}

const execFileAsync = promisify(execFile);

/**
 * Run git through the repo's hardened arguments, bounded in time, never inside
 * a room's files, and answer `undefined` on any failure.
 *
 * @param cwd - The folder.
 * @param args - The git arguments.
 */
export async function runGitForSummary(cwd: string, args: string[]): Promise<string | undefined> {
  if (isInsideRoomsDir(cwd)) return undefined;
  try {
    const { stdout } = await execFileAsync('git', [...internalGitArgs(), ...args], {
      cwd,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * Where a Claude Code session's transcript lives: `<account>/projects/<slug>/<id>.jsonl`.
 *
 * @param accountPath - The account folder the session ran in, or `null`.
 * @param cwd - The session's folder.
 * @param sessionId - The session's id.
 */
export function claudeTranscriptPath(
  accountPath: string | null,
  cwd: string,
  sessionId: string
): string | null {
  if (!accountPath) return null;
  return path.join(accountPath, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Gather the facts and build the summary. A git or transcript failure leaves
 * its section out; the summary is still built.
 *
 * @param base - What is known about the session without reading anything.
 * @param deps - The git and transcript lookups.
 */
export async function gatherCarryOverSummary(
  base: Pick<
    CarryOverSummaryInput,
    'sessionId' | 'accountLabel' | 'window' | 'resetsAt' | 'cwd' | 'transcriptPath'
  >,
  deps: SummaryDeps
): Promise<string> {
  const git = (args: string[]) =>
    deps
      .runGit(base.cwd, args)
      .then((out) => (out?.trim() ? bound(out, GIT_SECTION_MAX_CHARS) : undefined))
      .catch(() => undefined);
  const [gitBranch, gitStatus, gitDiffStat, history] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--short']),
    git(['diff', '--stat']),
    deps.readHistory().catch(() => [] as HistoryMessage[]),
  ]);
  return buildCarryOverSummary({
    ...base,
    ...(gitBranch ? { gitBranch } : {}),
    ...(gitStatus ? { gitStatus } : {}),
    ...(gitDiffStat ? { gitDiffStat } : {}),
    ...extractTranscriptFacts(history),
  });
}
