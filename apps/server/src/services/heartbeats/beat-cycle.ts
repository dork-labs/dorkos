/**
 * One beat, start to record (spec `heartbeats` §1, §5–§8, §11): open its row,
 * gather, triage by the rules, maybe run a turn in the beat chat, hand what
 * `end_beat` raised to the outbox, and close the row with its record line.
 *
 * - **Nothing gathered is lost.** A beat gathers from `gathered_through`, which
 *   only moves when a beat dealt with what it saw (it ended quiet, worked, or
 *   ran a turn that saw it without calling `end_beat`). A refused, busy or
 *   failed beat leaves it where it was, so the next beat sees the same changes.
 *   So does a beat one of whose gatherers threw or ran out of time: it never
 *   saw its window, so that window is looked at again — for at most
 *   {@link GATHER_HOLD_MAX_MS}, so a check that stays broken cannot hold every
 *   other check's window open forever (its failure is a `health` change each
 *   beat meanwhile).
 * - **A standing condition counts once.** The beat keeps the keys it saw, and a
 *   lost connection, a failing check or a promise still due is work only when it
 *   first appears or changes (`triage-rules.ts`).
 * - **The caller cleans up.** {@link BeatTrack} says which row and which chat
 *   this beat opened, so the runner can close them if anything here throws.
 *
 * @module services/heartbeats/beat-cycle
 */
import { randomUUID } from 'node:crypto';
import type { Commitment } from '@dorkos/shared/commitment-schemas';
import {
  BEAT_PACE_MAX_MS,
  type BeatKind,
  type BeatOutcome,
  type EndBeatInput,
} from '@dorkos/shared/heartbeat-schemas';
import { isWithinWorkingHours, type ResolvedWorkingHours } from '@dorkos/shared/working-hours';
import { FAILURE_STORM_AT, type BeatClock } from './beat-scheduler.js';
import { resolveBeatChat } from './beat-chat.js';
import type { BeatTurnLauncher } from './beat-launch.js';
import type { BeatPlan } from './beat-plan.js';
import { buildBeatPrompt } from './beat-prompt.js';
import { registerBeatTurn, settleBeatTurn, type BeatTurn } from './beat-turns.js';
import type { HeartbeatStore } from './heartbeat-store.js';
import {
  runGatherers,
  type Change,
  type GathererRegistry,
  type GatherResult,
} from './gatherers/index.js';
import { recordBeat } from './record.js';
import { standingKey, triageByRules } from './triage-rules.js';
import type { BeatAgent, BeatOutboxPort, BeatWake, FinishedBeat } from './beat-runner.js';

/** The longest a failing gatherer holds `gathered_through` back. */
export const GATHER_HOLD_MAX_MS = 24 * 60 * 60_000;

/** Outcomes after which what the beat gathered counts as dealt with. */
const DEALT_WITH: ReadonlySet<BeatOutcome> = new Set(['quiet', 'worked', 'no-end-beat']);

/** What one beat reaches. */
export interface BeatCycleDeps {
  /** The heartbeat tables. */
  store: HeartbeatStore;
  /** The agent's chain person's working hours. */
  hoursFor(agentId: string): ResolvedWorkingHours;
  /** Every gatherer this server runs. */
  gatherers: GathererRegistry;
  /** Open commitments, for the prompt. */
  commitments: { list(filter: { agentId: string; state: 'open' }, limit?: number): Commitment[] };
  /** How a beat turn starts. */
  launcher: BeatTurnLauncher;
  /** Where raises go. */
  outbox: BeatOutboxPort;
  /** The agent's working directory, for the workspace gatherer. */
  resolveCwd?(agent: BeatAgent): Promise<string | null>;
  /** The clock. */
  clock: BeatClock;
  /** Mints ids. */
  mintId?(): string;
  /** Hears every finished beat. */
  onFinished(beat: FinishedBeat): void;
}

/** What this beat opened, for the runner to close if anything throws. */
export interface BeatTrack {
  /** The beat's row, once opened. */
  beatId?: string;
  /** The beat chat, once its turn was registered. */
  chatSessionId?: string;
  /** Set once the turn's registry entry was settled. */
  settled?: boolean;
}

/** How a beat ended, for the runner's retries. */
export interface BeatResult {
  /** The outcome recorded. */
  outcome: BeatOutcome;
  /** The launch cap was full: the runner retries. */
  capFull?: boolean;
}

/** One finished beat's fields. */
interface BeatEnd {
  outcome: BeatOutcome;
  summary: string;
  reason?: string;
  sessionId?: string;
  bypass?: number;
  raises?: number;
  chatSends?: number;
}

/** What closing a beat reads. */
type FinishContext = Pick<
  BeatContext,
  'agent' | 'wake' | 'beatId' | 'startedAt' | 'counts' | 'triage'
> & { changeKeys?: string; gatheredThrough?: string };

/** The facts one beat runs on, gathered and triaged. */
interface BeatContext {
  agent: BeatAgent;
  plan: BeatPlan<BeatAgent>;
  wake: BeatWake;
  beatId: string;
  startedAt: string;
  kind: BeatKind;
  changes: Change[];
  counts: string;
  triage: string;
  /** The keys this beat saw, kept once it deals with them. */
  changeKeys: string;
  /** How far the next beat gathers from, once this one deals with what it saw. */
  gatheredThrough: string;
}

/**
 * Run one beat.
 *
 * @param deps - What it reaches.
 * @param plan - The agent and its `HEARTBEAT.md`, read fresh.
 * @param wake - What woke it.
 * @param track - Filled in as the beat opens things.
 */
export async function runBeat(
  deps: BeatCycleDeps,
  plan: BeatPlan<BeatAgent>,
  wake: BeatWake,
  track: BeatTrack
): Promise<BeatResult> {
  const ctx = await openAndTriage(deps, plan, wake, track);
  if (ctx === 'quiet') return { outcome: 'quiet' };
  return runTurn(deps, ctx, track);
}

/** Open the beat's row, gather and triage. Ends a quiet beat here. */
async function openAndTriage(
  deps: BeatCycleDeps,
  plan: BeatPlan<BeatAgent>,
  wake: BeatWake,
  track: BeatTrack
): Promise<BeatContext | 'quiet'> {
  const { agent } = plan;
  const now = new Date(deps.clock.now());
  const startedAt = now.toISOString();
  const state = deps.store.getState(agent.id);
  const kind = beatKind(deps, plan, now);
  const beatId = (deps.mintId ?? randomUUID)();
  deps.store.insertBeat({ id: beatId, agentId: agent.id, startedAt, kind, wake: wake.wake });
  track.beatId = beatId;
  deps.store.patchState(agent.id, {
    lastBeatAt: startedAt,
    lastChangeAt: state?.lastChangeAt ?? startedAt,
  });

  const cwd = (await deps.resolveCwd?.(agent)) ?? null;
  const gathered = await runGatherers(deps.gatherers, plan.settings.watch, {
    agent: { id: agent.id, name: agent.name, projectPath: agent.projectPath, cwd },
    since: state?.gatheredThrough ?? null,
    now,
    ownBeatSessions: deps.store.beatSessionIds(agent.id),
  });
  const seenStanding = new Set<string>(parseKeys(state?.lastChangeKeys));
  const triage = triageByRules(gathered.changes, {
    failureStorm: (state?.consecutiveFailures ?? 0) >= FAILURE_STORM_AT,
    seenStanding,
  });
  if (triage.considered.length > 0) deps.store.patchState(agent.id, { lastChangeAt: startedAt });
  const ctx: BeatContext = {
    agent,
    plan,
    wake,
    beatId,
    startedAt,
    kind,
    changes: triage.considered,
    counts: JSON.stringify(gathered.counts),
    triage: JSON.stringify({ rung: 'rules', verdict: triage.verdict }),
    changeKeys: JSON.stringify(gathered.changes.map(standingKey)),
    gatheredThrough: nextGatheredThrough(state?.gatheredThrough ?? null, startedAt, gathered),
  };
  if (kind === 'sweep' || triage.verdict !== 'quiet') return ctx;
  const checked = plan.settings.watch.length;
  finish(deps, ctx, {
    outcome: 'quiet',
    summary:
      gathered.changes.length === 0
        ? `Checked ${checked} things. Nothing new.`
        : `Checked ${checked} things. Nothing needs it.`,
  });
  return 'quiet';
}

/**
 * Where the next beat gathers from: this beat's start, unless a gatherer did
 * not see its window, which is then looked at again — up to
 * {@link GATHER_HOLD_MAX_MS} back.
 *
 * @param since - Where this beat gathered from, or null on its first.
 * @param startedAt - This beat's start.
 * @param gathered - What it gathered.
 */
function nextGatheredThrough(
  since: string | null,
  startedAt: string,
  gathered: GatherResult
): string {
  if (gathered.failed.length === 0) return startedAt;
  const floor = new Date(Date.parse(startedAt) - GATHER_HOLD_MAX_MS).toISOString();
  if (since === null) return floor;
  return since > floor ? since : floor;
}

/** A sweep when its interval has passed in working hours, else a pulse (§3.4). */
function beatKind(deps: BeatCycleDeps, plan: BeatPlan<BeatAgent>, now: Date): BeatKind {
  const { sweepMs } = plan.settings;
  if (sweepMs === null || !isWithinWorkingHours(now, deps.hoursFor(plan.agent.id))) return 'pulse';
  const last = deps.store.lastSweepAt(plan.agent.id);
  return last === null || now.getTime() - Date.parse(last) >= sweepMs ? 'sweep' : 'pulse';
}

/** A stored JSON array of keys, or none. */
function parseKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
}

/** The part of a beat that runs the agent's runtime. */
async function runTurn(
  deps: BeatCycleDeps,
  ctx: BeatContext,
  track: BeatTrack
): Promise<BeatResult> {
  const { agent } = ctx;
  const state = deps.store.getState(agent.id);
  const chat = resolveBeatChat(
    state,
    new Date(deps.clock.now()),
    deps.hoursFor(agent.id).timezone,
    deps.mintId
  );
  if (!chat.isNew && deps.launcher.isBusy(chat.sessionId)) return busy(deps, ctx);
  const messageId = (deps.mintId ?? randomUUID)();
  const content = buildBeatPrompt({
    agentName: agent.name,
    kind: ctx.kind,
    changes: ctx.changes,
    commitments: deps.commitments.list({ agentId: agent.id, state: 'open' }, 50),
    openRaises: deps.outbox.openRaises(agent.id),
    checklist: ctx.plan.checklist,
    newManager: state?.newManager === 1,
  });
  // Checked again just before the turn starts: a person may have started typing.
  if (!chat.isNew && deps.launcher.isBusy(chat.sessionId)) return busy(deps, ctx);
  registerBeatTurn(chat.sessionId, { agentId: agent.id, beatId: ctx.beatId, messageId });
  track.chatSessionId = chat.sessionId;
  let settle: (outcome: 'ok' | 'failed') => void = () => undefined;
  const settled = new Promise<'ok' | 'failed'>((resolve) => {
    settle = resolve;
  });
  const launched = await deps.launcher.launch({
    sessionId: chat.sessionId,
    messageId,
    agentPath: agent.projectPath,
    runtime: agent.runtime,
    content,
    onSettled: (outcome) => settle(outcome),
  });
  if (launched.status !== 'started') return refused(deps, ctx, track, launched);
  const sessionId = launched.sessionId;
  if (chat.isNew)
    deps.store.patchState(agent.id, { beatChatId: sessionId, beatChatDate: chat.date });
  const renamed = chat.isNew
    ? deps.launcher.rename(agent, sessionId, chat.title).then(
        () => true,
        () => false
      )
    : Promise.resolve(true);
  const outcome = await settled;
  const turn = settleBeatTurn(chat.sessionId);
  track.settled = true;
  if (!(await renamed)) {
    // A runtime whose transcript exists only once the turn wrote it.
    void deps.launcher.rename(agent, sessionId, chat.title).catch(() => undefined);
  }
  return afterTurn(deps, ctx, sessionId, outcome, turn);
}

/** The beat chat is mid-turn: look again when it is free. */
function busy(deps: BeatCycleDeps, ctx: BeatContext): BeatResult {
  deps.store.patchState(ctx.agent.id, { wakeAgain: 1 });
  finish(deps, ctx, {
    outcome: 'skipped',
    summary: 'Its beat chat was busy; it looks again when the chat is free.',
  });
  return { outcome: 'skipped' };
}

/** The turn did not start: the cap was full, or the launch refused it. */
function refused(
  deps: BeatCycleDeps,
  ctx: BeatContext,
  track: BeatTrack,
  launched: { status: 'cap-full' } | { status: 'refused'; message: string }
): BeatResult {
  settleBeatTurn(track.chatSessionId!);
  track.settled = true;
  const capFull = launched.status === 'cap-full';
  finish(deps, ctx, {
    outcome: 'refused',
    summary: capFull
      ? 'Too many chats were running to start its beat turn.'
      : 'Its beat turn could not start.',
    reason: capFull ? 'LAUNCH_CAP_FULL' : launched.message,
  });
  return { outcome: 'refused', capFull };
}

/** The turn settled: failed, ended without `end_beat`, or handed over raises. */
async function afterTurn(
  deps: BeatCycleDeps,
  ctx: BeatContext,
  sessionId: string,
  outcome: 'ok' | 'failed',
  turn: BeatTurn | undefined
): Promise<BeatResult> {
  const { agent } = ctx;
  const base = { sessionId, bypass: turn?.bypass ?? 0, chatSends: turn?.chatSends ?? 0 };
  if (outcome === 'failed') {
    const failures = (deps.store.getState(agent.id)?.consecutiveFailures ?? 0) + 1;
    deps.store.patchState(agent.id, { consecutiveFailures: failures });
    const error = deps.launcher.lastError(sessionId);
    finish(deps, ctx, {
      ...base,
      outcome: 'failed',
      summary: 'Its beat turn ended with an error.',
      ...(error ? { reason: error } : {}),
    });
    if (failures === FAILURE_STORM_AT)
      await deps.outbox.raiseFailing(agent, ctx.beatId, error ?? undefined);
    return { outcome: 'failed' };
  }
  deps.store.patchState(agent.id, { consecutiveFailures: 0, newManager: 0 });
  const ended = turn?.ended;
  if (!ended) {
    finish(deps, ctx, {
      ...base,
      outcome: 'no-end-beat',
      summary: 'Its beat turn ended without end_beat, so nothing was delivered.',
    });
    return { outcome: 'no-end-beat' };
  }
  const raises = await handOver(deps, ctx, sessionId, ended);
  finish(deps, ctx, { ...base, outcome: 'worked', summary: ended.summary, raises });
  return { outcome: 'worked' };
}

/** What `end_beat` handed over: the pace, the settled raises, the new raises. */
async function handOver(
  deps: BeatCycleDeps,
  ctx: BeatContext,
  sessionId: string,
  ended: EndBeatInput
): Promise<number> {
  const { agent } = ctx;
  if (ended.pace) {
    // Clamped as stored, whatever the call carried: at most twelve hours.
    const cap = deps.clock.now() + BEAT_PACE_MAX_MS;
    const untilIso = new Date(Math.min(Date.parse(ended.pace.untilIso), cap)).toISOString();
    deps.store.patchState(agent.id, { pace: JSON.stringify({ ...ended.pace, untilIso }) });
  }
  if (ended.resolved?.length) deps.outbox.resolve(agent.id, ended.resolved);
  if (!ended.raises?.length) return 0;
  return deps.outbox.accept({
    agent,
    beatId: ctx.beatId,
    chatSessionId: sessionId,
    raises: ended.raises,
  });
}

/**
 * Close a beat: its row, its record line, its observers, and — when it dealt
 * with what it saw — how far the next beat gathers from.
 *
 * @param deps - What it reaches.
 * @param ctx - The beat.
 * @param end - How it ended.
 */
function finish(deps: BeatCycleDeps, ctx: FinishContext, end: BeatEnd): void {
  const { agent, wake } = ctx;
  const audit = recordBeat({
    agent,
    outcome: end.outcome,
    summary: end.summary,
    ...(end.sessionId ? { sessionId: end.sessionId } : {}),
    ...(wake.causedBy ? { causedBy: wake.causedBy } : {}),
    ...(end.reason ? { reason: end.reason } : {}),
  });
  deps.store.finishBeat(ctx.beatId, {
    endedAt: new Date(deps.clock.now()).toISOString(),
    outcome: end.outcome,
    summary: end.summary,
    raises: end.raises ?? 0,
    bypass: end.bypass ?? 0,
    changes: ctx.counts,
    triage: ctx.triage,
    ...(end.sessionId ? { turnSessionId: end.sessionId } : {}),
    ...(audit ? { auditSeq: audit.seq } : {}),
  });
  if (DEALT_WITH.has(end.outcome)) {
    deps.store.patchState(agent.id, {
      gatheredThrough: ctx.gatheredThrough ?? ctx.startedAt,
      ...(ctx.changeKeys !== undefined ? { lastChangeKeys: ctx.changeKeys } : {}),
    });
  }
  deps.onFinished({
    agentId: agent.id,
    wake: wake.wake,
    outcome: end.outcome,
    raises: end.raises ?? 0,
    chatSends: end.chatSends ?? 0,
  });
}

/**
 * Close a beat whose run threw: its row is recorded `failed`, unless it already
 * ended. Never throws.
 *
 * @param deps - What it reaches.
 * @param agent - The agent.
 * @param beatId - The beat's row.
 * @param wake - What woke it.
 * @param error - What was thrown.
 */
export function failOpenBeat(
  deps: BeatCycleDeps,
  agent: BeatAgent,
  beatId: string,
  wake: BeatWake,
  error: unknown
): void {
  const row = deps.store.getBeat(beatId);
  if (!row || row.endedAt) return;
  const reason = error instanceof Error ? error.message : String(error);
  finish(
    deps,
    {
      agent,
      wake,
      beatId,
      startedAt: row.startedAt,
      counts: row.changes ?? '{}',
      triage: row.triage ?? '{}',
    },
    { outcome: 'failed', summary: 'Its beat stopped on an error.', reason }
  );
}
