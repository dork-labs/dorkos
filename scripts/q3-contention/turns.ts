/**
 * Concurrent turn firing and observation for the Q3 contention harness
 * (DOR-500).
 *
 * `POST /api/sessions/:id/messages` is trigger-only (ADR-0264): it returns 202
 * within milliseconds and all delivery rides the durable SSE stream. So every
 * turn is fired in one `Promise.all` and the agents genuinely start together.
 * Driving this through a browser or an MCP tool was rejected — that automation
 * latency serializes the agents and destroys the thing being measured.
 *
 * Each agent's interval is taken from the timestamps the SCENARIO reports
 * (`[q3-start]` / `[q3-summary]`), which are read off one clock inside the
 * server process. The harness's own observations are recorded alongside them as
 * a cross-check, but the overlap proof does not depend on request latency.
 *
 * @module scripts/q3-contention/turns
 */
import { randomUUID } from 'crypto';
import type { AgentPlan, RunPlan } from './plan.js';
import type { RunPaths } from './provision.js';
import type { TurnProbe } from './sampler.js';

/** Everything observed about one agent's turn. */
export interface TurnResult {
  readonly index: number;
  readonly vocab: string;
  readonly tree: string;
  readonly sessionId: string;
  /** Harness clock: immediately before the trigger POST. */
  readonly firedAtMs: number;
  /** Harness clock: first `text_delta` frame observed, or 0 if none. */
  readonly firstDeltaAtMs: number;
  /** Harness clock: `turn_end` frame observed, or 0 if none. */
  readonly observedEndMs: number;
  /** Server clock, agent-reported. Falls back to the harness clock in arm 3. */
  readonly startedAtMs: number;
  /** Server clock, agent-reported. Falls back to the harness clock in arm 3. */
  readonly endedAtMs: number;
  /** `agent` when the interval came from the scenario markers, else `harness`. */
  readonly timestampSource: 'agent' | 'harness';
  /** `turn_end.terminalReason`, `ok` when absent, or a failure string. */
  readonly terminalReason: string;
  /** Ticks the scenario completed, or -1 when unreported. */
  readonly ticks: number;
  /** Canary lines the scenario says it wrote, or -1 when unreported. */
  readonly appends: number;
  /** Canary writes that threw inside the scenario, or -1 when unreported. */
  readonly canaryErrors: number;
  /** Tagged tokens in this session's stream belonging to another vocabulary. */
  readonly crossedTokens: number;
}

/** Prompt for arm 3, where a real agent must be told to do the canary work. */
function realRuntimePrompt(agent: AgentPlan, canaryPath: string, iterations: number): string {
  return [
    `You are agent "${agent.vocab}" in a filesystem contention measurement. Do exactly this and nothing else.`,
    `Repeat ${iterations} times, with i counting from 0:`,
    `  1. Read the ENTIRE file ${canaryPath}.`,
    `  2. Append one line: "${agent.vocab} <i> <current ISO timestamp>".`,
    `  3. Write the entire file back, replacing it.`,
    `Do not use append mode, a lock, or an atomic rename. Read the whole file and rewrite the whole file each time.`,
    `Do not read, write, or modify any other file. Do not run git.`,
    `When finished, reply with exactly one line: "[q3-summary] vocab=${agent.vocab} ticks=${iterations} appends=<lines you wrote> canaryErrors=<writes that failed>".`,
  ].join('\n');
}

/** Parsed `key=value` pairs from a scenario marker line. */
function parseMarker(text: string, marker: string): Record<string, string> | null {
  const index = text.lastIndexOf(marker);
  if (index === -1) return null;
  const line = text.slice(index + marker.length).split('\n')[0] ?? '';
  const out: Record<string, string> = {};
  for (const pair of line.trim().split(/\s+/)) {
    const [key, value] = pair.split('=');
    if (key && value !== undefined) out[key] = value;
  }
  return out;
}

/** Count tagged tokens (`vocab:WORD#00001`) that belong to another vocabulary. */
function countCrossedTokens(text: string, expectedVocab: string): number {
  let crossed = 0;
  for (const match of text.matchAll(/\b([a-z]+):[A-Z]+#\d+\b/g)) {
    if (match[1] !== expectedVocab) crossed++;
  }
  return crossed;
}

/** One SSE frame off the durable session stream. */
interface Frame {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** Split an SSE buffer into complete frames, returning the unconsumed tail. */
function drainFrames(buffer: string): { frames: Frame[]; rest: string } {
  const frames: Frame[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (!event || !data) continue;
    try {
      frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    } catch {
      // A frame we cannot parse is not a reason to abandon the stream.
    }
  }
  return { frames, rest };
}

/** Mutable accumulator for one in-flight turn. */
interface TurnState {
  text: string;
  firstDeltaAtMs: number;
  observedEndMs: number;
  terminalReason: string;
  ended: boolean;
}

/**
 * Read the durable `/events` stream from the beginning until the turn closes.
 *
 * `?after=0` replays the whole log gap-free, so subscribing just after the
 * trigger POST cannot miss the turn's opening frames.
 */
async function consumeTurnStream(
  baseUrl: string,
  sessionId: string,
  cwd: string,
  state: TurnState,
  signal: AbortSignal
): Promise<void> {
  const url = `${baseUrl}/api/sessions/${sessionId}/events?after=0&cwd=${encodeURIComponent(cwd)}`;
  const res = await fetch(url, { signal, headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`[q3] /events returned ${res.status}`);

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const { frames, rest } = drainFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      if (frame.event === 'text_delta') {
        if (state.firstDeltaAtMs === 0) state.firstDeltaAtMs = Date.now();
        state.text += String(frame.data.text ?? '');
      } else if (frame.event === 'turn_end') {
        state.observedEndMs = Date.now();
        state.terminalReason = String(frame.data.terminalReason ?? 'ok');
        state.ended = true;
        return;
      }
    }
  }
}

/** Assemble the final {@link TurnResult} from the accumulated stream state. */
function summarize(
  agent: AgentPlan,
  sessionId: string,
  firedAtMs: number,
  state: TurnState
): TurnResult {
  const start = parseMarker(state.text, '[q3-start]');
  const summary = parseMarker(state.text, '[q3-summary]');
  const agentStart = Number(start?.startedAt ?? summary?.startedAt ?? NaN);
  const agentEnd = Number(summary?.endedAt ?? NaN);
  const haveAgentClock = Number.isFinite(agentStart) && Number.isFinite(agentEnd);

  return {
    index: agent.index,
    vocab: agent.vocab,
    tree: agent.tree,
    sessionId,
    firedAtMs,
    firstDeltaAtMs: state.firstDeltaAtMs,
    observedEndMs: state.observedEndMs,
    startedAtMs: haveAgentClock ? agentStart : state.firstDeltaAtMs || firedAtMs,
    endedAtMs: haveAgentClock ? agentEnd : state.observedEndMs,
    timestampSource: haveAgentClock ? 'agent' : 'harness',
    terminalReason: state.terminalReason,
    ticks: Number(summary?.ticks ?? -1),
    appends: Number(summary?.appends ?? -1),
    canaryErrors: Number(summary?.canaryErrors ?? -1),
    crossedTokens: countCrossedTokens(state.text, agent.vocab),
  };
}

/** Bind a `q3-*` scenario to a session before its first message. */
async function bindScenario(baseUrl: string, sessionId: string, vocab: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/test/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `q3-${vocab}`, sessionId }),
  });
  if (!res.ok) {
    throw new Error(`[q3] scenario bind for ${vocab} failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Fire every agent's turn concurrently and observe each one to completion.
 *
 * @param plan - The resolved run plan.
 * @param paths - Throwaway paths from `provision()`.
 * @param baseUrl - Base URL of the throwaway server.
 * @param tracker - Receives live turn state for the sampler; mutated in place.
 * @returns One result per agent, in plan order.
 */
export async function fireConcurrentTurns(
  plan: RunPlan,
  paths: RunPaths,
  baseUrl: string,
  tracker: MutableTurnTracker
): Promise<TurnResult[]> {
  const sessions = plan.agents.map((agent) => ({ agent, sessionId: randomUUID() }));

  // Bind scenarios BEFORE any turn starts; binding is keyed by the
  // client-supplied session id, which test-mode never re-keys.
  if (plan.testMode) {
    for (const { agent, sessionId } of sessions) {
      await bindScenario(baseUrl, sessionId, agent.vocab);
    }
  }

  // The concurrency itself: N trigger POSTs in flight at once. Each returns 202
  // in milliseconds, so the agents begin within milliseconds of each other.
  return Promise.all(
    sessions.map(({ agent, sessionId }) =>
      runOneTurn(plan, paths, baseUrl, agent, sessionId, tracker)
    )
  );
}

/** Fire and observe a single agent's turn. */
async function runOneTurn(
  plan: RunPlan,
  paths: RunPaths,
  baseUrl: string,
  agent: AgentPlan,
  sessionId: string,
  tracker: MutableTurnTracker
): Promise<TurnResult> {
  const cwd = paths.trees[agent.tree];
  const content = plan.testMode
    ? `q3 ${agent.vocab}`
    : realRuntimePrompt(
        agent,
        paths.canaries[agent.tree],
        Math.ceil(plan.durationMs / plan.tickMs)
      );

  const state: TurnState = {
    text: '',
    firstDeltaAtMs: 0,
    observedEndMs: 0,
    terminalReason: 'no-turn-end',
    ended: false,
  };
  tracker.markStarted(agent.vocab);
  const firedAtMs = Date.now();

  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': `q3-${agent.vocab}` },
    body: JSON.stringify({
      content,
      cwd,
      ...(plan.testMode ? {} : { runtime: plan.runtime }),
    }),
  });
  if (res.status !== 202) {
    const body = await res.text();
    tracker.markEnded(agent.vocab, `trigger-${res.status}`);
    throw new Error(`[q3] trigger for ${agent.vocab} returned ${res.status}: ${body}`);
  }
  // The 202 carries the CANONICAL id — a real runtime re-keys the session to
  // its own id, and `/events` must be subscribed on that one.
  const canonicalId = String(((await res.json()) as { sessionId?: string }).sessionId ?? sessionId);

  const controller = new AbortController();
  // Generous ceiling: the server's own stall watchdog fires long before this;
  // this only stops a wedged socket from hanging the run forever.
  const timeout = setTimeout(() => controller.abort(), plan.durationMs * 3 + 120_000);
  try {
    await consumeTurnStream(baseUrl, canonicalId, cwd, state, controller.signal);
  } catch (err) {
    state.terminalReason = `stream-error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }

  const result = summarize(agent, canonicalId, firedAtMs, state);
  tracker.markEnded(agent.vocab, result.terminalReason);
  return result;
}

/** Live turn state the harness writes and the sampler reads once per tick. */
export class MutableTurnTracker implements TurnProbe {
  private readonly running = new Set<string>();
  private readonly outcomes = new Map<string, string>();

  /** Record that an agent's turn has been fired. */
  markStarted(label: string): void {
    this.running.add(label);
  }

  /** Record an agent's terminal outcome. */
  markEnded(label: string, outcome: string): void {
    this.running.delete(label);
    this.outcomes.set(label, outcome);
  }

  turnsRunning(): number {
    return this.running.size;
  }

  turnsEnded(): number {
    return this.outcomes.size;
  }

  terminalOutcomes(): string {
    return [...this.outcomes].map(([label, outcome]) => `${label}=${outcome}`).join(';');
  }
}
