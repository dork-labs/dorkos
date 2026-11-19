/**
 * An agent's heavy shell job waits its turn while the computer is busy (DOR-4209).
 *
 * A `PreToolUse` hook on `Bash`, because hooks run at every level, Full included, and `canUseTool`
 * does not. A heavy command (a build, a test suite, an install: `heavy-classifier.ts`) waits in the
 * machine's one line (`core/load-gate/`) until the load is under the limit and a slot is free; a
 * light one (`ls`) passes at once. While it waits, the chat says its place in line every minute,
 * which also tells the stall guard the turn is alive. One thread at a time: a thread's own heavy
 * calls share its turn ({@link shareKeyOf}, `core/load-gate/chat-turns.ts`), so two in one batch
 * never wait on each other, while a chat's helpers running side by side each wait their own turn.
 *
 * **It holds, it never decides.** Every answer is `{}`: never a `permissionDecision`, never a
 * `decision`. So once the wait ends, however it ends (its turn, a let-through mark, the hard cap,
 * a gate failure, a Stop), the call goes on exactly as it would have without this hook:
 * the shell guard's refusal still refuses, an allow rule still allows, a card is still raised. The
 * CLI may run a call's `PreToolUse` hooks side by side and then combine their answers, so nothing
 * here relies on running after the hooks that refuse. The cost of that is only time: a command
 * another hook refuses may wait its turn before it is refused, and its slot is then given back by
 * one of the sweeps below.
 *
 * **The hook's own time limit is set past the hard cap**, so the gate's cap, not the CLI, ends a
 * long wait. Should the CLI's limit pass anyway (a hard cap raised after this process started, or
 * one past the longest timer Node can set), the CLI goes on as if this hook had said nothing, which
 * is the normal flow, and its cancel stops the wait. A slot granted after its call already finished
 * is given back at once. Put plainly: if the CLI cuts the hook short (its time limit or a cancel),
 * the call fails open into the normal flow, and its ticket leaves the line.
 *
 * **A slot is given back** when the call finishes (`PostToolUse`, `PostToolUseFailure`), when its
 * batch ends (`PostToolBatch`, which covers a call that was refused and never ran), when a
 * permission is refused (`PermissionDenied`), at turn end (`Stop`, for the main thread), at a
 * helper's end (`SubagentStop`), when the session ends, and when the process itself ends, since a
 * dead process runs no hook: the warm path's spawn seam ends just that process's slots
 * ({@link startHeavyJobsProcess}), the turn path's `finally` ends all of its launch's
 * ({@link releaseHeavyJobsOf}). The gate's own bound on a slot nobody gave back is the last
 * backstop.
 *
 * **Not covered yet: a heavy command sent to the background.** A `run_in_background` call returns
 * at once, so its `PostToolUse` gives the slot back while the job still runs: it waits for its turn
 * to start and no longer. Holding the slot until the background shell ends would mean trusting
 * the CLI's task-ended message to arrive, and one that never did would hold every heavy job on the
 * computer until the gate's bound; that is left for a later change.
 *
 * **A heavy command that needs your OK gives its turn back while the card waits; after you
 * approve it runs straight away, so at most one job runs outside the line.** A card can wait for
 * hours, and a slot held through it would hold every heavy job on the computer behind one
 * person's answer. A person approving in real time is already a gate, so the slot is given back
 * when the card is raised ({@link LoadGateHooks.releaseCall}, from `canUseTool`) and never taken
 * again; a deny takes nothing either.
 *
 * Nothing here logs or shows command text: only the program's name (`pnpm`) and counts. A waiting
 * agent learns its place in line, never what is ahead of it.
 *
 * @module services/runtimes/claude-code/tool-gate/load-gate-hook
 */
import type {
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import { LoadGateSettingsSchema, type LoadGateSettings } from '@dorkos/shared/config-schema';
import { LOAD_WAIT_STATUS } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import {
  hardCapMs,
  type HeldSlot,
  type LoadGate,
  type WaitStatus,
} from '../../../core/load-gate/load-gate.js';
import { loadGateSettings, machineLoadGate } from '../../../core/load-gate/machine-load-gate.js';
import type { AgentSession } from '../agent-types.js';

/** The one tool the gate holds: the CLI reads a word-only matcher as an exact tool name. */
export const LOAD_GATE_MATCHER = 'Bash';

/** How far past the hard cap the hook's own time limit is set, so the cap always ends a wait first. */
const HOOK_TIMEOUT_MARGIN_S = 300;
/** The longest timer Node can set (2^31 - 1 ms), in whole seconds: a longer one fires at once. */
const MAX_TIMER_S = Math.floor((2 ** 31 - 1) / 1_000);
/** A wait this close to the hook's time limit when the CLI stops it is taken as the limit passing. */
const TIMEOUT_SLACK_MS = 5_000;
/** How many finished calls are remembered, for a slot granted after its call already ended. */
const FINISHED_MEMORY = 256;
const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
/** The shipped settings, for the time limit when the live ones cannot be read. */
const SHIPPED = LoadGateSettingsSchema.parse(undefined);

/** What the hook reads and writes on the session: its event queue, and the proof the turn is alive. */
export type LoadGateHookSession = Pick<
  AgentSession,
  'eventQueue' | 'eventQueueNotify' | 'lastActivity' | 'sdkSessionId'
>;

/** Who a launch's jobs are for, for the person's own list of waiting jobs only. */
export interface LoadGateHookLaunch {
  /** The DorkOS session id, until the SDK names its own. */
  sessionId: string;
  /** The agent's name, as a person reads it. */
  agentName?: string | null;
}

/** What the hooks use, each replaceable in tests. */
export interface LoadGateHookDeps {
  /** The gate; the server's own by default. */
  gate?: () => LoadGate;
  /** The `runtimes.loadGate` settings, for the time limit and the wait's words; the live config by default. */
  settings?: () => LoadGateSettings;
  /** The wall clock. */
  now?: () => number;
  /** Where the hook's few lines go. None carries command text. */
  log?: { warn(message: string, data: Record<string, unknown>): void };
}

/** One launch's registrations, and the way to give everything back when its process ends. */
export interface LoadGateHooks {
  /** `PreToolUse`: holds a heavy command until its turn. */
  wait: HookCallbackMatcher;
  /** `PostToolUse` and `PostToolUseFailure`: gives a finished call's slot back. */
  afterCall: HookCallbackMatcher;
  /** `Stop`: gives back every main-thread slot still held when the turn ends. */
  sweep: HookCallbackMatcher;
  /** The other backstops, keyed by the event each rides. */
  backstops: Record<
    'PostToolBatch' | 'PermissionDenied' | 'SubagentStop' | 'SessionEnd',
    HookCallbackMatcher[]
  >;
  /** Give back every slot, and stop every wait: the process these hooks run in has ended. */
  releaseAll: () => void;
  /**
   * Give back the slot one call holds, now, and take its ticket out of line if it is still
   * waiting: a person is being asked about it (or it is refused for want of one). Never takes a
   * slot, and the call is not put back in line. For `canUseTool`, never for the SDK. Never throws.
   */
  releaseCall: (toolUseId: string) => void;
}

/** Each launch's slot ledger, found by the `wait` matcher in its options. */
const LAUNCHES = new WeakMap<HookCallbackMatcher, LaunchSlots>();

/** The slot ledger of every load-gate hook set in `options`: one, or none. */
function launchesIn(options: Pick<Options, 'hooks'>): LaunchSlots[] {
  return (options.hooks?.PreToolUse ?? []).flatMap((matcher) => LAUNCHES.get(matcher) ?? []);
}

/**
 * Give back every heavy-job slot held by the load-gate hooks in `options`, and stop their waits.
 * For a process that is the only one its options ever boot (the turn path): call it when that
 * process has ended, however it ended. Options with no load-gate hook are left alone. Never throws.
 *
 * @param options - The options the process was launched with.
 */
export function releaseHeavyJobsOf(options: Pick<Options, 'hooks'>): void {
  for (const launch of launchesIn(options)) launch.endAll();
}

/**
 * A process is starting with `options`, which may boot others before or after it (the warm
 * path's recovery reuses its plan). From now on the hooks' slots and waits are this process's,
 * and the returned call gives back only those, so an old process's late exit never frees the slot
 * of the one that replaced it. Call the returned function when this process exits. Never throws.
 *
 * @param options - The options the process is launched with.
 * @returns What to call when this process exits.
 */
export function startHeavyJobsProcess(options: Pick<Options, 'hooks'>): () => void {
  const started = launchesIn(options).map((launch) => ({ launch, generation: launch.started() }));
  return () => {
    for (const { launch, generation } of started) launch.end(generation);
  };
}

/**
 * Which calls share one turn in the line: this runtime, this chat, and one agent thread in it,
 * the main thread or one helper. A batch from one thread shares (so it cannot wait on itself);
 * helpers running side by side each take their own turn.
 *
 * @param chatId - The chat the call is in.
 * @param agentId - The helper the call came from, absent on the main thread.
 */
export function shareKeyOf(chatId: string, agentId: string | undefined): string {
  return `claude-code:${chatId}:${agentId ?? 'main'}`;
}

/** The only answer these hooks give: nothing, so the normal flow decides. */
function noAnswer(): HookJSONOutput {
  return {};
}

const isAbort = (error: unknown): boolean => (error as Error | undefined)?.name === 'AbortError';

/** A short, fixed name for what went wrong: never a message, which could carry a path. */
const errorName = (error: unknown): string =>
  error instanceof Error && /^\w{1,40}$/.test(error.name) ? error.name : 'unknown';

/**
 * The hook's own time limit, in seconds: past the hard cap, so the gate's cap ends a wait first,
 * and never past the longest timer Node can set.
 *
 * @param settings - The settings in force when the hooks are built, or `null` when unreadable.
 */
export function loadGateHookTimeoutSeconds(settings: LoadGateSettings | null): number {
  const pastCap = Math.ceil(hardCapMs(settings ?? SHIPPED) / MS_PER_SECOND) + HOOK_TIMEOUT_MARGIN_S;
  return Math.min(pastCap, MAX_TIMER_S);
}

/** `1st`, `2nd`, `3rd`, `4th`, `11th`, `21st`: English ordinals, where 11 to 13 take `th`. */
function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** A rough time left, as a person reads it: `40m`, `3h`. */
function roughly(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MS_PER_MINUTE));
  return minutes < MINUTES_PER_HOUR ? `${minutes}m` : `${Math.round(minutes / MINUTES_PER_HOUR)}h`;
}

/**
 * What the chat says while a heavy job waits. Its place in line and nothing about the jobs ahead.
 *
 * @param status - How the wait is going, as the gate reports it.
 * @param capMs - When the job runs anyway, or `undefined` when the settings cannot be read.
 */
export function loadWaitMessage(status: WaitStatus, capMs: number | undefined): string {
  const place = status.position <= 1 ? 'Next in line' : `${ordinal(status.position)} in line`;
  if (!status.pastMaxWait) return `Waiting for the computer to calm down. ${place}.`;
  const runsAnyway =
    capMs === undefined ? '' : ` It runs anyway in about ${roughly(capMs - status.waitedMs)}.`;
  return `Still waiting for the computer. ${place}.${runsAnyway}`;
}

/**
 * The slots one launch holds, by tool call, the calls that already finished, and the processes
 * its options booted. On the warm path one launch's options can boot a replacement process (a
 * recovery reuses the plan), and the old one's exit may arrive after the new one started: each
 * process is a generation, and a slot or a wait belongs to the generation current when its hook
 * ran, so an exit ends only its own.
 */
class LaunchSlots {
  private readonly held = new Map<
    string,
    { slot: HeldSlot; generation: number; agentId?: string }
  >();
  private readonly finished = new Set<string>();
  /** What stops each call's wait still in line, so a card can take its ticket out. */
  private readonly waits = new Map<string, AbortController>();
  /** Each live process's generation, and what stops the waits started under it. */
  private readonly live = new Map<number, AbortController>();
  /** The newest process: a hook that runs now is its. */
  private current = 0;

  constructor() {
    this.open(0);
  }

  /**
   * A new process started with these options: hooks from now on are its own.
   *
   * @returns Its generation, for {@link LaunchSlots.end} when it exits.
   */
  started(): number {
    this.open(this.current + 1);
    return this.current;
  }

  /**
   * What a call's wait starting now needs: the signal that stops it (its process ending, or a
   * card raised for it), and which process it belongs to. Pair with {@link LaunchSlots.settled}.
   */
  begin(toolUseId: string): { stop: AbortSignal; generation: number; handle: AbortController } {
    const handle = new AbortController();
    this.waits.set(toolUseId, handle);
    const stop = AbortSignal.any([this.live.get(this.current)!.signal, handle.signal]);
    return { stop, generation: this.current, handle };
  }

  /**
   * A call's wait ended, however it ended. Forgets its stop handle only if it is still this
   * wait's: a later wait for the same call id keeps its own.
   */
  settled(toolUseId: string, handle: AbortController): void {
    if (this.waits.get(toolUseId) === handle) this.waits.delete(toolUseId);
  }

  /** A person is asked about the call: its slot comes back, its wait stops, nothing is retaken. */
  release(toolUseId: string): void {
    this.waits.get(toolUseId)?.abort();
    this.finish(toolUseId);
  }

  /** Keep a granted slot until its call finishes; give it back at once if nothing will finish it. */
  keep(toolUseId: string, slot: HeldSlot, agentId: string | undefined, generation: number): void {
    // The call already ended (the CLI gave up on the hook), or its process did.
    if (this.finished.has(toolUseId) || !this.live.has(generation)) return slot.release();
    // The same call held twice: the older slot is nobody's now.
    this.giveBack(toolUseId);
    this.held.set(toolUseId, { slot, generation, ...(agentId ? { agentId } : {}) });
  }

  /** A call finished, ran or not: give its slot back, and remember it for a slot still coming. */
  finish(toolUseId: string): void {
    this.giveBack(toolUseId);
    this.finished.add(toolUseId);
    if (this.finished.size > FINISHED_MEMORY) {
      this.finished.delete(this.finished.values().next().value!);
    }
  }

  /** Give back every slot whose holder passes `test`: the main thread is `undefined`. */
  giveBackWhere(test: (agentId: string | undefined) => boolean): void {
    for (const [toolUseId, entry] of this.held) if (test(entry.agentId)) this.giveBack(toolUseId);
  }

  /**
   * One process ended: give back its slots and stop its waits, leaving every other process's
   * alone. Not final: a later process booted from the same options starts afresh.
   *
   * @param generation - The process, as {@link LaunchSlots.started} named it.
   */
  end(generation: number): void {
    for (const [toolUseId, entry] of this.held) {
      if (entry.generation === generation) this.giveBack(toolUseId);
    }
    this.live.get(generation)?.abort();
    this.live.delete(generation);
    if (generation === this.current) this.open(this.current + 1);
  }

  /** Every process these options booted ended: give everything back and stop every wait. */
  endAll(): void {
    for (const generation of [...this.live.keys()]) this.end(generation);
  }

  private open(generation: number): void {
    this.current = generation;
    this.live.set(generation, new AbortController());
  }

  private giveBack(toolUseId: string): void {
    const entry = this.held.get(toolUseId);
    this.held.delete(toolUseId);
    entry?.slot.release();
  }
}

/** Whether `event` is a load-wait notice no turn has taken off the queue yet. */
const isLoadWait = (event: StreamEvent): boolean =>
  event.type === 'system_status' &&
  (event.data as { status?: unknown } | undefined)?.status === LOAD_WAIT_STATUS;

/**
 * Tell the chat how its job's wait is going. Counts only. A notice still on the queue is replaced
 * rather than joined, so a wait with no turn reading the queue leaves one notice, not one a minute.
 */
function waitNotice(
  session: LoadGateHookSession,
  readSettings: () => LoadGateSettings | null,
  now: () => number
): (status: WaitStatus) => void {
  return (status) => {
    const current = readSettings();
    const message = loadWaitMessage(status, current ? hardCapMs(current) : undefined);
    const event: StreamEvent = {
      type: 'system_status',
      data: { message, status: LOAD_WAIT_STATUS },
    };
    // A turn whose job waits is still working: record eviction must not take it.
    session.lastActivity = now();
    const stale = session.eventQueue.findIndex(isLoadWait);
    if (stale >= 0) session.eventQueue[stale] = event;
    else session.eventQueue.push(event);
    session.eventQueueNotify?.();
  };
}

/** Give back the slots an ending batch, refusal, turn, helper or session leaves behind. */
function sweepHook(slots: LaunchSlots): HookCallback {
  return async (input) => {
    if (input.hook_event_name === 'PostToolBatch') {
      for (const call of input.tool_calls ?? []) slots.finish(call.tool_use_id);
    } else if (input.hook_event_name === 'PermissionDenied') {
      slots.finish(input.tool_use_id);
    } else if (input.hook_event_name === 'Stop') {
      slots.giveBackWhere((agentId) => agentId === undefined);
    } else if (input.hook_event_name === 'SubagentStop') {
      slots.giveBackWhere((agentId) => agentId === input.agent_id);
    } else if (input.hook_event_name === 'SessionEnd') {
      slots.giveBackWhere(() => true);
    }
    return noAnswer();
  };
}

/**
 * Build one launch's load-gate hooks. Read at call time: a warm process serves many turns, and a
 * change to the settings applies to the next command.
 *
 * @param session - The session whose chat hears about the wait.
 * @param launch - Who the jobs are for.
 * @param deps - The gate, the settings, the clock and the log, for tests.
 */
export function loadGateHooks(
  session: LoadGateHookSession,
  launch: LoadGateHookLaunch,
  deps: LoadGateHookDeps = {}
): LoadGateHooks {
  const gate = deps.gate ?? machineLoadGate;
  const settings = deps.settings ?? loadGateSettings;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? logger;
  const readSettings = (): LoadGateSettings | null => {
    try {
      return settings();
    } catch {
      return null;
    }
  };
  const timeoutS = loadGateHookTimeoutSeconds(readSettings());
  const slots = new LaunchSlots();
  const say = waitNotice(session, readSettings, now);

  /** Wait for a heavy command's turn and keep its slot. Throws on a stop or a gate failure. */
  const holdIfHeavy = async (input: HookInput, signal: AbortSignal): Promise<void> => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== LOAD_GATE_MATCHER) return;
    const command = (input.tool_input as { command?: unknown } | null)?.command;
    if (typeof command !== 'string') return;
    const chatId = session.sdkSessionId || launch.sessionId;
    const owner = {
      chatId,
      ...(launch.agentName ? { agentName: launch.agentName } : {}),
      // One thread's calls share a turn: the main thread's, or one helper's (`chat-turns.ts`).
      shareKey: shareKeyOf(chatId, input.agent_id),
    };
    const { stop, generation, handle } = slots.begin(input.tool_use_id);
    try {
      // The gate classifies with the shell guard's own parser, on this same string, and logs a
      // hard-cap run and a let-through itself, by program name.
      const slot = await gate().gateIfHeavy(command, owner, {
        signal: AbortSignal.any([signal, stop]),
        onWait: say,
      });
      if (slot !== null) slots.keep(input.tool_use_id, slot, input.agent_id, generation);
    } finally {
      slots.settled(input.tool_use_id, handle);
    }
  };

  const waitHook: HookCallback = async (input, _toolUseId, { signal }) => {
    const startedAt = now();
    try {
      await holdIfHeavy(input, signal);
    } catch (error) {
      if (!isAbort(error)) {
        log.warn('[LoadGate] the wait broke; the command goes on', { error: errorName(error) });
      } else if (
        signal.aborted &&
        now() - startedAt >= timeoutS * MS_PER_SECOND - TIMEOUT_SLACK_MS
      ) {
        log.warn('[LoadGate] the wait outlasted its hook time limit; the command goes on', {});
      }
    }
    return noAnswer();
  };

  const afterCallHook: HookCallback = async (input) => {
    if (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure') {
      slots.finish(input.tool_use_id);
    }
    return noAnswer();
  };

  const wait: HookCallbackMatcher = {
    matcher: LOAD_GATE_MATCHER,
    hooks: [waitHook],
    timeout: timeoutS,
  };
  const releaseAll = (): void => slots.endAll();
  LAUNCHES.set(wait, slots);
  const sweep: HookCallbackMatcher = { hooks: [sweepHook(slots)] };
  return {
    wait,
    afterCall: { matcher: LOAD_GATE_MATCHER, hooks: [afterCallHook] },
    sweep,
    backstops: {
      PostToolBatch: [sweep],
      PermissionDenied: [sweep],
      SubagentStop: [sweep],
      SessionEnd: [sweep],
    },
    releaseAll,
    // Never throws: `canUseTool` calls it just before raising a card, and a throw there would turn
    // the card into a rejected permission callback. Guarded here rather than at the call site.
    releaseCall: (toolUseId) => {
      try {
        slots.release(toolUseId);
      } catch (error) {
        log.warn('[LoadGate] a card could not give its slot back', { error: errorName(error) });
      }
    },
  };
}
