/**
 * How a beat asks triage what to do, and what it does with a "can wait" (spec
 * `heartbeats` §6.2, §9.3). `beat-cycle.ts` holds the port; this module holds
 * the decision about when to ask, and the production port over
 * `services/decisions/heartbeat-triage.ts`.
 *
 * - **A sweep always turns** (§3.4): the agent looks around on its own, so no
 *   check is spent deciding whether it should.
 * - **Quiet by the rules, no model.** A beat whose rules rung kept nothing, or
 *   only news that needs nobody, ends quiet here, as it did before triage had
 *   a model.
 * - **Without a port, the rules decide** (`work` and `undecided` are a turn,
 *   as in PR 3): unsure goes up to the runtime, never down to silence.
 * - **"Can wait" joins the report queue** as one `triage` line per change,
 *   keyed by the change's own key, so the same fact seen twice is reported once.
 *
 * @module services/heartbeats/triage/beat-triage
 */
import type { BeatKind } from '@dorkos/shared/heartbeat-schemas';
import { triageBeat, type TriageOutcome } from '../../decisions/heartbeat-triage.js';
import type { Change } from '../gatherers/index.js';
import type { RaiseStore } from '../raises/raise-store.js';
import type { TriageVerdict } from '../triage-rules.js';

/** What a beat does after triage. */
export type BeatDecision = 'quiet' | 'queue' | 'turn';

/** What triage told one beat. */
export interface BeatTriageResult {
  /** Quiet, queue for the report, or a turn. */
  decision: BeatDecision;
  /** One plain sentence for the record. */
  why: string;
  /** The beat row's `triage` column: rung, model ids, answers, confidence, usage. */
  record: string;
}

/** What a beat needs to triage with a model and queue what can wait. */
export interface BeatTriagePort {
  /**
   * Triage changes the rules could not settle alone.
   *
   * @param changes - What the rules rung kept.
   * @param context - The agent, its checklist and the rules verdict.
   */
  triage(
    changes: readonly Change[],
    context: {
      agentName: string;
      checklist: string | null;
      rules: TriageVerdict;
      signal?: AbortSignal;
    }
  ): Promise<BeatTriageResult>;
  /**
   * Put changes that can wait in the agent's next report.
   *
   * @param input - The agent, the beat, the changes and when.
   */
  queue(input: { agentId: string; beatId: string; changes: readonly Change[]; at: string }): void;
}

/** What the beat knows when it asks. */
export interface BeatTriageInput {
  /** The beat's kind. */
  kind: BeatKind;
  /** The rules rung's verdict. */
  verdict: TriageVerdict;
  /** The changes the rules rung kept. */
  considered: readonly Change[];
  /** The agent's name. */
  agentName: string;
  /** Its `HEARTBEAT.md` body. */
  checklist: string | null;
  /** Fires when the runner stops: a check in flight stops asking. */
  signal?: AbortSignal;
}

/** The record a rules-only decision leaves, as PR 3 wrote it. */
function rulesRecord(verdict: TriageVerdict): string {
  return JSON.stringify({ rung: 'rules', verdict });
}

/**
 * Decide what a beat does next.
 *
 * @param port - The model triage, when this server has it.
 * @param input - What the beat knows.
 */
export async function decideBeat(
  port: BeatTriagePort | undefined,
  input: BeatTriageInput
): Promise<BeatTriageResult> {
  const { verdict, considered } = input;
  const byRules = (decision: BeatDecision, why: string): BeatTriageResult => ({
    decision,
    why,
    record: rulesRecord(verdict),
  });
  if (input.kind === 'sweep') return byRules('turn', 'A sweep looks around whatever it found.');
  if (verdict === 'quiet') return byRules('quiet', 'Nothing needs it.');
  if (!port) return byRules('turn', 'The rules sent it to its own runtime.');
  return port.triage(considered, {
    agentName: input.agentName,
    checklist: input.checklist,
    rules: verdict,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/** One line per change, for the report. */
const QUEUED_LINE_MAX = 300;

/**
 * The production port: `triageBeat` for the decision, the report queue for
 * what can wait.
 *
 * @param raises - The report queue.
 * @param mintId - Mints row ids.
 * @param triage - The triage call; `triageBeat` unless a test passes another.
 */
export function createBeatTriagePort(
  raises: Pick<RaiseStore, 'queueItem'>,
  mintId: () => string,
  triage: typeof triageBeat = triageBeat
): BeatTriagePort {
  return {
    async triage(changes, context) {
      const outcome: TriageOutcome = await triage(changes, context);
      return {
        decision: outcome.decision,
        why: outcome.why,
        record: JSON.stringify({
          rung: outcome.steps.some((step) => step.rung === 1) ? 'model' : 'rules',
          verdict: outcome.decision,
          why: outcome.why,
          source: outcome.source,
          steps: outcome.steps,
        }),
      };
    },
    queue({ agentId, beatId, changes, at }) {
      for (const change of changes) {
        raises.queueItem(
          mintId(),
          {
            agentId,
            kind: 'triage',
            text: change.summary.slice(0, QUEUED_LINE_MAX),
            key: `triage:${change.key}`,
            about: JSON.stringify([change.key]),
            beatId,
          },
          at
        );
      }
    },
  };
}
