/**
 * Every tool an agent runs inside its own runtime, in the audit log (spec
 * `audit-trail` PR3).
 *
 * Most of what an agent does happens inside Claude Code, Codex or OpenCode:
 * shell commands, file edits, web fetches. Until now that lived only in each
 * runtime's own transcript. {@link recordToolUse} wraps a runtime at the one
 * seam every turn passes through (`core/runtime-seam/decorate-runtime.ts`),
 * watches the turn's tool events, and records one `runtime.tool_used` row per
 * tool call when it finishes. An interactive chat, a room reply, a scheduled
 * run and a relay delivery all resolve their runtime from the registry, so a
 * turn started anywhere is seen, for all three runtimes.
 *
 * ## Helpers
 *
 * A helper agent's own tool calls do not travel on the parent turn's stream.
 * Claude Code reports them through its SDK hooks, which record them through
 * {@link recordRuntimeToolCall} (`runtimes/claude-code/audit-tool-hooks.ts`).
 * Codex runs a helper in a thread of its own that DorkOS does not read, so
 * only the helper's start is recorded (`runtime.helper_started`), not the
 * tools it uses; the guide says so.
 *
 * ## What a row holds, and what it does not
 *
 * The tool's name, a short target (the command, the file, the host and first
 * path segment of an address), the outcome, and the session and tool-call ids
 * that find it in the transcript. Never the tool's full input or output: those
 * stay in the transcript, where they already are. The audit writer sweeps the
 * target (its id as well as its name) for anything that looks like a secret.
 *
 * ## What it skips
 *
 * DorkOS's own tools, as this runtime spells them (`mcp__dorkos__*` for Claude
 * Code and Codex, `dorkos_*` for OpenCode, the bare registered name for Doe):
 * the server records those itself, with more to say, when they reach the tool
 * gate.
 *
 * ## A turn that ends with a tool still running
 *
 * A tool can outlive the reply that started it: Codex runs background
 * commands, and an interrupted turn leaves a tool unanswered. Such a call is
 * recorded once as `runtime.tool_started` ("still running when the reply
 * ended"), and remembered for its session, so if its result arrives in a later
 * turn it is recorded once as `runtime.tool_used` with the real outcome. A
 * call is never recorded twice as finished, and never as failed on a guess.
 * The wrapper never changes what a turn yields or how it ends.
 *
 * @module services/audit/record-tool-use
 */
import path from 'node:path';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AuditActor, AuditOperation, AuditTarget } from '@dorkos/shared/audit-schemas';
import {
  CLAUDE_CODE_DORKOS_TOOL_PREFIX,
  CODEX_DORKOS_TOOL_PREFIX,
  OPENCODE_DORKOS_TOOL_PREFIX,
} from '../runtimes/shared/dorkos-tool-names.js';
import { homeOf, resolveAgentHome, turnAgentOf } from '../core/agent-identity/agent-home.js';
import { MCP_TOOL_TIERS } from '../core/mcp-tool-tiers.js';
import { auditTrail, recordAudit } from './audit-trail.js';
import { redactAuditText } from './audit-redaction.js';

/** The most of a tool's input kept while it streams in, to read its target. */
const MAX_INPUT = 8_000;

/** The longest target a row records. */
const MAX_TARGET = 200;

/** Sessions whose calls are remembered across turns; the oldest is forgotten first. */
const MAX_REMEMBERED_SESSIONS = 500;

/** Calls remembered per session; the oldest is forgotten first. */
const MAX_REMEMBERED_CALLS = 2_000;

/** Tools that only read: recorded as `access`, everything else as `execute`. */
const READ_ONLY_TOOLS = new Set(
  [
    'Read',
    'Grep',
    'Glob',
    'LS',
    'WebFetch',
    'WebSearch',
    'NotebookRead',
    'TodoRead',
    'read',
    'grep',
    'glob',
    'list',
    'webfetch',
    'websearch',
  ].map((name) => name.toLowerCase())
);

/** How each runtime spells a DorkOS tool's name. */
const DORKOS_PREFIX: Record<string, string> = {
  'claude-code': CLAUDE_CODE_DORKOS_TOOL_PREFIX,
  codex: CODEX_DORKOS_TOOL_PREFIX,
  opencode: OPENCODE_DORKOS_TOOL_PREFIX,
};

/**
 * Whether a tool is one of DorkOS's own, as this runtime spells it. Only the
 * runtime's own spelling counts: OpenCode's `dorkos_` would otherwise swallow a
 * user's tool that happens to start with the same word on another runtime.
 *
 * @param runtime - The runtime's type.
 * @param name - The tool's name as that runtime reported it.
 */
export function isDorkosTool(runtime: string, name: string): boolean {
  // Doe hands the model DorkOS's tools under their bare registered names.
  if (runtime === 'doe') return Object.hasOwn(MCP_TOOL_TIERS, name);
  const prefix = DORKOS_PREFIX[runtime];
  return prefix !== undefined && name.startsWith(prefix);
}

/** Parse a tool's input as JSON, or `undefined` when it is not. */
function parseInput(input: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The first string among `keys` in `input`. */
function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
      return value.join(' ');
    }
  }
  return undefined;
}

/**
 * A web address cut to its host and first path segment: enough to say where a
 * request went, and short of where secrets ride (deeper path segments such as
 * a webhook's key, the query, the fragment).
 *
 * @param url - The address.
 */
export function addressOf(url: string): string {
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split('/').filter(Boolean)[0];
    return `${parsed.host}${first ? `/${first}` : ''}`;
  } catch {
    return url.split(/[?#]/)[0]?.split('/').slice(0, 4).join('/') ?? url;
  }
}

/**
 * A target value swept for secrets, then cut to {@link MAX_TARGET}. Swept
 * BEFORE it is cut: cutting first can leave the start of a key too short for
 * the sweep to recognise. The writer sweeps again, which is free.
 */
function clip(value: string): string {
  const swept = redactAuditText(value);
  return swept.length <= MAX_TARGET ? swept : `${swept.slice(0, MAX_TARGET - 1)}…`;
}

/**
 * What a tool call acted on, read off its input: the command it ran, the file
 * it touched, the address it fetched. `null` when nothing recognisable names
 * one. The audit writer redacts both fields before anything is stored.
 *
 * @param name - The tool's name as the runtime reported it.
 * @param input - The tool's input as it streamed in (usually JSON).
 */
export function toolTarget(name: string, input: string): AuditTarget | null {
  const lower = name.toLowerCase();
  if (lower.startsWith('mcp__')) return { type: 'mcp-tool', id: clip(name), name: clip(name) };
  const parsed = parseInput(input);
  if (lower === 'applypatch') {
    // Codex names a patch's files as `{changes: [{path, kind}]}`; a raw patch
    // names them in its `*** Update File:` lines. The first file is the target,
    // and a patch touching more says how many.
    const changes = parsed?.changes;
    const files = Array.isArray(changes)
      ? changes
          .map((change: unknown) => (change as { path?: unknown })?.path)
          .filter((file): file is string => typeof file === 'string')
      : [...input.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => m[1]!.trim());
    if (files.length === 0) return null;
    const first = clip(files[0]!);
    const more = files.length > 1 ? ` and ${files.length - 1} more` : '';
    return { type: 'file', id: first, name: `${clip(path.basename(first))}${more}` };
  }
  if (!parsed) return null;
  const command = firstString(parsed, ['command', 'cmd']);
  if (command && (lower === 'bash' || lower === 'shell')) {
    return { type: 'command', id: clip(command), name: clip(command) };
  }
  const url = firstString(parsed, ['url']);
  if (url) {
    const address = clip(addressOf(url));
    return { type: 'url', id: address, name: address };
  }
  const file = firstString(parsed, ['file_path', 'filePath', 'path', 'notebook_path']);
  if (file) return { type: 'file', id: clip(file), name: clip(path.basename(file)) };
  const query = firstString(parsed, ['query', 'pattern']);
  if (query) return { type: 'search', id: clip(query), name: clip(query) };
  if (command) return { type: 'command', id: clip(command), name: clip(command) };
  return null;
}

/** Whether a tool only reads. */
function operationOf(name: string): AuditOperation {
  return READ_ONLY_TOOLS.has(name.toLowerCase()) ? 'access' : 'execute';
}

/**
 * Who a turn's tool calls are by: the agent whose home the turn stands in
 * (a worktree or subfolder of a home counts as that home), or the agent the
 * turn was dispatched as, resolved exactly as every other turn-path identity
 * check resolves it (`resolveAgentHome`). A turn standing in no agent's home
 * is an agent DorkOS cannot name.
 *
 * @param runtime - The runtime's type, for the name of an agent it cannot name.
 * @param opts - The turn's options.
 */
export function toolActorOf(
  runtime: string,
  opts: Pick<MessageOpts, 'cwd' | 'forAgent' | 'roomTurn'> | undefined
): AuditActor | undefined {
  const trail = auditTrail();
  if (!trail) return undefined;
  const home = homeOf(resolveAgentHome(opts?.cwd, turnAgentOf(opts)));
  return home
    ? trail.accounts.agentAtHome(home)
    : trail.accounts.unidentified(`A ${runtime} session outside any agent's home`);
}

/** One tool call to record. */
export interface RuntimeToolCall {
  /** The runtime's type. */
  runtime: string;
  /** The session it ran in. */
  sessionId: string;
  /** The runtime's id for the call. */
  toolCallId: string;
  /** The tool's name. */
  name: string;
  /** The tool's input as the runtime reported it. */
  input: string;
  /** Who ran it. */
  actor: AuditActor;
  /** The helper agent that ran it, when not the session's own agent. */
  helperId?: string;
  /** What it acted on, already read off its input; when set, `input` is not read. */
  target?: AuditTarget | null;
}

/**
 * Calls already recorded as finished, per session, kept across turns so a
 * result that arrives in a later turn, or by a second route, is recorded once.
 * Bounded both ways; a forgotten call can at worst be recorded twice.
 */
const finished = new Map<string, Set<string>>();

/** Calls recorded as still running, per session, waiting for their result. */
const stillRunning = new Map<string, Map<string, RuntimeToolCall>>();

/** The set for a session in `map`, creating it and forgetting the oldest session when full. */
function bucket<V>(map: Map<string, V>, sessionId: string, make: () => V): V {
  let value = map.get(sessionId);
  if (value === undefined) {
    if (map.size >= MAX_REMEMBERED_SESSIONS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    value = make();
    map.set(sessionId, value);
  }
  return value;
}

/** Whether a call was already recorded as finished. */
function isFinished(sessionId: string, toolCallId: string): boolean {
  return finished.get(sessionId)?.has(toolCallId) === true;
}

/** Remember a call as finished. */
function markFinished(sessionId: string, toolCallId: string): void {
  const set = bucket(finished, sessionId, () => new Set<string>());
  if (set.size >= MAX_REMEMBERED_CALLS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(toolCallId);
  stillRunning.get(sessionId)?.delete(toolCallId);
}

/**
 * Record one finished tool call, once. The shared path for the stream wrapper
 * and the Claude Code SDK hooks, which can both see a call; whichever reports
 * it first wins.
 *
 * @param call - The call.
 * @param outcome - How it came out.
 * @param error - What went wrong, when it failed.
 */
export function recordRuntimeToolCall(
  call: RuntimeToolCall,
  outcome: 'ok' | 'failed',
  error?: string
): void {
  if (isFinished(call.sessionId, call.toolCallId)) return;
  if (isDorkosTool(call.runtime, call.name)) return;
  markFinished(call.sessionId, call.toolCallId);
  const target = call.target !== undefined ? call.target : toolTarget(call.name, call.input);
  recordAudit({
    actor: call.actor,
    source: {
      surface: 'runtime-tool',
      runtime: call.runtime,
      sessionId: call.sessionId,
      toolCallId: call.toolCallId,
    },
    action: 'runtime.tool_used',
    operation: operationOf(call.name),
    target,
    outcome,
    ...(error ? { error } : {}),
    ...(call.helperId ? { links: { causedBy: `helper:${call.helperId}` } } : {}),
    summary: `${outcome === 'ok' ? 'Used' : 'Tried'} ${call.name}${
      call.helperId ? ' (in a helper)' : ''
    }${target?.name ? `: ${target.name}` : ''}`,
  });
}

/**
 * Record a call the turn ended without a result for, and remember it so a
 * later result settles it once.
 *
 * @param call - The call.
 */
function recordStillRunning(call: RuntimeToolCall): void {
  if (isFinished(call.sessionId, call.toolCallId)) return;
  const waiting = bucket(stillRunning, call.sessionId, () => new Map<string, RuntimeToolCall>());
  if (waiting.has(call.toolCallId)) return;
  if (waiting.size >= MAX_REMEMBERED_CALLS) {
    const oldest = waiting.keys().next().value;
    if (oldest !== undefined) waiting.delete(oldest);
  }
  const target = toolTarget(call.name, call.input);
  // Remember the target, not the input: an input can be 8 KB, a target 200 bytes.
  waiting.set(call.toolCallId, { ...call, input: '', target });
  recordAudit({
    actor: call.actor,
    source: {
      surface: 'runtime-tool',
      runtime: call.runtime,
      sessionId: call.sessionId,
      toolCallId: call.toolCallId,
    },
    action: 'runtime.tool_started',
    operation: operationOf(call.name),
    target,
    outcome: 'ok',
    summary: `Began ${call.name}${target?.name ? `: ${target.name}` : ''}; no result before the reply ended`,
  });
}

/** Forget every remembered call. For tests. */
export function resetRecordedToolCalls(): void {
  finished.clear();
  stillRunning.clear();
}

/** Read a tool event's fields defensively. */
function toolFields(event: StreamEvent): {
  id: string;
  name: string;
  input?: string;
  status?: string;
} {
  const data = (event.data ?? {}) as Record<string, unknown>;
  return {
    id: typeof data.toolCallId === 'string' ? data.toolCallId : '',
    name: typeof data.toolName === 'string' ? data.toolName : '',
    ...(typeof data.input === 'string' ? { input: data.input } : {}),
    ...(typeof data.status === 'string' ? { status: data.status } : {}),
  };
}

async function* recordDuring(
  runtime: AgentRuntime,
  sessionId: string,
  opts: MessageOpts | undefined,
  source: AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  /**
   * Calls seen and not yet settled. `inputDone` says the runtime finished
   * sending the input, so the tool was at least asked to run: a call cut off
   * while its input was still streaming in never ran and is not recorded.
   */
  const pending = new Map<string, { name: string; input: string; inputDone: boolean }>();
  /** Every tool call id this turn saw, so a helper the runtime started through one is not counted again. */
  const seen = new Set<string>();
  let actor: AuditActor | undefined;
  const actorOf = (): AuditActor | undefined => (actor ??= toolActorOf(runtime.type, opts));
  const callOf = (
    toolCallId: string,
    call: { name: string; input: string }
  ): RuntimeToolCall | undefined => {
    const who = actorOf();
    return who
      ? {
          runtime: runtime.type,
          sessionId,
          toolCallId,
          actor: who,
          name: call.name,
          input: call.input,
        }
      : undefined;
  };

  /** Watch one event. Guarded by the caller: recording is never worth a turn. */
  const watch = (event: StreamEvent): void => {
    if (event.type === 'background_task_started') {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const taskId = typeof data.taskId === 'string' ? data.taskId : '';
      const viaCall = typeof data.toolUseId === 'string' ? data.toolUseId : taskId;
      // A helper started by a tool call this turn already shows as that call.
      if (data.taskType !== 'agent' || !taskId || seen.has(taskId) || seen.has(viaCall)) return;
      const who = actorOf();
      if (!who) return;
      const description = typeof data.description === 'string' ? data.description : '';
      recordAudit({
        actor: who,
        source: { surface: 'runtime-tool', runtime: runtime.type, sessionId, toolCallId: taskId },
        action: 'runtime.helper_started',
        operation: 'execute',
        target: { type: 'helper', id: taskId, ...(description ? { name: description } : {}) },
        outcome: 'ok',
        summary: `Started a helper${description ? `: ${description}` : ''}`,
      });
      return;
    }
    if (
      event.type !== 'tool_call_start' &&
      event.type !== 'tool_call_delta' &&
      event.type !== 'tool_call_end' &&
      event.type !== 'tool_result'
    ) {
      return;
    }
    const fields = toolFields(event);
    if (!fields.id) return;
    seen.add(fields.id);
    if (isFinished(sessionId, fields.id)) return;
    // A result for a call an earlier turn left running settles it now.
    const earlier = stillRunning.get(sessionId)?.get(fields.id);
    let call = pending.get(fields.id);
    if (!call && earlier) {
      call = { name: earlier.name, input: earlier.input, inputDone: true };
      pending.set(fields.id, call);
    }
    if (!call) {
      if (!fields.name || isDorkosTool(runtime.type, fields.name)) return;
      call = { name: fields.name, input: '', inputDone: false };
      pending.set(fields.id, call);
    }
    // Claude streams its input in deltas and closes it with `tool_call_end`;
    // the other runtimes send it whole, on the start or the result.
    if (
      event.type === 'tool_call_end' ||
      (event.type !== 'tool_call_delta' && fields.input !== undefined && fields.input !== '')
    ) {
      call.inputDone = true;
    }
    if (fields.input !== undefined && call.input.length < MAX_INPUT) {
      // Claude streams its input in pieces; Codex and OpenCode send it whole.
      call.input =
        event.type === 'tool_call_delta'
          ? (call.input + fields.input).slice(0, MAX_INPUT)
          : fields.input.slice(0, MAX_INPUT);
    }
    // Only a terminal status settles a call. Claude's `tool_call_end` means the
    // INPUT finished streaming, with the tool still in flight (DOR-2011).
    if (fields.status === 'complete' || fields.status === 'error') {
      pending.delete(fields.id);
      const finishedCall = earlier ?? callOf(fields.id, call);
      if (finishedCall) {
        recordRuntimeToolCall(
          { ...finishedCall, input: call.input || finishedCall.input },
          fields.status === 'complete' ? 'ok' : 'failed'
        );
      }
    }
  };
  try {
    for await (const event of source) {
      try {
        watch(event);
      } catch {
        // Recording is never worth a turn.
      }
      yield event;
    }
  } finally {
    for (const [toolCallId, call] of pending) {
      if (!call.inputDone) continue;
      try {
        const running = callOf(toolCallId, call);
        if (running) recordStillRunning(running);
      } catch {
        // Recording is never worth a turn.
      }
    }
  }
}

/**
 * Wrap a runtime so every tool call in its turns is recorded in the audit log.
 *
 * @param runtime - The runtime to wrap.
 * @returns A proxy over the runtime that watches its tool events.
 */
export function recordToolUse(runtime: AgentRuntime): AgentRuntime {
  return new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (
          sessionId: string,
          content: string,
          opts?: MessageOpts
        ): AsyncGenerator<StreamEvent> =>
          recordDuring(target, sessionId, opts, target.sendMessage(sessionId, content, opts));
      }
      // Receiver is the real target (not the proxy) so getters/methods that
      // touch private fields resolve against the instance that owns them.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
