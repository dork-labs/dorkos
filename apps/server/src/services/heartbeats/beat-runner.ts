/**
 * The beat runner (spec `heartbeats` §1, §3, §7): who beats, when, and what a
 * beat leaves behind. One beat itself is `beat-cycle.ts`.
 *
 * - **Who beats** (§3.1): heartbeats on, `wake` not `off`, not paused, and a
 *   runtime this server runs. An agent the mesh found for another tool is
 *   skipped and recorded once per start (`heartbeat.skipped`), so the launch
 *   path's default-runtime fallback can never run a turn nobody chose.
 * - **A timed agent never stops beating by accident.** Whatever a beat does —
 *   ends, is refused, throws — its next timed beat is armed afterwards from a
 *   fresh read of its `HEARTBEAT.md`. A beat that threw has its row recorded
 *   `failed` and its beat-turn registry entry settled.
 * - **Edits on disk and new agents** are picked up by a scan every
 *   {@link FILE_SCAN_MS}: an agent whose `HEARTBEAT.md` changed, or that was
 *   not armed before, is re-armed.
 * - **Retries.** A busy beat chat sets `wake_again`, run a few minutes after
 *   the beat. A full launch cap is retried at 1, 2 and 5 minutes, then dropped
 *   to the next beat. The two never share a timer.
 * - {@link BeatRunner.observe} hands every finished beat to the loop watcher
 *   (DOR-2745) without this domain knowing it.
 *
 * @module services/heartbeats/beat-runner
 */
import type { Commitment } from '@dorkos/shared/commitment-schemas';
import type { BeatOutcome, EndBeatRaise } from '@dorkos/shared/heartbeat-schemas';
import type { ResolvedWorkingHours } from '@dorkos/shared/working-hours';
import { logger } from '../../lib/logger.js';
import {
  BeatScheduler,
  beatInterval,
  startupBeatAt,
  systemClock,
  withJitter,
  type BeatClock,
  type CadenceFacts,
} from './beat-scheduler.js';
import { failOpenBeat, runBeat, type BeatCycleDeps, type BeatTrack } from './beat-cycle.js';
import type { OpenRaise } from './beat-prompt.js';
import type { BeatTurnLauncher } from './beat-launch.js';
import { cadenceFacts, planBeat, type BeatPlan } from './beat-plan.js';
import { settleBeatTurn } from './beat-turns.js';
import { readHeartbeatFile, type HeartbeatFileRead } from './heartbeat-file.js';
import type { HeartbeatStore } from './heartbeat-store.js';
import type { GathererRegistry } from './gatherers/index.js';
import { pruneOldBeats, recordBeat, recordHeartbeatEvent } from './record.js';

/** One minute, in ms. */
const MINUTE = 60_000;

/** When a full launch cap is retried, then dropped (§7.1). */
export const LAUNCH_CAP_RETRY_MS = [1 * MINUTE, 2 * MINUTE, 5 * MINUTE] as const;

/** How soon a beat owed by `wake_again` runs. */
export const WAKE_AGAIN_DELAY_MS = 5 * MINUTE;

/** How often `HEARTBEAT.md` edits on disk and new agents are looked for. */
export const FILE_SCAN_MS = 5 * MINUTE;

/** How often beat rows past retention are pruned. */
const PRUNE_EVERY_MS = 24 * 60 * MINUTE;

/** An agent, as the runner reads it. */
export interface BeatAgent {
  /** Mesh id. */
  id: string;
  /** Display name. */
  name: string;
  /** Its runtime id. */
  runtime: string;
  /** Its home directory. */
  projectPath: string;
}

/** Why a beat woke: `timer`, `startup`, or an event. */
export interface BeatWake {
  /** `timer`, `startup`, or `event:<type>`. */
  wake: string;
  /** The waking event's id, for the record's `links.causedBy`. */
  causedBy?: string;
}

/** What the outbox does for the runner (§9). */
export interface BeatOutboxPort {
  /**
   * Take a beat's raises: deliver or hold each.
   *
   * @returns How many were taken.
   */
  accept(input: {
    agent: BeatAgent;
    beatId: string;
    chatSessionId: string;
    raises: readonly EndBeatRaise[];
  }): Promise<number>;
  /** Close earlier raises the agent says are settled. */
  resolve(agentId: string, keys: readonly string[]): void;
  /** The raises the agent is still waiting on, for its prompt (§7.2). */
  openRaises(agentId: string): readonly OpenRaise[];
  /** The runner's own raise when an agent's beats keep failing (§7.5), with the error. */
  raiseFailing(agent: BeatAgent, beatId: string, error?: string): Promise<void>;
}

/** One finished beat, as observers hear it. */
export interface FinishedBeat {
  /** The agent. */
  agentId: string;
  /** What woke it. */
  wake: string;
  /** How it ended. */
  outcome: BeatOutcome;
  /** How many raises it handed over. */
  raises: number;
  /** Chat messages its turn sent to other agents. */
  chatSends: number;
}

/** What the runner is built from. */
export interface BeatRunnerDeps {
  /** The heartbeat tables. */
  store: HeartbeatStore;
  /** The agents this server knows. */
  agents: { list(): BeatAgent[]; get(id: string): BeatAgent | undefined };
  /** Whether a runtime id is one this server runs. */
  runtimeRegistered(runtime: string): boolean;
  /** `heartbeats.enabled`. */
  enabled(): boolean;
  /**
   * Whether an agent is paused. Answers false until DOR-2738 PR 5 wires
   * `services/mesh/agent-pause.ts` in; the registry's paused-agent guard is the
   * backstop either way.
   */
  isPaused?(agentId: string): boolean;
  /** The agent's chain person's working hours. */
  hoursFor(agentId: string): ResolvedWorkingHours;
  /** Every gatherer this server runs. */
  gatherers: GathererRegistry;
  /** Open commitments, for the prompt and the in-flight rule. */
  commitments: { list(filter: { agentId: string; state: 'open' }, limit?: number): Commitment[] };
  /** How a beat turn starts. */
  launcher: BeatTurnLauncher;
  /** Where raises go. */
  outbox: BeatOutboxPort;
  /** Whether a turn of the agent's own is running now (§3.2 "in flight"). */
  ownTurnRunning?(agentId: string): boolean;
  /** The agent's working directory, for the workspace gatherer. */
  resolveCwd?(agent: BeatAgent): Promise<string | null>;
  /** Reads `HEARTBEAT.md`; tests pass a fake. */
  readHeartbeat?(agentPath: string): Promise<HeartbeatFileRead>;
  /** The clock; tests pass a fake. */
  clock?: BeatClock;
  /** A number in [0, 1), for jitter and stagger. */
  random?(): number;
  /** Mints ids. */
  mintId?(): string;
}

/** The beat runner. */
export class BeatRunner {
  private readonly clock: BeatClock;
  private readonly scheduler: BeatScheduler;
  private readonly cycle: BeatCycleDeps;
  private readonly running = new Map<string, Promise<void>>();
  private readonly wakeAgainTimers = new Map<string, unknown>();
  private readonly capTimers = new Map<string, unknown>();
  private readonly capAttempts = new Map<string, number>();
  private readonly skippedThisStart = new Set<string>();
  private readonly offRecorded = new Set<string>();
  private readonly fileMtimes = new Map<string, number>();
  private readonly observers = new Set<(beat: FinishedBeat) => void>();
  private pruneHandle: unknown;
  private scanHandle: unknown;
  /** Agents the scan last found paused, so a resume arms them again. */
  private readonly pausedSeen = new Set<string>();
  private recovered = false;
  private started = false;
  /** Bumped by every start and stop, so a start overtaken by a later one arms nothing. */
  private generation = 0;

  /**
   * Build the runner.
   *
   * @param deps - What it is built from.
   */
  constructor(private readonly deps: BeatRunnerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.scheduler = new BeatScheduler(this.clock, (agentId) => {
      void this.wake(agentId, { wake: 'timer' });
    });
    this.cycle = {
      store: deps.store,
      hoursFor: (id) => deps.hoursFor(id),
      gatherers: deps.gatherers,
      commitments: deps.commitments,
      launcher: deps.launcher,
      outbox: deps.outbox,
      ...(deps.resolveCwd ? { resolveCwd: deps.resolveCwd } : {}),
      clock: this.clock,
      ...(deps.mintId ? { mintId: deps.mintId } : {}),
      onFinished: (beat) => this.notify(beat),
    };
  }

  /** Start: recover beats a restart interrupted, arm every timed agent, scan and prune. */
  async start(): Promise<void> {
    this.started = true;
    const generation = ++this.generation;
    this.recoverInterrupted();
    await this.armAll(generation);
    // Stopped, or stopped and started again, while the files were read: the
    // later start owns the housekeeping timers.
    if (generation !== this.generation) return;
    this.armPrune();
    this.armScan();
  }

  /** Stop every timer and retry. Running turns finish; their next beat is not armed. */
  stop(): void {
    this.started = false;
    this.generation += 1;
    this.scheduler.clearAll();
    for (const timers of [this.wakeAgainTimers, this.capTimers]) {
      for (const handle of timers.values()) this.clock.clearTimeout(handle);
      timers.clear();
    }
    this.capAttempts.clear();
    for (const handle of [this.pruneHandle, this.scanHandle]) {
      if (handle !== undefined) this.clock.clearTimeout(handle);
    }
    this.pruneHandle = undefined;
    this.scanHandle = undefined;
  }

  /** Re-read `heartbeats.enabled`: off clears every timer, on arms them again. */
  async refreshEnabled(): Promise<void> {
    if (!this.deps.enabled()) {
      this.stop();
      return;
    }
    if (!this.started) await this.start();
  }

  /**
   * Re-arm one agent from a fresh read of its `HEARTBEAT.md`.
   *
   * @param agentId - The agent.
   */
  async refreshAgent(agentId: string): Promise<void> {
    const agent = this.deps.agents.get(agentId);
    if (!agent || !this.started) return;
    const plan = await this.plan(agent);
    if (this.started) this.armNext(plan);
  }

  /**
   * When an agent's next timed beat is due, or null.
   *
   * @param agentId - The agent.
   */
  nextBeatAt(agentId: string): Date | null {
    const at = this.scheduler.nextAt(agentId);
    return at === null ? null : new Date(at);
  }

  /** How many timers are armed, retries and housekeeping included. */
  get armedTimers(): number {
    const housekeeping = [this.pruneHandle, this.scanHandle].filter((h) => h !== undefined).length;
    return this.scheduler.size + this.wakeAgainTimers.size + this.capTimers.size + housekeeping;
  }

  /**
   * Hear every finished beat (the loop watcher's seam, §11).
   *
   * @param fn - The observer.
   * @returns Unsubscribe.
   */
  observe(fn: (beat: FinishedBeat) => void): () => void {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }

  /**
   * Beat now. A beat already running for the agent sets `wake_again` instead.
   *
   * @param agentId - The agent.
   * @param wake - What woke it.
   * @returns When the beat (including any turn) has finished.
   */
  async wake(agentId: string, wake: BeatWake): Promise<void> {
    const agent = this.deps.agents.get(agentId);
    if (!agent || !this.deps.enabled() || this.deps.isPaused?.(agentId)) return;
    if (!this.deps.runtimeRegistered(agent.runtime)) {
      this.noteSkipped(agent);
      return;
    }
    if (this.running.has(agentId)) {
      this.deps.store.patchState(agentId, { wakeAgain: 1 });
      return;
    }
    const run = this.beat(agent, wake).finally(() => this.running.delete(agentId));
    this.running.set(agentId, run);
    await run;
  }

  /** One beat with its clean-up: whatever happens, the next one is armed. */
  private async beat(agent: BeatAgent, wake: BeatWake): Promise<void> {
    const track: BeatTrack = {};
    let capFull = false;
    try {
      const plan = await this.plan(agent);
      if (plan.settings.wake === 'off') {
        this.noteOff(agent);
        return;
      }
      // A stray timer for an agent that no longer beats on one does nothing.
      if (wake.wake === 'timer' && plan.settings.wake !== 'timed') return;
      capFull = (await runBeat(this.cycle, plan, wake, track)).capFull === true;
    } catch (err) {
      logger.warn('[heartbeats] a beat failed to run', {
        agentId: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
      if (track.beatId) failOpenBeat(this.cycle, agent, track.beatId, wake, err);
    } finally {
      if (track.chatSessionId && !track.settled) settleBeatTurn(track.chatSessionId);
      this.afterBeat(agent.id, wake, capFull);
      await this.refreshAgent(agent.id).catch(() => undefined);
    }
  }

  /** After a beat: retry a full cap, or run the beat a wake during it owed. */
  private afterBeat(agentId: string, wake: BeatWake, capFull: boolean): void {
    if (!this.started) return;
    if (capFull) this.retryCapFull(agentId, wake);
    else this.capAttempts.delete(agentId);
    const state = this.deps.store.getState(agentId);
    if (!state?.wakeAgain) return;
    this.deps.store.patchState(agentId, { wakeAgain: 0 });
    this.later(this.wakeAgainTimers, agentId, WAKE_AGAIN_DELAY_MS, { wake: 'event:wake-again' });
  }

  /** Retry a beat whose launch found the cap full: 1, 2, then 5 minutes, then drop. */
  private retryCapFull(agentId: string, wake: BeatWake): void {
    const attempt = this.capAttempts.get(agentId) ?? 0;
    const delay = LAUNCH_CAP_RETRY_MS[attempt];
    if (delay === undefined) {
      this.capAttempts.delete(agentId);
      return;
    }
    this.capAttempts.set(agentId, attempt + 1);
    this.later(this.capTimers, agentId, delay, wake);
  }

  /** Run a beat later on one of the retry slots, so stop() can clear it. */
  private later(
    timers: Map<string, unknown>,
    agentId: string,
    delayMs: number,
    wake: BeatWake
  ): void {
    const prior = timers.get(agentId);
    if (prior !== undefined) this.clock.clearTimeout(prior);
    const handle = this.clock.setTimeout(() => {
      if (timers.get(agentId) === handle) timers.delete(agentId);
      void this.wake(agentId, wake);
    }, delayMs);
    timers.set(agentId, handle);
  }

  /** Hand a finished beat to every observer; one that throws never stops the rest. */
  private notify(beat: FinishedBeat): void {
    for (const observer of this.observers) {
      try {
        observer(beat);
      } catch (err) {
        logger.warn('[heartbeats] a beat observer threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Record a skipped agent once per start. */
  private noteSkipped(agent: BeatAgent): void {
    if (this.skippedThisStart.has(agent.id)) return;
    this.skippedThisStart.add(agent.id);
    recordHeartbeatEvent({
      action: 'heartbeat.skipped',
      agent,
      outcome: 'refused',
      reason: `Runs on "${agent.runtime}", which this server does not run.`,
      summary: 'Does not beat: its runtime is not one DorkOS runs here.',
    });
  }

  /** Record once per process that an agent's heartbeat is off (§3.6). */
  private noteOff(agent: BeatAgent): void {
    this.scheduler.cancel(agent.id);
    if (this.offRecorded.has(agent.id)) return;
    this.offRecorded.add(agent.id);
    recordHeartbeatEvent({
      action: 'heartbeat.skipped',
      agent,
      reason: 'wake: off',
      summary: 'Does not beat: its HEARTBEAT.md says wake: off.',
    });
  }

  /**
   * Beats open at startup were interrupted by a restart: record them failed
   * (§3.2). Once per process, and never one a beat of this process is running.
   */
  private recoverInterrupted(): void {
    if (this.recovered) return;
    this.recovered = true;
    const at = new Date(this.clock.now()).toISOString();
    for (const beat of this.deps.store.openBeats()) {
      if (this.running.has(beat.agentId)) continue;
      const agent = this.deps.agents.get(beat.agentId) ?? {
        id: beat.agentId,
        name: beat.agentId,
        runtime: '',
        projectPath: '',
      };
      const summary = 'Interrupted by a restart; the next beat sees the same changes.';
      const audit = recordBeat({ agent, outcome: 'failed', summary, reason: 'restart' });
      this.deps.store.finishBeat(beat.id, {
        endedAt: at,
        outcome: 'failed',
        summary,
        ...(audit ? { auditSeq: audit.seq } : {}),
      });
    }
  }

  /** Arm every timed agent's first beat after a start. */
  private async armAll(generation: number): Promise<void> {
    if (!this.deps.enabled()) return;
    const now = this.clock.now();
    for (const agent of this.deps.agents.list()) {
      if (!this.deps.runtimeRegistered(agent.runtime)) {
        this.noteSkipped(agent);
        continue;
      }
      if (this.deps.isPaused?.(agent.id)) continue;
      const plan = await this.plan(agent);
      // Stopped (or restarted) while that read was in flight: arm nothing.
      if (generation !== this.generation) return;
      if (plan.settings.wake !== 'timed') continue;
      const state = this.deps.store.getState(agent.id);
      const interval = beatInterval(this.cadence(agent.id), now);
      this.scheduler.armAt(
        agent.id,
        startupBeatAt(now, state?.lastBeatAt ?? null, interval, this.deps.random)
      );
    }
  }

  /**
   * Look for `HEARTBEAT.md` edits on disk and new agents every few minutes. A
   * scan re-arms only while its own timer is still the current one, so a stop
   * and start during a scan leaves one chain, not two.
   */
  private armScan(): void {
    const handle = this.clock.setTimeout(() => {
      void this.scan().finally(() => {
        if (this.started && this.scanHandle === handle) this.armScan();
      });
    }, FILE_SCAN_MS);
    this.scanHandle = handle;
  }

  /** One scan: re-arm an agent whose file changed, or that is new. */
  private async scan(): Promise<void> {
    for (const agent of this.deps.agents.list()) {
      if (!this.started) return;
      if (!this.deps.runtimeRegistered(agent.runtime) || this.running.has(agent.id)) continue;
      // A paused agent is disarmed; once a person resumes it, it arms again here.
      if (this.deps.isPaused?.(agent.id)) {
        this.pausedSeen.add(agent.id);
        continue;
      }
      const resumed = this.pausedSeen.delete(agent.id);
      const read = await (this.deps.readHeartbeat ?? readHeartbeatFile)(agent.projectPath);
      const mtime = read.kind === 'absent' ? 0 : read.mtimeMs;
      const known = this.fileMtimes.get(agent.id);
      if (!resumed && known !== undefined && known === mtime) continue;
      await this.refreshAgent(agent.id);
    }
  }

  /** Prune beat rows past retention, now and daily. */
  private armPrune(): void {
    pruneOldBeats(this.deps.store, this.clock.now());
    this.pruneHandle = this.clock.setTimeout(() => this.armPrune(), PRUNE_EVERY_MS);
  }

  /**
   * The facts the cadence table reads for an agent now.
   *
   * @param agentId - The agent.
   */
  private cadence(agentId: string): CadenceFacts {
    return cadenceFacts(this.deps, agentId, this.clock.now());
  }

  /**
   * Read the agent's `HEARTBEAT.md` fresh, and note when the file last changed.
   *
   * @param agent - The agent.
   */
  private async plan(agent: BeatAgent): Promise<BeatPlan<BeatAgent>> {
    const plan = await planBeat(this.deps, agent);
    this.fileMtimes.set(agent.id, plan.mtimeMs);
    return plan;
  }

  /** Arm an agent's next timed beat, or disarm it when it does not beat on a timer. */
  private armNext(plan: BeatPlan<BeatAgent>): void {
    const { agent, settings } = plan;
    if (
      !this.started ||
      !this.deps.enabled() ||
      settings.wake !== 'timed' ||
      this.deps.isPaused?.(agent.id) ||
      !this.deps.runtimeRegistered(agent.runtime)
    ) {
      this.scheduler.cancel(agent.id);
      return;
    }
    const now = this.clock.now();
    const interval = withJitter(beatInterval(this.cadence(agent.id), now), this.deps.random);
    this.scheduler.armAt(agent.id, now + interval);
  }
}
