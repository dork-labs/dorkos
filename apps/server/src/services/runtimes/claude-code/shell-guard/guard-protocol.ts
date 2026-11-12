/**
 * What the server and the shell guard's child process say to each other (DOR-3300).
 *
 * @module services/runtimes/claude-code/shell-guard/guard-protocol
 */
import type { ShellCheckAnswer } from './shell-check.js';

/** The folders a check is measured from, as plain data: what crosses to the child. */
export interface WireRoots {
  cwd: string;
  dorkHome: string;
  home: string;
  config?: string;
  accounts: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  agentHomes: readonly string[];
  openHome?: string;
  full?: boolean;
}

/** The server asks the child about one command. */
export interface GuardRequest {
  id: number;
  command: string;
  roots: WireRoots;
  reads: boolean;
}

/** The child's first message: it started, it holds no power to change anything, and it can answer. */
export interface GuardReady {
  type: 'ready';
}

/** The child's answer about one command. */
export interface GuardAnswer {
  type: 'answer';
  id: number;
  answer: ShellCheckAnswer;
}

/** Whether a message from the child is its ready message. */
export function isGuardReady(message: unknown): message is GuardReady {
  return (message as GuardReady | null)?.type === 'ready';
}

/** The answer in a child's message, or `null` when it isn't one: anything else counts as a failure. */
export function answerFrom(message: unknown, id: number): ShellCheckAnswer | null {
  const candidate = message as Partial<GuardAnswer> | null;
  if (candidate?.type !== 'answer' || candidate.id !== id) return null;
  const answer = candidate.answer;
  if (typeof answer?.reaches !== 'boolean') return null;
  return ['writes', 'unreadable', 'none'].includes(answer.write) ? answer : null;
}
