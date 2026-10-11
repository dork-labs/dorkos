/**
 * A beat's triage on the decision ladder (spec `heartbeats` §6.2): does what
 * the gatherers found need the agent now, can it wait for the next report, or
 * does nothing need it at all?
 *
 * {@link triageBeat} speaks heartbeat words in and out, so
 * `services/heartbeats/` never imports a decision type. Inside, `runLadder`
 * runs with the policy `heartbeat.triage`:
 *
 * - **Rung 0** is the rules rung (§6.1) as a rules bridge: `work` answers `b2`,
 *   `quiet` answers `a1`, and `undecided` abstains so the next rung is asked.
 * - **Rung 1** is the DorkOS credits bridge, only when a person chose credits
 *   for checks and they can be had right now (`triage-credits.ts`); otherwise it
 *   is absent. There is no rung 2: the agent's own runtime is the frontier.
 * - **Unsure goes up, never down to silence.** `review`, `unsure` (every
 *   reason, the daily fuse included) and `b2` mean a turn on the agent's own
 *   runtime, the "person or agent with authority" this ladder escalates to.
 * - **Money, customers, security.** A change that touches one is dismissed
 *   (`a1` or `c3`) only by an answer carrying a measured token probability of at
 *   least {@link TOUCHES_DISMISS_FLOOR}. An ask-twice confidence never dismisses
 *   it (canon §5.2 step 3: confident to say nothing).
 *
 * Every rung's model id, answer, confidence and token usage comes back in the
 * outcome, for the beat's `heartbeat_beats` row (§11). Nothing here holds a key.
 *
 * @module services/decisions/heartbeat-triage
 */
import { createRulesModel, runLadder, type DailyCallCounter } from '@dorkos/decisions';
import type { DecisionModel, DecisionPolicy } from '@dorkos/shared/decision-model';
import type { Change } from '../heartbeats/gatherers/index.js';
import type { TriageVerdict } from '../heartbeats/triage-rules.js';

/** The use case every triage call is counted and recorded under. */
export const TRIAGE_USE_CASE = 'heartbeat.triage';

/** Rung-1 calls per server per UTC day before the fuse sends every beat to a turn. */
export const TRIAGE_FUSE = 2_000;

/** The token probability a dismissal of a money, customers or security change needs. */
export const TOUCHES_DISMISS_FLOOR = 0.9;

/** The one question's id. */
const QUESTION = 'triage';

/**
 * The policy (§6.2). Neutral labels, because a decision model follows an
 * option's name more than its description. `whenUnsure` is required by the
 * schema and does nothing here: every unsure verdict is a turn.
 */
export const HEARTBEAT_TRIAGE_POLICY: DecisionPolicy = {
  useCase: TRIAGE_USE_CASE,
  rules: [
    'An AI agent woke up and looked at what changed since it last looked.',
    'Decide whether the agent needs to do anything about these changes.',
    'Pick b2 when someone is waiting on the agent, something it owns failed, or a promise is late.',
    'Pick c3 when the changes are worth telling its manager but nobody is waiting.',
    'Pick a1 only when nothing here needs the agent at all.',
    'When in doubt, pick b2.',
  ].join('\n'),
  questions: {
    [QUESTION]: {
      kind: 'choice',
      instructions: 'What should happen with these changes?',
      labels: {
        a1: 'Nothing needs the agent.',
        b2: 'The agent should work on it now.',
        c3: 'It can wait for the agent’s next report.',
      },
    },
  },
  actAbove: 0.8,
  escalateBelow: 0.5,
  whenUnsure: 'hold',
  serious: [],
  dailyCallCap: { rung1: TRIAGE_FUSE, rung2: 0 },
};

/** What triage says happens next. */
export type TriageDecision = 'quiet' | 'queue' | 'turn';

/** Tokens one check read and wrote. */
export interface TriageUsage {
  /** Tokens read. */
  inputTokens: number;
  /** Tokens written. */
  outputTokens: number;
}

/** One rung the ladder reached, for the beat's row. */
export interface TriageStep {
  /** 0 is the rules, 1 the decision model. */
  rung: 0 | 1;
  /** The model id (or rules id) that answered. */
  model: string;
  /** The label it picked, or null when it abstained, failed or was skipped. */
  answer: string | null;
  /** Its confidence, 0 to 1. */
  confidence: number;
  /** The measured probability of its answer, when the model gave one. */
  probability?: number;
  /** Tokens it used, when it reported them. */
  usage?: TriageUsage;
  /** Why there was no answer, when there was none. */
  failure?: string;
  /** Set when the fuse stopped the call before it was made. */
  skipped?: 'fuse';
  /** Requests rung 1 sent to the endpoint (an ask-twice is two); 0 when none went out. */
  requests?: number;
}

/** What {@link triageBeat} answers, in heartbeat words. */
export interface TriageOutcome {
  /** Quiet, queue for the report, or a turn. */
  decision: TriageDecision;
  /** One plain sentence saying why, for the record. */
  why: string;
  /** Where rung 1 ran: on DorkOS credits, or nowhere (the runtime decides). */
  source: 'credits' | 'runtime';
  /** Every rung reached. */
  steps: TriageStep[];
}

/** What triage reads besides the changes. */
export interface TriageBeatContext {
  /** The agent's name. */
  agentName: string;
  /** `HEARTBEAT.md`'s body, or null when it has none. */
  checklist: string | null;
  /** The rules rung's verdict on these same changes (`triage-rules.ts`). */
  rules: TriageVerdict;
  /** Stop asking when this fires. */
  signal?: AbortSignal;
}

/** What one triage needs from the server. */
export interface TriageBeatDeps {
  /** This beat's credits bridge when it may be used right now, else undefined. */
  creditsModel(): Promise<{ model: DecisionModel; requests(): number } | undefined>;
  /** The fuse as the ladder reads it (`triage-credits.ts` counts requests). */
  counter: DailyCallCounter;
  /** The clock. */
  now?: () => number;
}

/** The changes as the model reads them: no ids beyond the stable key, never a body. */
function itemOf(changes: readonly Change[]): Record<string, unknown> {
  return {
    changes: changes.map((change) => ({
      from: change.gatherer,
      kind: change.signal,
      what: change.summary,
      at: change.at,
      ...(change.touches?.length ? { touches: change.touches } : {}),
    })),
  };
}

/** The rules rung as a bridge: clear answers only, abstaining on `undecided`. */
function rulesBridge(verdict: TriageVerdict): DecisionModel {
  return createRulesModel({
    id: 'rules:heartbeat.triage',
    checks: {
      [QUESTION]: () =>
        verdict === 'work'
          ? { value: 'b2', reason: 'Someone or something is waiting on it.' }
          : verdict === 'quiet'
            ? { value: 'a1', reason: 'Nothing here needs it.' }
            : undefined,
    },
  });
}

/** The label an answer picked, when it picked a string. */
function labelOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The ladder's steps in heartbeat words. */
function stepsOf(outcome: Awaited<ReturnType<typeof runLadder>>): TriageStep[] {
  return outcome.steps.map((step): TriageStep => {
    const rung = step.rung === 0 ? 0 : 1;
    if ('skipped' in step) {
      return { rung, model: step.modelId, answer: null, confidence: 0, skipped: 'fuse' };
    }
    const answer = step.result.answers[QUESTION];
    const label = labelOf(answer?.value);
    const probability = label !== null ? answer?.probabilities?.[label] : undefined;
    return {
      rung,
      model: step.result.modelId,
      answer: label,
      confidence: step.confidence,
      ...(probability !== undefined ? { probability } : {}),
      ...(step.result.usage ? { usage: step.result.usage } : {}),
      ...(answer?.failure ? { failure: answer.failure } : {}),
    };
  });
}

/**
 * Triage a beat's changes with these deps. {@link triageBeat} is this with the
 * server's own.
 *
 * @param deps - The credits bridge, the fuse and the clock.
 * @param changes - What the gatherers found, after the rules rung's filter.
 * @param context - The agent and the rules rung's verdict.
 */
export async function triageBeatWith(
  deps: TriageBeatDeps,
  changes: readonly Change[],
  context: TriageBeatContext
): Promise<TriageOutcome> {
  const credits = context.rules === 'undecided' ? await deps.creditsModel() : undefined;
  const source = credits ? 'credits' : 'runtime';
  const outcome = await runLadder(
    HEARTBEAT_TRIAGE_POLICY,
    { rules: rulesBridge(context.rules), ...(credits ? { decision: credits.model } : {}) },
    {
      item: itemOf(changes),
      context: { agent: context.agentName, heartbeat: context.checklist ?? '' },
    },
    {
      counter: deps.counter,
      ...(deps.now ? { now: deps.now } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    }
  );
  const steps = stepsOf(outcome).map((step) =>
    step.rung === 1 && credits ? { ...step, requests: credits.requests() } : step
  );
  const turn = (why: string): TriageOutcome => ({ decision: 'turn', why, source, steps });
  const { verdict } = outcome;
  if (verdict.kind === 'unsure') {
    return turn(
      verdict.reason === 'cap-reached'
        ? 'Too many checks today, so its own runtime decides.'
        : 'No check was sure, so its own runtime decides.'
    );
  }
  if (verdict.kind !== 'act')
    return turn('A check was not sure enough, so its own runtime decides.');
  const label = labelOf(verdict.answers[QUESTION]?.value);
  if (label === 'b2' || label === null) return turn('A check found work for it.');
  const touches = changes.some((change) => (change.touches?.length ?? 0) > 0);
  const probability = verdict.answers[QUESTION]?.probabilities?.[label];
  if (touches && (probability === undefined || probability < TOUCHES_DISMISS_FLOOR)) {
    return turn('It touches money, customers or security, so its own runtime decides.');
  }
  return label === 'a1'
    ? { decision: 'quiet', why: 'A check found nothing that needs it.', source, steps }
    : { decision: 'queue', why: 'A check found it can wait for the next report.', source, steps };
}

/** Rules only: no credits bridge, and a counter nothing ever reaches. */
const RULES_ONLY: TriageBeatDeps = {
  creditsModel: async () => undefined,
  counter: { count: () => 0, increment: () => undefined },
};

/** The server's deps, set once at startup (`setHeartbeatTriage`). */
let serverDeps: TriageBeatDeps | undefined;

/**
 * Set (or clear) the deps {@link triageBeat} uses. Called by the heartbeat
 * wiring at startup.
 *
 * @param deps - The server's credits bridge and fuse, or undefined.
 */
export function setHeartbeatTriage(deps: TriageBeatDeps | undefined): void {
  serverDeps = deps;
}

/**
 * Triage a beat's changes (spec `heartbeats` §6.2). Before startup wires the
 * credits bridge in, rung 1 is absent and the rules decide what they can.
 *
 * @param changes - What the gatherers found, after the rules rung's filter.
 * @param context - The agent and the rules rung's verdict.
 */
export function triageBeat(
  changes: readonly Change[],
  context: TriageBeatContext
): Promise<TriageOutcome> {
  return triageBeatWith(serverDeps ?? RULES_ONLY, changes, context);
}
