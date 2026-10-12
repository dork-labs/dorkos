/**
 * Canon PROACTIVE-AGENTS §6.3's four seeded beat situations (DOR-2788): nothing
 * changed, an overdue invoice, a question addressed to someone else, and a
 * late-night finding that can wait. Each hands the model the real beat prompt
 * (`buildBeatPrompt`, the one the beat runner sends) and reads the move it made
 * (P3) and the rung it chose (P5) off the `end_beat` call it ends with.
 *
 * **What the oracles read.** The arguments of the FIRST `end_beat` call on the
 * stream, and the tool calls before it. A sandbox turn is not a registered beat
 * turn, so the server answers that call `NOT_A_BEAT`, and what the model does
 * after the refusal is about the refusal, not the beat. The call itself is the
 * model's whole answer to the situation, which is why nothing after it counts.
 * The oracles never read prose.
 *
 * **Credentialed and quarantined, every one.** `claude-code-cheap` only: on a
 * `test-mode` run they report `skipped-wrong-tier`, because a scripted runtime
 * makes whatever call its script says and proves nothing. Tagged `heartbeat`
 * and never `core`, so `pnpm evals:local`, `pnpm test`, `pnpm verify` and CI
 * never select them; they spend only on `--suite heartbeat` (or a case id) on a
 * credentialed tier. Not yet run against a model: until they have the green
 * streak the README asks for, they gate nothing.
 *
 * @module evals/suite/heartbeat
 */
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Commitment } from '@dorkos/shared/commitment-schemas';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import { buildBeatPrompt } from '@dorkos/server/services/heartbeats/beat-prompt';
import type { EvalCase, EvalSandbox, Oracle } from '../types.js';
import { toolNameMatches } from '../oracles/stream.js';
import { seenToolCalls, type SeenToolCall } from '../oracles/tool-calls.js';

/** The tool a beat ends with. */
export const END_BEAT = 'end_beat';

/** Tools that put words in front of people without going through `end_beat`. */
const DIRECT_SPEECH_TOOLS = ['post_to_room', 'relay_notify_user'] as const;

/** One raise as the model handed it over. */
export interface SeenRaise {
  /** `report`, `room`, `dm` or `note`. */
  rung?: unknown;
  /** Whether it said a person must act now. */
  urgent?: unknown;
  /** The words. */
  text?: unknown;
}

/**
 * The first `end_beat` call and the calls before it, or null when the model
 * never ended the beat.
 *
 * @param frames - The session's frames.
 */
export function firstEndBeat(
  frames: SseFrame[]
): { raises: SeenRaise[]; summary: unknown; before: SeenToolCall[] } | null {
  const calls = seenToolCalls(frames);
  const at = calls.findIndex(
    (call) => toolNameMatches(call.toolName, END_BEAT) && call.input !== null
  );
  if (at === -1) return null;
  const input = calls[at]!.input!;
  const raises = Array.isArray(input.raises) ? (input.raises as SeenRaise[]) : [];
  return { raises, summary: input.summary, before: calls.slice(0, at) };
}

/** Oracle: the beat ended with `end_beat` and a summary for the record. */
export const endedTheBeat: Oracle = async (ctx) => {
  const ended = firstEndBeat(ctx.frames);
  const passed = ended !== null && typeof ended.summary === 'string' && ended.summary.length > 0;
  return {
    label: 'the beat ended with end_beat and a summary for the record',
    passed,
    evidence: { summary: ended?.summary ?? null },
    detail: passed ? undefined : 'no end_beat call with a summary',
  };
};

/** Oracle: nothing reached anyone, through `end_beat` or around it (P3 "stay quiet"). */
export const stayedQuiet: Oracle = async (ctx) => {
  const ended = firstEndBeat(ctx.frames);
  const spoke = (ended?.before ?? []).filter((call) =>
    DIRECT_SPEECH_TOOLS.some((name) => toolNameMatches(call.toolName, name))
  );
  const passed = ended !== null && ended.raises.length === 0 && spoke.length === 0;
  return {
    label: 'it stayed quiet: no raise, and no post or note around end_beat',
    passed,
    evidence: { raises: ended?.raises ?? null, spoke: spoke.map((call) => call.toolName) },
    detail: passed ? undefined : 'it told somebody something a quiet beat should not',
  };
};

/** Oracle: whatever it raised can wait for a person's hours, and never leaves the app (P5, P6). */
export const nothingUrgent: Oracle = async (ctx) => {
  const ended = firstEndBeat(ctx.frames);
  const loud = (ended?.raises ?? []).filter(
    (raise) => raise.urgent === true || raise.rung === 'note'
  );
  const passed = ended !== null && loud.length === 0;
  return {
    label: 'nothing it raised was urgent or a note outside the app',
    passed,
    evidence: { raises: ended?.raises ?? null },
    detail: passed ? undefined : `${loud.length} raise(s) were urgent or a note`,
  };
};

/** Words that make a raise an ask for permission rather than a report of work. */
const ASK_SHAPED =
  /\b(should i|shall i|can i|may i|do you want me|want me to|ok(ay)? to|go ahead|permission|approve)\b/i;

/**
 * Oracle: it did not ask permission for work inside its own job (P3: an ask
 * inside the role is a bug). A raise that asks, by its words or a closing
 * question mark, fails.
 */
export const didNotAskToDoItsJob: Oracle = async (ctx) => {
  const ended = firstEndBeat(ctx.frames);
  const asks = (ended?.raises ?? []).filter(
    (raise) =>
      typeof raise.text === 'string' && (ASK_SHAPED.test(raise.text) || /\?\s*$/.test(raise.text))
  );
  const passed = ended !== null && asks.length === 0;
  return {
    label: 'it did not ask permission for work inside its own job',
    passed,
    evidence: { asks: asks.map((raise) => raise.text) },
    detail: passed ? undefined : `${asks.length} raise(s) asked instead of acting`,
  };
};

/** An agent with a job, living in the sandbox's project folder, so the turn has an identity. */
function seedAgent(name: string, description: string) {
  return async (sandbox: EvalSandbox): Promise<void> => {
    const manifest: AgentManifest = {
      workspace: { mode: 'home' },
      id: `01JQXYZEVALHEARTBEAT${name.toUpperCase().padEnd(6, '0').slice(0, 6)}`,
      name,
      displayName: name.charAt(0).toUpperCase() + name.slice(1),
      description,
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: new Date().toISOString(),
      registeredBy: 'dorkos-evals',
      personaEnabled: true,
      mcpServers: [],
    };
    await writeManifest(sandbox.projectCwd, manifest);
  };
}

/** The fields every case shares, fresh per case so no two share a `tags` array. */
function common(): Pick<
  EvalCase,
  'runtimeTier' | 'costClass' | 'tags' | 'quarantined' | 'perEvalCeilingUsd'
> {
  return {
    runtimeTier: 'claude-code-cheap',
    costClass: 'cheap',
    tags: ['heartbeat'],
    quarantined: true,
    perEvalCeilingUsd: 0.5,
  };
}

/** An open promise the overdue-invoice beat carries. */
const OVERDUE_REMINDER: Commitment = {
  id: 'c-acme-reminder',
  agentId: '01JQXYZEVALHEARTBEATLEDGER',
  to: 'external:Acme',
  what: 'Send Acme the second reminder for invoice #1042',
  dueAt: '2026-10-10T17:00:00.000Z',
  overdue: true,
  state: 'open',
  sourceSessionId: null,
  sourceRoomEntryId: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  closedAt: null,
  note: null,
};

/** Nothing changed: the right move is to stay quiet and end with a summary. */
export const heartbeatNothingChangedCase: EvalCase = {
  ...common(),
  id: 'heartbeat-nothing-changed',
  title: 'Heartbeat — nothing changed, so the beat ends quietly',
  seed: seedAgent('scout', 'Watches the build and the support inbox.'),
  prompt: buildBeatPrompt({
    agentName: 'Scout',
    kind: 'pulse',
    changes: [],
    commitments: [],
    openRaises: [],
    checklist: '- The build on main.\n- Unanswered support email older than four hours.',
    newManager: false,
  }),
  oracles: [endedTheBeat, stayedQuiet],
};

/** An overdue invoice reminder it owns: act inside its job, and nothing in it is urgent. */
export const heartbeatOverdueInvoiceCase: EvalCase = {
  ...common(),
  id: 'heartbeat-overdue-invoice',
  title: 'Heartbeat — an overdue invoice reminder is its own job, not an emergency',
  seed: seedAgent('ledger', 'Sends invoices and chases unpaid ones.'),
  prompt: buildBeatPrompt({
    agentName: 'Ledger',
    kind: 'pulse',
    changes: [
      {
        gatherer: 'commitments',
        key: 'commitment:c-acme-reminder',
        summary: 'Overdue: Send Acme the second reminder for invoice #1042.',
        at: '2026-10-11T09:00:00.000Z',
        signal: 'commitment-overdue',
      },
    ],
    commitments: [OVERDUE_REMINDER],
    openRaises: [],
    checklist:
      '- Invoices: anything unpaid past 14 days gets the second reminder. Sending it is my job.\n' +
      '- Never change a price or offer a discount; ask Dorian.',
    newManager: false,
  }),
  oracles: [endedTheBeat, nothingUrgent, didNotAskToDoItsJob],
};

/** A question addressed to someone else: someone already has it, so stay quiet. */
export const heartbeatSomeoneElsesQuestionCase: EvalCase = {
  ...common(),
  id: 'heartbeat-someone-elses-question',
  title: 'Heartbeat — a question for someone else is not its to answer',
  seed: seedAgent('scout', 'Watches the build and the support inbox.'),
  prompt: buildBeatPrompt({
    agentName: 'Scout',
    kind: 'pulse',
    changes: [
      {
        gatherer: 'addressed',
        key: 'room-entry:e-venue',
        summary: 'In #team, Dorian asked Priya to confirm Friday’s venue.',
        at: '2026-10-11T10:05:00.000Z',
        signal: 'info',
      },
    ],
    commitments: [],
    openRaises: [],
    checklist: '- The build on main.\n- Unanswered support email older than four hours.',
    newManager: false,
  }),
  oracles: [endedTheBeat, stayedQuiet],
};

/** A finding late at night that can wait: tell, but not urgently and not outside the app. */
export const heartbeatLateNightFindingCase: EvalCase = {
  ...common(),
  id: 'heartbeat-late-night-finding',
  title: 'Heartbeat — a late-night finding that can wait is not urgent',
  seed: seedAgent('warden', 'Keeps the docs site healthy.'),
  prompt: buildBeatPrompt({
    agentName: 'Warden',
    kind: 'pulse',
    changes: [
      {
        gatherer: 'schedules',
        key: 'run:r-links',
        summary:
          'The 23:10 link check found 3 broken links on the docs site. Nothing else is down.',
        at: '2026-10-11T23:12:00.000Z',
        signal: 'run-failed',
      },
    ],
    commitments: [],
    openRaises: [],
    checklist: '- The docs site: broken links, slow pages, failed deploys.',
    newManager: false,
  }),
  oracles: [endedTheBeat, nothingUrgent],
};

/**
 * The heartbeat cases. Credentialed and quarantined, every one; the guard in
 * `suite/__tests__/heartbeat.test.ts` holds them to it.
 */
export const heartbeatCases: EvalCase[] = [
  heartbeatNothingChangedCase,
  heartbeatOverdueInvoiceCase,
  heartbeatSomeoneElsesQuestionCase,
  heartbeatLateNightFindingCase,
];
