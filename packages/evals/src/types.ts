/**
 * Core eval-harness types: the eval-case contract, its runtime/cost taxonomy,
 * the oracle function shape, and the machine-readable result schemas that feed
 * `results.json` and the transcript writer.
 *
 * Data-shaped types (`RuntimeTier`, `CostClass`, `OracleResult`, `EvalResult`,
 * `RunSummary`) are Zod-backed so a hand-written fixture or a `results.json`
 * on disk can be parsed and validated — stringly-typed code is banned
 * (Hard Rule). The behavioral pieces that hold functions (`Oracle`,
 * `RubricJudge`, and therefore `EvalCase`) are TypeScript interfaces layered
 * over the Zod-validated metadata.
 *
 * @module evals/types
 */
import { z } from 'zod';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { UiActionRequest } from '@dorkos/shared/schemas';

/**
 * Which backend an eval runs against.
 * - `test-mode`: the in-process deterministic runtime (no model, free).
 * - `claude-code-cheap`: real `claude-code` on a cheap (Haiku-class) model —
 *   the judgment tier that exercises tool-choice-from-natural-language.
 * - `real-provider`: a real EXTERNAL provider (OpenRouter today) reached through
 *   a non-Anthropic runtime — the tier that proves DorkOS's chat surface works
 *   on somebody else's model. It spends money that is NOT a Claude subscription,
 *   so it is gated twice over: `DORKOS_EVALS_PAID_PROVIDER=1` (the decision) AND
 *   {@link OPENROUTER_API_KEY_VAR} (the instrument). See `runner/credentials.ts`.
 */
export const RuntimeTierSchema = z.enum(['test-mode', 'claude-code-cheap', 'real-provider']);

/** Inferred type for {@link RuntimeTierSchema}. */
export type RuntimeTier = z.infer<typeof RuntimeTierSchema>;

/**
 * Which DorkOS agent runtime an eval's session is bound to.
 *
 * These are the production `AgentRuntime` type ids (`services/runtimes/`), not
 * a harness invention: the value travels to the server as the `runtime` hint on
 * the first `POST /api/sessions/:id/messages` (ADR-0255, first-write-wins), so a
 * value this enum does not carry would be rejected by the route rather than
 * quietly ignored.
 *
 * `test-mode` is deliberately absent — the deterministic runtime is selected by
 * the TIER, never by this field.
 */
export const EvalRuntimeSchema = z.enum(['claude-code', 'codex', 'opencode']);

/** Inferred type for {@link EvalRuntimeSchema}. */
export type EvalRuntime = z.infer<typeof EvalRuntimeSchema>;

/**
 * The isolation an eval's server ACTUALLY ran inside — the durable record of
 * containment, not the request.
 *
 * `--isolation auto` + `preferDocker` is a PREFERENCE: a case that asked for a
 * container silently runs on the child-process tier when no daemon or eval image
 * is present. Without this on the result, `results.json` cannot tell the person
 * promoting a destructive case out of quarantine whether its destructive turn
 * ran in a container or on the bare host, and the only trace of the downgrade
 * was one ephemeral stderr line.
 *
 * - `in-process`: the `test-mode` harness server, inside the runner process.
 * - `child-process`: a credentialed server as a host subprocess.
 * - `docker`: a credentialed server in a per-eval container.
 */
export const IsolationRecordSchema = z.enum(['in-process', 'child-process', 'docker']);

/** Inferred type for {@link IsolationRecordSchema}. */
export type IsolationRecord = z.infer<typeof IsolationRecordSchema>;

/**
 * How a credentialed run reached a model, recorded so nobody has to guess which
 * credential a run actually used.
 *
 * - `anthropic-api-key`: the `ANTHROPIC_API_KEY` variable (an Anthropic API
 *   account pays).
 * - `claude-oauth-token`: the `CLAUDE_CODE_OAUTH_TOKEN` variable, a long-lived
 *   token from `claude setup-token` (a Claude subscription pays).
 * - `local-claude-login`: the `claude` CLI signed in on this machine, inherited
 *   by the child-process tier (the developer's own Claude subscription pays).
 *
 * The distinction is about WHO PAYS, and only that. It deliberately says nothing
 * about whether a turn reports a cost: the SDK computes `total_cost_usd` from
 * token counts with no auth-mode branch, so every source reports one. On the two
 * subscription sources that number is a list-price ESTIMATE of what the tokens
 * would have cost through the API rather than money billed — the subscription is
 * spent as quota — but it is still the only spend figure `--budget` can enforce
 * on. An earlier version of this comment claimed subscription turns report
 * nothing, and `report/summary.ts` downgraded a broken cost signal to a
 * reassuring note on the strength of it.
 */
export const CredentialSourceSchema = z.enum([
  'anthropic-api-key',
  'claude-oauth-token',
  'local-claude-login',
  'openrouter-api-key',
]);

/** Inferred type for {@link CredentialSourceSchema}. */
export type CredentialSource = z.infer<typeof CredentialSourceSchema>;

/** The environment variable CI dispatches a credentialed run with. */
export const API_KEY_VAR = 'ANTHROPIC_API_KEY';

/**
 * The subscription token variable, PINNED to this exact name. Letting a caller
 * choose which variable to read is a credential-disclosure lever, not a
 * convenience — see `runner/credentials.ts`. Adding a source means adding a
 * literal name, never an input.
 */
export const OAUTH_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * The OpenRouter key variable the `real-provider` tier reads, PINNED to this
 * exact name for the same reason {@link OAUTH_TOKEN_VAR} is: a run that let its
 * caller name which secret to read could be pointed at any secret on the machine
 * and have it shipped to a third party as an auth header. Adding a provider means
 * adding a literal name here, never an input.
 *
 * Deliberately NOT listed in `turbo.json` (`globalPassThroughEnv`, or the `test`
 * task's `passThroughEnv`). Turbo runs strict and strips anything it is not told
 * to pass, which is exactly what has kept `pnpm test`, `pnpm verify`, pre-push
 * and CI away from the Anthropic key. Adding this name there would open the paid
 * path to every one of them at once.
 */
export const OPENROUTER_API_KEY_VAR = 'OPENROUTER_API_KEY';

/**
 * The deliberate-act flag the `real-provider` tier needs BESIDE a key.
 *
 * A key alone must never arm a paid run: people leave `OPENROUTER_API_KEY`
 * exported in a shell profile because half the toolchain wants it, and an ambient
 * key is not a person asking to spend money. Same reasoning, same shape as
 * `DORKOS_EVALS_CREDENTIALED` in
 * `packages/evals/src/runner/__tests__/harness-server.test.ts`.
 */
export const PAID_PROVIDER_OPT_IN_VAR = 'DORKOS_EVALS_PAID_PROVIDER';

/**
 * The provider id the `real-provider` tier fronts today — the key into the
 * top-level `providers` config registry AND into OpenCode's own provider table,
 * which is why one string serves both (`services/core/credential-env.ts` maps
 * `openrouter → OPENROUTER_API_KEY`).
 */
export const OPENROUTER_PROVIDER_ID = 'openrouter';

/**
 * The pinned OpenRouter model the tier runs on, in DorkOS's `provider/model`
 * spelling.
 *
 * **The two-segment tail is load-bearing.** `parseModelSelection`
 * (`services/runtimes/opencode/messaging/turn-input.ts`) splits on the FIRST `/` only, so
 * this resolves to `{providerID: 'openrouter', modelID: 'qwen/qwen3.7-flash'}` —
 * the shape OpenCode's `session.promptAsync` body wants. Written any other way
 * (`qwen/qwen3.7-flash` alone, or `openrouter/qwen3.7-flash`) the sidecar is
 * handed a provider or a model that does not exist.
 *
 * Cheap on purpose and PAID on purpose. At $0.030/M in and $0.130/M out it is
 * roughly two orders of magnitude under the Haiku tier the credentialed suite
 * uses, and a `:free` id is not an acceptable substitute for a committed pin:
 * the free tier is rate-capped per day, counts failed calls against the quota,
 * needs an account-level training opt-in, and `openrouter/free` routes to a
 * DIFFERENT model per call — which makes any red unreproducible.
 */
export const DEFAULT_OPENROUTER_MODEL = 'openrouter/qwen/qwen3.7-flash';

/**
 * Default per-run spend ceiling for the `real-provider` tier, in USD.
 *
 * Far tighter than {@link DEFAULT_RUN_BUDGET_USD} because the tier's whole point
 * is that its turns cost fractions of a cent: a run that reaches even this is a
 * runaway loop, not a big suite. It is a tripwire, not an allowance.
 */
export const PAID_PROVIDER_RUN_BUDGET_USD = 0.5;

/** One human-readable line per source, for run output. */
const CREDENTIAL_SOURCE_LABELS: Record<CredentialSource, string> = {
  'anthropic-api-key': `the ${API_KEY_VAR} environment variable (billed to that API account)`,
  'claude-oauth-token': `the ${OAUTH_TOKEN_VAR} environment variable (billed to that Claude subscription)`,
  'local-claude-login':
    'the Claude sign-in on this machine (billed to your own Claude subscription)',
  'openrouter-api-key': `the ${OPENROUTER_API_KEY_VAR} environment variable (billed to that OpenRouter account)`,
};

/**
 * Describe a resolved source in one line, so a run's output says which
 * credential it used instead of leaving the reader to guess.
 *
 * Deliberately TOTAL: an unrecognized value returns a plain fallback rather than
 * throwing. This is called while rendering the summary table, and a report
 * printer that can die over a label would take the whole run's output with it —
 * including the results a reader needs in order to see what went wrong.
 *
 * These helpers live here, beside the enum, rather than next to the resolver:
 * `report/summary.ts` needs them to print two lines, and importing the resolver
 * would drag the server's `claude` auth probe into the reporting path for
 * nothing.
 *
 * @param source - The resolved credential source.
 * @returns The human-readable description.
 */
export function describeCredentialSource(source: CredentialSource): string {
  return CREDENTIAL_SOURCE_LABELS[source] ?? `an unrecognized credential source (${source})`;
}

/** Rough cost envelope, used for budget planning and tier selection. */
export const CostClassSchema = z.enum(['free', 'cheap', 'standard', 'deep']);

/** Inferred type for {@link CostClassSchema}. */
export type CostClass = z.infer<typeof CostClassSchema>;

/**
 * Suite membership. `smoke` is the cheap, label-gated PR subset; `core` is the
 * nightly-full product suite; `connector` is the (quarantined until W5)
 * connector-routing subset; `experimental` is the not-yet-gating tier — a case
 * that runs and reports but is deliberately kept OUT of `core` because a known
 * harness gap blocks it from being a reliable live gate (e.g. the multi-turn
 * credentialed drive's claude-code session-remap timeout).
 *
 * `rooms` is the channel suite (DOR-1217), and it is a tag of its own rather
 * than more `core` for one reason with money in it: `core` is run BOTH ways —
 * free on `--tier test-mode` in CI and CREDENTIALED by `pnpm evals:local` — so a
 * free structural case tagged `core` would quietly spend on every local run. The
 * rooms structural cases gate on `--suite rooms --tier test-mode` instead, and
 * the credentialed rooms cases carry `experimental` beside it like every other
 * not-yet-gating case.
 *
 * `memory` is the agent-memory suite (DOR-632): the cross-surface probes X-09,
 * X-12 and X-11b. It is separate from `rooms` even though its cases open a
 * channel, because what they measure is a fact crossing BETWEEN surfaces rather
 * than anything about a room, and because `--suite rooms` names the set
 * `suite/__tests__/rooms.test.ts` enumerates. Every case in it is credentialed
 * and quarantined, so the tag spends only when somebody selects it.
 *
 * `chat` is the cross-runtime chat-capability suite: one turn, one tool loop,
 * one approval round trip, one cost reading — the things a person does in the
 * chat pane, asserted STRUCTURALLY so the same case can run on `claude-code`
 * and on `opencode`/OpenRouter and mean the same thing on both. It is a tag of
 * its own for the same money reason `rooms` is: `core` is run credentialed by
 * `pnpm evals:local`, and these cases are meant to be pointed at a chosen
 * runtime with `--runtime`, not swept up by a default local run.
 */
export const EvalTagSchema = z.enum([
  'smoke',
  'core',
  'connector',
  'experimental',
  'rooms',
  'memory',
  'chat',
]);

/** Inferred type for {@link EvalTagSchema}. */
export type EvalTag = z.infer<typeof EvalTagSchema>;

/** The isolated sandbox an eval runs inside: a fresh project cwd + `DORK_HOME`. */
export interface EvalSandbox {
  /** Fresh temporary project working directory the turn runs in. */
  projectCwd: string;
  /** Fresh temporary `DORK_HOME` the runtime and oracles read/write. */
  dorkHome: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Answering approvals mid-turn (DOR-498)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How an eval case answers the two approval prompts a real turn can park on.
 *
 * DorkOS asks twice, through two unrelated mechanisms, and a case that drives a
 * tool has to satisfy both:
 *
 * 1. the RUNTIME's per-tool permission prompt — an `approval_required`
 *    SessionEvent answered at `POST /api/sessions/:id/approve|deny`. This is the
 *    prompt a person answers in the chat pane, and it is what stalled every
 *    tool-executing eval before this policy existed: nothing answered, so the
 *    turn sat until the harness timed out;
 * 2. the CAPABILITY TIER GATE — the `approval_required` payload a destructive
 *    capability returns instead of running, decided at
 *    `POST /api/approvals/:id/grant|deny`. This is the governance mechanism the
 *    governance suite exists to prove.
 *
 * DELIBERATELY NOT A BLANKET "SAY YES". {@link allowTools} is an allowlist and
 * everything outside it is DENIED and recorded, so a case cannot accidentally
 * wave through a tool it never meant to (the governance cases must, for example,
 * refuse an agent that gives up on the MCP tool and reaches for `Bash`).
 * {@link capability} names ONE capability id and ONE decision, so the "denied"
 * case cannot inherit the "granted" case's yes.
 */
export interface ApprovalPolicy {
  /**
   * Tools whose runtime permission prompt is ANSWERED WITH ALLOW, unqualified
   * (`marketplace_uninstall`, not `mcp__dorkos__marketplace_uninstall`) — matched
   * through `toolNameMatches`, never `===`, because the SDK qualifies a tool name
   * with its MCP server (`oracles/stream.ts`).
   *
   * Every prompt for a tool NOT listed here is answered with DENY. Denying is the
   * safe answer and it keeps the turn moving; leaving a prompt unanswered is what
   * produced the ten-minute stall this policy exists to end.
   */
  allowTools: string[];
  /**
   * The ONE capability approval this case decides, or omitted when the case's
   * whole point is that nobody answers (the expiry case).
   *
   * Scoped to a single capability id on purpose. A driver that granted whatever
   * showed up on `GET /api/approvals/pending` would make the "denied" case a lie:
   * it would inherit the yes and still look green because nothing was deleted.
   */
  capability?: {
    /** The capability id to decide, e.g. `marketplace.uninstall`. */
    capabilityId: string;
    /** What to answer. */
    decision: 'grant' | 'deny';
  };
}

/** One runtime tool-permission prompt the driver answered. */
export const ToolPermissionRecordSchema = z.object({
  /** The prompt's `toolCallId` (the durable frame's `id`). */
  toolCallId: z.string(),
  /** The tool name exactly as the stream carried it (MCP-qualified). */
  toolName: z.string(),
  /** What the driver answered, and why: an allowlist hit, or the deny default. */
  answer: z.enum(['allow', 'deny']),
  /** ISO timestamp the answer was POSTed. */
  answeredAt: z.string(),
  /** HTTP status the approve/deny route returned. */
  status: z.number(),
});

/** Inferred type for {@link ToolPermissionRecordSchema}. */
export type ToolPermissionRecord = z.infer<typeof ToolPermissionRecordSchema>;

/** One capability approval the driver decided at `/api/approvals/:id/…`. */
export const ApprovalDecisionRecordSchema = z.object({
  /** ULID of the approval that was decided. */
  approvalId: z.string(),
  /** The capability the approval was bound to. */
  capabilityId: z.string(),
  /** The tier the gate reported on the pending card. */
  tier: z.string(),
  /** What the driver answered. */
  decision: z.enum(['granted', 'denied']),
  /** ISO timestamp the decision was POSTed. */
  decidedAt: z.string(),
  /** HTTP status the grant/deny route returned (200 when it was recorded). */
  status: z.number(),
  /**
   * Whatever the case's probe captured IMMEDIATELY BEFORE the decision was sent.
   *
   * This is what makes a "granted" case falsifiable rather than decorative. The
   * package being gone at the END of a run proves only that it is gone; a probe
   * taken at the instant of the yes proves it was still there while nobody had
   * said yes — i.e. that the gate actually held. A run where the gate never fired
   * records no decision at all, so any oracle reading this goes red.
   */
  probe: z.unknown().optional(),
});

/** Inferred type for {@link ApprovalDecisionRecordSchema}. */
export type ApprovalDecisionRecord = z.infer<typeof ApprovalDecisionRecordSchema>;

/** Everything the approval driver did during a run, for the oracles and the transcript. */
export const ApprovalDriverLogSchema = z.object({
  /** Runtime tool-permission prompts answered, in the order they were answered. */
  toolPermissions: z.array(ToolPermissionRecordSchema),
  /** Capability approvals decided, in the order they were decided. */
  decisions: z.array(ApprovalDecisionRecordSchema),
  /**
   * Pending capability approvals the driver saw but deliberately left alone
   * because they did not match {@link ApprovalPolicy.capability} — recorded so
   * "nobody decided it" is legible as a choice rather than a gap.
   */
  ignored: z.array(z.object({ approvalId: z.string(), capabilityId: z.string() })),
  /**
   * Anything that went wrong while answering (a non-2xx, a socket error). Never
   * thrown: a driver fault must surface as eval evidence, not as a runner crash
   * that hides the turn it was watching.
   */
  errors: z.array(z.string()),
});

/** Inferred type for {@link ApprovalDriverLogSchema}. */
export type ApprovalDriverLog = z.infer<typeof ApprovalDriverLogSchema>;

/**
 * An empty driver log — what a case with no {@link ApprovalPolicy} presents to
 * its oracles, and the fixture value for tests that do not exercise approvals.
 *
 * @returns A fresh, empty log.
 */
export function emptyApprovalLog(): ApprovalDriverLog {
  return { toolPermissions: [], decisions: [], ignored: [], errors: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rooms (DOR-1217)
// ─────────────────────────────────────────────────────────────────────────────

/** One room member as the roster reports it. */
export interface RoomMemberFacts {
  /** The member's author id — what `mentions` and every signal carry. */
  authorId: string;
  /** The `@handle` an agent is addressed by, or null for a member with none. */
  handle: string | null;
  /** Human or agent. */
  kind: string;
  /** The member's response mode in THIS room. */
  responseMode: string;
}

/**
 * The room a case built, and the identities its oracles assert against.
 *
 * A room's identities are MINTED, not declared: an author id is a ULID the
 * server allocates the first time an agent joins a room, and a handle is derived
 * from the manifest name and suffixed on a collision. So a rooms oracle cannot
 * name its subject in advance the way a filesystem oracle names a path — the
 * script that built the room hands the ids forward here instead.
 */
export interface RoomFacts {
  /** The room's id. */
  roomId: string;
  /** Every member, keyed by author id. */
  members: Record<string, RoomMemberFacts>;
  /** Agent author ids keyed by the slug the case seeded them under. */
  agents: Record<string, string>;
  /** The author id every post in the drive was made as (the operator). */
  operatorAuthorId: string;
  /** Whatever the script recorded for its own oracles (a halt count, ids). */
  notes: Record<string, unknown>;
}

/** What a {@link EvalCase.roomScript} is handed. */
export interface RoomScriptContext {
  /** Base URL of the running harness server. */
  baseUrl: string;
  /** The eval sandbox — where seeded agents and their files live. */
  sandbox: EvalSandbox;
  /**
   * The project cwd as THIS SERVER sees it (the docker tier's mount point),
   * already resolved by the runner.
   */
  cwd: string;
  /** The run's per-turn timeout guard in ms, for a script that bounds its waits. */
  timeoutMs?: number;
}

/** What a {@link EvalCase.roomScript} hands back to the oracles. */
export interface RoomScriptResult {
  /** Every frame collected off `GET /api/rooms/:id/events`, in order. */
  frames: SseFrame[];
  /** The room the script built, and the identities it minted. */
  room: RoomFacts;
}

/**
 * Everything an oracle needs to assert an outcome: the sandbox filesystem, the
 * running server's base URL, the driven session id, every SSE frame the drive
 * loop collected, and what the approval driver answered while it ran. An oracle
 * reads the sandbox, calls the API, or inspects the collected stream — it never
 * reads the assistant's prose.
 */
export interface OracleContext {
  /** The isolated sandbox (project cwd + `DORK_HOME`) the eval ran in. */
  sandbox: EvalSandbox;
  /** Base URL of the running harness server (e.g. `http://127.0.0.1:53511`). */
  baseUrl: string;
  /** The session id the prompt was driven against. */
  sessionId: string;
  /** Every SSE frame collected off `GET /api/sessions/:id/events`, in order. */
  frames: SseFrame[];
  /**
   * What the approval driver answered during the turn. Empty when the case
   * carried no {@link ApprovalPolicy} — never undefined, so an oracle that reads
   * it on a case that forgot its policy fails loudly instead of vacuously.
   */
  approvals: ApprovalDriverLog;
  /**
   * The room a {@link EvalCase.roomScript} built, when this case drove one.
   * Undefined for every session-shaped case — a rooms oracle that finds it
   * missing fails rather than passing vacuously.
   */
  room?: RoomFacts;
}

/** The result of one oracle: whether the intended side effect occurred, with evidence. */
export const OracleResultSchema = z.object({
  /** Human-readable label for what this oracle checked (e.g. `install-metadata exists`). */
  label: z.string(),
  /** True iff the intended side effect occurred. */
  passed: z.boolean(),
  /**
   * The concrete evidence: the asserted path, the HTTP response, the matched
   * tool frame — whatever proves (or disproves) the outcome. Kept as `unknown`
   * so any oracle can attach its own evidence shape to the transcript.
   */
  evidence: z.unknown().optional(),
  /** One-line detail on a failure (why the side effect was not observed). */
  detail: z.string().optional(),
});

/** Inferred type for {@link OracleResultSchema}. */
export type OracleResult = z.infer<typeof OracleResultSchema>;

/**
 * An outcome check: resolves `passed: true` iff the intended side effect
 * occurred. Asserts API / filesystem / stream state, never prose.
 */
export type Oracle = (ctx: OracleContext) => Promise<OracleResult>;

/** The result of a rubric judge: a normalized score and its pass decision. */
export const RubricJudgeResultSchema = z.object({
  /** Version stamp of the rubric that produced this score (a scoring change is reviewable). */
  rubricVersion: z.string(),
  /** Normalized score in [0, 1]. */
  score: z.number().min(0).max(1),
  /** True iff `score` cleared the rubric's threshold. */
  passed: z.boolean(),
  /** The judge's one-paragraph rationale, for the transcript. */
  reasoning: z.string(),
});

/** Inferred type for {@link RubricJudgeResultSchema}. */
export type RubricJudgeResult = z.infer<typeof RubricJudgeResultSchema>;

/**
 * A versioned LLM-judge rubric, used ONLY where the outcome is inherently a
 * judgment (e.g. `safety-refusal`) and even then as the SECONDARY signal behind
 * a negative outcome oracle. The `version` + `criteria` are committed so a
 * scoring change is reviewable.
 */
export interface RubricJudge {
  /** Version stamp for the rubric (bump on any criteria/threshold change). */
  version: string;
  /** The committed rubric text the judge scores against. */
  criteria: string;
  /** Pass threshold in [0, 1]; a score at or above this passes. */
  threshold: number;
  /** Score this context against the rubric. */
  evaluate: (ctx: OracleContext) => Promise<RubricJudgeResult>;
}

/**
 * Serializable metadata for an eval case — everything except the oracle/rubric
 * functions. Zod-backed so a hand-written or on-disk case manifest validates.
 */
export const EvalCaseMetaSchema = z.object({
  /** Stable id, e.g. `marketplace-install`. */
  id: z.string().min(1),
  /** One-line intent. */
  title: z.string().min(1),
  /**
   * The natural-language prompt(s) sent to the session. An empty string marks a
   * structural (boot-only) case that asserts server/sandbox state without
   * driving a turn — the Phase 1 in-process harness registers no runtime, so a
   * real turn belongs to the credentialed tiers (Phase 2+).
   */
  prompt: z.union([z.string(), z.array(z.string())]),
  /**
   * Backend tier — LOAD-BEARING, not a label.
   *
   * A case declaring a credentialed tier is SKIPPED (`skipped-wrong-tier`) on a
   * `test-mode` run rather than being run against the deterministic runtime.
   * Before that skip existed, `--suite <name> --tier test-mode` ran every case
   * the tag selected and the adversarial-injection case reported `pass` with no
   * model attached — a green about a security property nothing had exercised,
   * which is the worst shape a false green can take.
   *
   * The asymmetry is deliberate: a `test-mode` case is NOT skipped on a
   * credentialed run by declaring `test-mode` alone. `widget-round-trip` is
   * runtime-agnostic by construction and is MEANT to run on both — its
   * `/ui-action` trigger needs no model — and skipping it on a credentialed
   * tier would remove coverage rather than a lie. That coverage is not
   * decorative: DOR-1239 is a real `409 SESSION_LOCKED` race between a widget
   * action and its own seed turn's lock release that a credentialed
   * `widget-round-trip` run is the only thing that can catch, and an earlier
   * version of this fix skipped it downward and would have hidden that race
   * again. A case that genuinely CANNOT run on anything but `test-mode` —
   * because it leans on a mechanism, such as a scenario control, with no
   * real-runtime equivalent at all — opts into the downward skip explicitly
   * via {@link EvalCaseMeta.testModeOnly} instead of relying on `runtimeTier`
   * alone.
   */
  runtimeTier: RuntimeTierSchema,
  /**
   * True when this case structurally CANNOT run on anything but `test-mode` —
   * it drives a mechanism only the deterministic runtime offers, with no
   * real-runtime equivalent at all, rather than merely being free to run
   * there. `rooms-halt-stops-and-says-so` is the one case that needs it today
   * (DOR-1228): it needs a turn that holds still until Stop interrupts it,
   * which only `POST /api/test/scenario`'s `long-turn` control provides
   * deterministically — on a real runtime the same case would either throw its
   * own scenario-guard error or become a timing race, never a verdict.
   *
   * Deliberately NOT inferred from `runtimeTier === 'test-mode'`: most
   * `test-mode` cases (`widget-round-trip`) are runtime-agnostic by
   * construction and are meant to run — and gate — on a credentialed tier too.
   * See `runtimeTier`'s doc for why conflating the two hid a real bug
   * (DOR-1239).
   */
  testModeOnly: z.boolean().optional(),
  /**
   * The agent runtime this case REQUIRES, when it is about one in particular.
   *
   * Absent is the normal state and it means cross-runtime: the case asserts
   * something every runtime owes a person in the chat pane (a turn terminates
   * once, a tool loop opens and closes, an approval is answered), so it runs on
   * whichever runtime `--runtime` booted and means the same thing there. That is
   * the whole point of the `chat` suite.
   *
   * Set it only when the case would be MEANINGLESS elsewhere — pinning an
   * OpenRouter model id, or proving a bad model id fails honestly through
   * OpenCode's sidecar. Such a case is SKIPPED (`skipped-wrong-runtime`) on a run
   * that booted a different runtime, never silently re-pointed: the same
   * enforced-rather-than-described rule {@link EvalCaseMeta}'s `runtimeTier`
   * carries, for the same reason (a case that runs somewhere it cannot mean
   * anything reports a verdict about nothing).
   */
  runtime: EvalRuntimeSchema.optional(),
  /**
   * Model this ONE case runs on, overriding the run's `--model`, as
   * `provider/model`.
   *
   * Exists for the terminal-failure case, which needs a deliberately unreachable
   * model id to prove that a bad model surfaces as a typed `error` before `done`
   * rather than as a hang. A per-run flag cannot express that: the rest of the
   * suite has to keep running on the real pin in the same run, or the evidence
   * that the harness works and the evidence that failure is honest can never be
   * gathered together.
   */
  model: z.string().optional(),
  /** Cost envelope. */
  costClass: CostClassSchema,
  /** Suite membership; `smoke` is the label-gated PR subset. */
  tags: z.array(EvalTagSchema),
  /** When true, the eval runs and reports but never gates (flake/quarantine, W5). */
  quarantined: z.boolean().optional(),
  /** Per-eval cost ceiling in USD; a single turn exceeding this fails the eval. */
  perEvalCeilingUsd: z.number().nonnegative().optional(),
  /**
   * This case prefers the hardened DOCKER isolation tier when one is available
   * (`--isolation auto`, the default). Set it on cases whose turns actually
   * EXECUTE tools and mutate a filesystem — the destructive scenarios and the
   * marketplace install case — so a real agent's file tools are bounded by a
   * container rather than only by a sandbox directory. Purely a preference:
   * without a reachable docker daemon and eval image the case still runs on the
   * child-process tier, with a message (never a hard failure). The tier it
   * actually got is recorded on {@link EvalResultSchema}'s `isolation`.
   *
   * Part of the SERIALIZABLE metadata like every other field: a case manifest
   * that dropped it would silently lose the isolation preference, which is the
   * difference between a destructive turn running in a container and running on
   * the bare host.
   */
  preferDocker: z.boolean().optional(),
});

/** Inferred type for {@link EvalCaseMetaSchema}. */
export type EvalCaseMeta = z.infer<typeof EvalCaseMetaSchema>;

/**
 * A full eval case: the Zod-validated {@link EvalCaseMeta} plus the oracle
 * function(s) that assert the outcome and an optional rubric judge. ALL oracles
 * must pass (and the rubric, when present, must clear its threshold) for the
 * eval to pass.
 */
export interface EvalCase extends EvalCaseMeta {
  /**
   * Optional sandbox seeding, run AFTER the fresh sandbox is created and BEFORE
   * the server boots or any turn is driven. A case that needs pre-existing state
   * on disk — e.g. the design-your-own interview needs a newborn agent scaffold
   * (`.dork/agent.json` + a default `SOUL.md` with intact trait markers) already
   * present in `projectCwd` so the agent has a soul to rewrite — installs it
   * here. The default (undefined) leaves the empty sandbox the runner creates.
   */
  seed?: (sandbox: EvalSandbox) => Promise<void>;
  /**
   * Extra environment for the CREDENTIALED child-process server this case boots
   * (`claude-code-cheap` / `real-provider`). The in-process `test-mode` boot
   * ignores it (it reads no such flags). A case sets this when its product path
   * needs a server-level switch the default boot does not provide — e.g. the
   * approval-expiry governance case sets `DORKOS_APPROVAL_TTL_MS=5000` so the
   * approval window it is about closes inside one turn instead of two hours.
   *
   * NOT a way to switch a product gate off. A case that needs an approval
   * answered answers it, through {@link ApprovalPolicy}, against the same routes
   * the cockpit uses — which is what makes the eval evidence about production
   * code rather than about a branch only the harness takes.
   */
  serverEnv?: Record<string, string>;
  /**
   * How this case answers approval prompts while its turn runs (DOR-498).
   *
   * A case that drives a REAL tool needs one: without it the runtime's
   * permission prompt goes unanswered and the turn dies on the harness timeout
   * instead of producing a result. See {@link ApprovalPolicy}. Omitted ⇒ nothing
   * is answered, which is correct only for a case that drives no tools.
   */
  approvalPolicy?: ApprovalPolicy;
  /**
   * State captured IMMEDIATELY BEFORE the driver records a capability decision,
   * stored on {@link ApprovalDecisionRecord.probe}.
   *
   * The seam that lets a "granted" case assert the action had NOT happened while
   * the approval was still undecided — the difference between proving the gate
   * held and merely noticing the end state. Only called when
   * {@link ApprovalPolicy.capability} is set and a matching approval appears.
   *
   * @param sandbox - The eval sandbox, so the probe can read the host filesystem.
   */
  probeBeforeDecision?: (sandbox: EvalSandbox) => Promise<unknown>;
  /**
   * Drive a ROOM instead of (or as well as) a session — the `rooms` suite's
   * mechanism (DOR-1217).
   *
   * A room case cannot be expressed as a prompt list, and the reason is
   * structural rather than cosmetic: a room drive builds a roster, sets response
   * modes, posts several messages as a person with deliberate timing, and may
   * press Stop halfway through. What it collects is the ROOM's stream, so the
   * frames it hands back are `entry` / `signal` / `reaction` frames rather than
   * session events, and its oracles are the ones in `oracles/rooms.ts`.
   *
   * Runs AFTER the server boots and after any `prompt` turns, and its frames
   * REPLACE the session frames on the oracle context (a room case sets
   * `prompt: ''`, so there are none). The room it built rides
   * {@link OracleContext.room}.
   *
   * **A room turn's cost is invisible to `--budget`.** The cost signal rides the
   * per-SESSION stream (`status_change`), and a room drive collects the room's
   * stream, so a credentialed rooms case reports `unmetered` — see
   * `suite/rooms.ts`. Every such case is bounded by construction instead: a
   * fixed, small number of posts and a cheap model.
   */
  roomScript?: (ctx: RoomScriptContext) => Promise<RoomScriptResult>;
  /** The outcome oracle(s) — ALL must pass. Asserts API/FS/stream state, never prose. */
  oracles: Oracle[];
  /** Optional rubric judge, only where the outcome is inherently a judgment. */
  rubric?: RubricJudge;
  /**
   * Optional widget action driven AFTER the prompt(s) establish the session —
   * the `widget-round-trip` structural eval's mechanism. When set, the runner
   * drives the prompt(s) to create the session, then POSTs this action to
   * `/api/sessions/:id/ui-action` (a fresh turn, runtime-agnostic, so it runs on
   * `test-mode` with no model), collecting the resulting turn. The oracle then
   * asserts the injected `<ui_action>` trigger content on the collected stream.
   */
  widgetAction?: UiActionRequest;
}

/**
 * Terminal status of one eval run:
 * - `pass` — every oracle passed (and the rubric cleared its threshold).
 * - `fail` — an oracle failed, or the rubric fell below threshold.
 * - `error` — a runner/infra error (a `409 SESSION_LOCKED`, a boot timeout, a
 *   thrown exception) distinct from a product regression.
 * - `skipped-over-budget` — the per-run budget cap was hit before this eval ran.
 * - `skipped-wrong-tier` — the case cannot run on the tier the run booted, so
 *   it was never started, in either direction: it DECLARES a credentialed
 *   runtime and the run booted `test-mode` (see {@link EvalCaseMeta}'s
 *   `runtimeTier`), or it is marked {@link EvalCaseMeta.testModeOnly} and the
 *   run booted a credentialed tier (DOR-1228). A case that merely declares
 *   `test-mode` without that flag is NOT skipped downward — see
 *   `runtimeTier`'s doc for why (DOR-1239).
 * - `skipped-wrong-runtime` — the case names a runtime it is ABOUT
 *   ({@link EvalCaseMeta}'s `runtime`) and the run booted a different one, so it
 *   was never started. Distinct from `skipped-wrong-tier` on purpose: "this run
 *   has no model" and "this run has the wrong runtime" send a reader to
 *   different flags.
 */
export const EvalStatusSchema = z.enum([
  'pass',
  'fail',
  'error',
  'skipped-over-budget',
  'skipped-wrong-tier',
  'skipped-wrong-runtime',
]);

/** Inferred type for {@link EvalStatusSchema}. */
export type EvalStatus = z.infer<typeof EvalStatusSchema>;

/** Machine-readable result for one eval, written into `results.json`. */
export const EvalResultSchema = z.object({
  /** The eval's stable id. */
  id: z.string(),
  /** The eval's one-line title. */
  title: z.string(),
  /** Terminal status. */
  status: EvalStatusSchema,
  /** The tier this eval ran on. */
  runtimeTier: RuntimeTierSchema,
  /**
   * The agent runtime this eval's session was bound to, when the run booted one
   * (every tier but `test-mode`). Recorded per case rather than only on the run,
   * for the same reason `model` is recorded at all: a `chat` case that passed on
   * `claude-code` and failed on `opencode` is the interesting result, and a row
   * that cannot name its runtime cannot be re-read later.
   */
  runtime: EvalRuntimeSchema.optional(),
  /**
   * The isolation the eval's server ACTUALLY ran inside (see
   * {@link IsolationRecordSchema}). Omitted only when the eval never launched a
   * server — a `skipped-over-budget` case, or a pre-flight `error`.
   */
  isolation: IsolationRecordSchema.optional(),
  /** The eval's cost class. */
  costClass: CostClassSchema,
  /**
   * Cumulative USD cost the runtime reported for this eval (0 for `test-mode`).
   *
   * Read it together with {@link EvalResultSchema}'s `costUnmetered`: when that
   * is true this number is a FLOOR, not a measurement.
   */
  costUsd: z.number().nonnegative(),
  /**
   * True when this eval drove a real turn but no cost signal ever arrived, so
   * `costUsd` under-reports what was actually spent.
   *
   * The cost the harness can see rides `status_change` frames, and a turn that
   * dies on the timeout guard never emits the frame carrying its total. Two
   * measured runs each burned about 92 seconds and 29 tool calls and were
   * recorded as `$0.0000` — the two most expensive runs of the ten, accounted as
   * free, and invisible to `--budget`. A pathological loop is the exact thing a
   * spend ceiling exists to catch, so the harness now says "unknown" instead of
   * "zero". An under-reported total is worse than an absent one.
   */
  costUnmetered: z.boolean().default(false),
  /** Wall-clock duration in milliseconds. */
  durationMs: z.number().nonnegative(),
  /** Per-oracle results with their evidence. */
  oracleResults: z.array(OracleResultSchema),
  /** The rubric judge's result, when the eval carried a rubric. */
  rubricResult: RubricJudgeResultSchema.optional(),
  /**
   * True when the eval is quarantined: it still runs and reports but never gates
   * (the landing state for flaky evals and the connector evals until W5).
   */
  quarantined: z.boolean().default(false),
  /**
   * True when this result came from a SECOND attempt, because the first one hit
   * the infrastructure signature in `runner/retry.ts` (the turn timed out before
   * any oracle ran).
   *
   * The result is always the second attempt's, whatever it says — including a
   * worse one. A retry buys the case another chance to REACH its oracles; it
   * never launders an oracle's verdict.
   */
  retried: z.boolean().default(false),
  /** Runner/infra error message when `status` is `error`. */
  error: z.string().optional(),
  /** Path to this eval's JSONL transcript, relative to the run directory. */
  transcript: z.string().optional(),
  /**
   * Absolute path of the sandbox `DORK_HOME` retained on disk for debugging
   * (DOR-1241). Set whenever this eval's outcome triggered retention — a
   * non-`pass` result, GATING or QUARANTINED alike — and omitted whenever it
   * did not, including the credential-gate `error` path that never created a
   * sandbox. `pnpm evals:sweep` is the cleanup for anything left here.
   */
  retainedSandbox: z.string().optional(),
  /**
   * Path of this eval's copied `logs/` directory, relative to the run
   * directory (beside `results.json`), when the sandbox had a `logs/` dir to
   * copy. This is the durable copy: it survives a later `pnpm evals:sweep`
   * even though {@link retainedSandbox} does not. Omitted when nothing was
   * retained, or the tier never wrote a server log — the in-process
   * `test-mode` boot never calls `initLogger`.
   */
  retainedLogsPath: z.string().optional(),
  /**
   * The FIRST attempt's retained sandbox `DORK_HOME`, when a retry happened
   * and that first attempt retained one (DOR-1241 review, Important 2). The
   * recorded result is always the retry's SECOND attempt (see `retried`), so
   * without this a double timeout — DOR-1229's hang class, the exact reason
   * retention exists — would retain attempt 1's evidence on disk with nothing
   * in `results.json` pointing at it. Set by `runWithInfrastructureRetry`
   * (`runner/retry.ts`), never by `runEval` directly.
   */
  priorAttemptRetainedSandbox: z.string().optional(),
  /** The first attempt's copied `logs/` directory, alongside {@link priorAttemptRetainedSandbox}. */
  priorAttemptRetainedLogsPath: z.string().optional(),
});

/** Inferred type for {@link EvalResultSchema}. */
export type EvalResult = z.infer<typeof EvalResultSchema>;

/** The top-level machine-readable run report (`results.json`). */
export const RunSummarySchema = z.object({
  /** Unique id for this run (also the transcript directory name). */
  runId: z.string(),
  /** ISO timestamp the run started. */
  startedAt: z.string(),
  /** The tier the run was launched on. */
  tier: RuntimeTierSchema,
  /**
   * The model every credentialed case in this run was answered by — the
   * resolved value, `--model` or the default, never the flag as typed. Omitted
   * on `test-mode`, which reaches no model at all.
   *
   * **Recorded because the tier does not identify it and the evidence tables
   * assume it does** (DOR-1564). `claude-code-cheap` is a cost class, not a
   * model: the same tier answered by `claude-haiku-4-5` and by
   * `claude-sonnet-5` produced opposite verdicts on the same build for
   * `memory-recall-cross-surface`, and every artifact of both runs said only
   * `claude-code-cheap`. A prose-sensitive case whose run cannot name its model
   * cannot be re-read later; a README row claiming one is then resting on
   * somebody's memory.
   */
  model: z.string().optional(),
  /**
   * The agent runtime every case in this run was bound to (`--runtime`, or the
   * tier's default). Omitted on `test-mode`, which boots the deterministic
   * runtime instead.
   */
  runtime: EvalRuntimeSchema.optional(),
  /**
   * The model PROVIDER the run's runtime was pointed at (`openrouter` on the
   * `real-provider` tier). Omitted when the runtime uses its own host auth, which
   * is every claude-code run.
   */
  provider: z.string().optional(),
  /**
   * How this run reached a model (see {@link CredentialSourceSchema}). Omitted
   * on `test-mode`, which needs no credential, and on a credentialed run where
   * none resolved (every case then errors, fail-closed).
   */
  credentialSource: CredentialSourceSchema.optional(),
  /** The per-run budget cap in USD. */
  budgetUsd: z.number().nonnegative(),
  /** Total USD cost accumulated across every eval in the run. */
  totalCostUsd: z.number().nonnegative(),
  /** Per-eval results. */
  results: z.array(EvalResultSchema),
});

/** Inferred type for {@link RunSummarySchema}. */
export type RunSummary = z.infer<typeof RunSummarySchema>;
