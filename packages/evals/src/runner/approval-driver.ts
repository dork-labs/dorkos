/**
 * The approval driver: the thing that was missing when an eval drove a real tool
 * (DOR-498).
 *
 * A credentialed turn that asks an agent to DO something stops twice, on two
 * unrelated mechanisms, and before this existed nothing answered either one. The
 * turn sat until the harness's 90-second guard fired, so every tool-executing
 * case reported a runner error instead of a result — and the governance suite
 * could demonstrate only half of what it claims. It could show the gate refusing.
 * It could not show a granted approval letting the action through, which means a
 * gate that refused EVERYTHING would have passed it.
 *
 * ## The two prompts
 *
 * 1. **The runtime's tool permission.** In the default permission mode the
 *    claude-code runtime asks before running any tool outside its read-only /
 *    agent-communication allowlists (`messaging/interactive-handlers.ts`). It
 *    emits an `approval_required` SessionEvent onto the durable stream and waits
 *    ten minutes. Answered at `POST /api/sessions/:id/approve|deny`.
 * 2. **The capability tier gate.** A `destructive` capability returns an
 *    `approval_required` PAYLOAD instead of running, and records a pending
 *    approval a person decides at `POST /api/approvals/:id/grant|deny`. Two-hour
 *    window. This is the governance mechanism itself.
 *
 * They are answered differently on purpose. Prompt 1 rides the SSE stream the
 * drive loop is already collecting, so it is answered REACTIVELY from
 * {@link ApprovalDriver.observe}. Prompt 2 has no stream event of its own that is
 * reliably ahead of the agent's retry, so it is answered by POLLING
 * `GET /api/approvals/pending` — the same endpoint the cockpit's "Waiting On You"
 * card is built from.
 *
 * ## Why this is a legitimate decider, not a bypass
 *
 * `resolveDecisionAuthority` (`services/core/approvals/decision-authority.ts`)
 * refuses a caller that presents an agent identity (`X-DorkOS-Agent`) or an
 * approval token (`X-DorkOS-Approval`), and otherwise needs an authenticated user
 * when local login is on. The driver sends NEITHER header, and an eval sandbox
 * boots with login off, so it lands in the existing `local-trust` posture — the
 * same path the cockpit takes on a single-user machine. Nothing in the server was
 * loosened, branched, or given a test-only escape hatch to make this work; the
 * harness simply became the local operator it always could have been. Do not
 * "fix" a future refusal here by editing the authority check: a driver that had
 * to weaken the gate would be proving nothing.
 *
 * ## Scope is the whole point
 *
 * A driver that said yes to everything pending would be worse than no driver.
 * The "denied" governance case would inherit the "granted" case's yes and still
 * look green, because its own assertion — nothing was deleted — would hold for
 * the wrong reason. So {@link ApprovalPolicy.capability} names ONE capability id
 * and ONE decision, every other pending approval is recorded as `ignored` and
 * left alone, and tool permissions run off an ALLOWLIST with deny as the default.
 *
 * ## WHAT THE ALLOWLIST IS NOT
 *
 * It is not a sandbox. The driver can only answer prompts it is ASKED, and the
 * runtime decides what to ask about: `canUseTool` auto-allows its read-only and
 * agent-communication tool sets outright (`messaging/interactive-handlers.ts`),
 * and the SDK's own permission rules let some calls through without ever
 * reaching DorkOS. Observed on a real run (2026-07-26): `ToolSearch` and
 * `Bash` running a bare `echo` both executed with no prompt at all, while every
 * `Bash` that touched the filesystem was prompted and denied. So the allowlist
 * scopes what the HARNESS consents to, and the container (`preferDocker`) is what
 * actually bounds what a turn can do. Do not read a passing case as evidence that
 * nothing outside `allowTools` ran.
 *
 * ## Nothing here throws
 *
 * Every fault becomes a line in {@link ApprovalDriverLog.errors}. The driver runs
 * inside the SSE data handler and on a timer beside a live turn; an exception
 * escaping either would take down the collection of the very turn it exists to
 * observe, and the eval would report an infra crash instead of the evidence.
 *
 * @module evals/runner/approval-driver
 */
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { toolNameMatches } from '../oracles/stream.js';
import { emptyApprovalLog, type ApprovalDriverLog, type ApprovalPolicy } from '../types.js';

/** How often the driver re-reads `GET /api/approvals/pending` while a turn runs. */
const DEFAULT_POLL_INTERVAL_MS = 300;

/**
 * The subset of a `PendingApproval` the driver reads.
 *
 * A structural shape rather than an import of `@dorkos/shared/approval-schemas`:
 * the driver only needs to route a decision, and a stricter parse here would turn
 * an unrelated field addition into a harness failure during a live turn.
 */
interface PendingApprovalShape {
  approvalId?: unknown;
  capabilityId?: unknown;
  tier?: unknown;
}

/** The durable session-stream member the runtime's tool prompt arrives as. */
type ApprovalRequiredEvent = Extract<SessionEvent, { type: 'approval_required' }>;

/**
 * The two fields the driver reads off that frame, PINNED to the real durable
 * schema (`@dorkos/shared/session-stream`).
 *
 * A bare string literal here would be invisible to the compiler, and this is
 * precisely the class of drift that has already cost this harness a full round of
 * false reds: the oracles once compared `marketplace_uninstall` while the wire
 * carried `mcp__dorkos__marketplace_uninstall`, and every run reported "the agent
 * never called the tool". The prompt's id is `id`, NOT `toolCallId` — the
 * normalizer renames it on the way onto the durable stream — so a driver that
 * guessed would answer nothing and every turn would stall exactly as before.
 * Rename either field upstream and this file stops compiling.
 */
const FRAME_K = {
  id: 'id',
  toolName: 'toolName',
} satisfies Record<string, keyof ApprovalRequiredEvent>;

/** The event type name, pinned the same way. */
const APPROVAL_REQUIRED: ApprovalRequiredEvent['type'] = 'approval_required';

/** A durable `approval_required` frame's payload, as it is probed off `SseFrame.data`. */
interface ApprovalRequiredFrameData {
  type?: string;
  /** The prompt's id — what `POST /approve` addresses it by. */
  id?: unknown;
  toolName?: unknown;
}

/** Options for {@link ApprovalDriver}. */
export interface ApprovalDriverOptions {
  /** Base URL of the running harness server. */
  baseUrl: string;
  /** What this case answers, and what it deliberately does not. */
  policy: ApprovalPolicy;
  /**
   * Captures state immediately BEFORE a capability decision is POSTed, stored on
   * the decision record. This is what lets a "granted" case prove the action had
   * not happened while the approval was still undecided.
   */
  probe?: () => Promise<unknown>;
  /** Poll interval for pending capability approvals. Defaults to 300ms. */
  pollIntervalMs?: number;
}

/**
 * Answers the approval prompts a driven turn parks on, within the scope its
 * policy allows. See the module TSDoc.
 */
export class ApprovalDriver {
  /** Everything answered, ignored, or failed — handed to the oracles. */
  private readonly entries: ApprovalDriverLog = emptyApprovalLog();

  /** Tool-permission prompts already answered, so a re-parsed frame is not re-answered. */
  private readonly answeredToolCalls = new Set<string>();

  /** Capability approvals already seen, decided or deliberately ignored. */
  private readonly seenApprovals = new Set<string>();

  /** In-flight work `stop()` must await, so a decision is never abandoned mid-POST. */
  private readonly inFlight = new Set<Promise<void>>();

  /** The pending-approvals poll timer, while the driver is running. */
  private pollTimer?: ReturnType<typeof setTimeout>;

  /** False once {@link stop} has been called; blocks any further POST. */
  private running = false;

  /**
   * Build a driver over a running harness server.
   *
   * @param options - See {@link ApprovalDriverOptions}.
   */
  constructor(private readonly options: ApprovalDriverOptions) {}

  /** Everything the driver did, for the oracles and the transcript. */
  get log(): ApprovalDriverLog {
    return this.entries;
  }

  /**
   * Begin polling for capability approvals. Idempotent.
   *
   * Tool-permission prompts need no start: they arrive through {@link observe}
   * from the drive loop's own stream.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.options.policy.capability) this.schedulePoll();
  }

  /**
   * Stop polling and wait for every POST already in flight.
   *
   * Awaiting matters: a grant sent in the last moments of a turn must be recorded
   * before the oracles read the log, or a case would fail on evidence the driver
   * was still writing.
   */
  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    // Drain repeatedly: awaiting a POST can enqueue nothing new here, but a poll
    // that was mid-flight when `running` flipped may still add its decision.
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  /**
   * Answer any NEW runtime tool-permission prompt in the collected frames.
   *
   * Called from the drive loop's `onFrames` with the cumulative frame list, so it
   * dedupes on `toolCallId` — the same prompt is re-parsed out of the raw buffer
   * on every chunk that arrives.
   *
   * @param frames - Every frame collected so far.
   * @param sessionId - The session id the frames are arriving on (a mid-turn
   *   remap moves collection, and the approve route is addressed by session).
   */
  observe(frames: SseFrame[], sessionId: string): void {
    if (!this.running) return;
    for (const frame of frames) {
      const data = frame.data as ApprovalRequiredFrameData | undefined;
      if (frame.event !== APPROVAL_REQUIRED && data?.type !== APPROVAL_REQUIRED) continue;
      const rawId = data?.[FRAME_K.id];
      const toolCallId = typeof rawId === 'string' && rawId !== '' ? rawId : undefined;
      if (!toolCallId || this.answeredToolCalls.has(toolCallId)) continue;
      this.answeredToolCalls.add(toolCallId);
      const rawToolName = data?.[FRAME_K.toolName];
      const toolName = typeof rawToolName === 'string' ? rawToolName : '';
      this.track(this.answerToolPermission(sessionId, toolCallId, toolName));
    }
  }

  /**
   * POST the allow/deny for one runtime tool-permission prompt.
   *
   * Deny is the DEFAULT, not a fallback: a governance case has to refuse an agent
   * that gives up on the gated MCP tool and reaches for `Bash` instead, and a
   * prompt left unanswered would stall the turn for ten minutes rather than
   * refusing it in milliseconds.
   */
  private async answerToolPermission(
    sessionId: string,
    toolCallId: string,
    toolName: string
  ): Promise<void> {
    const allowed = this.options.policy.allowTools.some((name) => toolNameMatches(toolName, name));
    const answer = allowed ? 'allow' : 'deny';
    const path = allowed ? 'approve' : 'deny';
    try {
      const res = await fetch(
        `${this.options.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolCallId }),
        }
      );
      this.entries.toolPermissions.push({
        toolCallId,
        toolName,
        answer,
        answeredAt: new Date().toISOString(),
        status: res.status,
      });
      if (!res.ok) {
        this.entries.errors.push(
          `${answer} for tool prompt ${toolCallId} (${toolName || 'unnamed'}) returned ${res.status}`
        );
      }
    } catch (err) {
      this.entries.errors.push(
        `${answer} for tool prompt ${toolCallId} (${toolName || 'unnamed'}) failed: ${message(err)}`
      );
    }
  }

  /** Queue the next pending-approvals poll, unless the driver has stopped. */
  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      this.track(this.pollPendingApprovals().then(() => this.schedulePoll()));
    }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  /**
   * Read the pending approvals once and decide the one this case is about.
   *
   * Everything else is recorded as `ignored` and left pending. That asymmetry is
   * the scoping guarantee: the "denied" case cannot silently inherit a yes, and a
   * capability the case never mentioned cannot be waved through by accident.
   */
  private async pollPendingApprovals(): Promise<void> {
    const target = this.options.policy.capability;
    if (!target || !this.running) return;
    let pending: PendingApprovalShape[];
    try {
      const res = await fetch(`${this.options.baseUrl}/api/approvals/pending`);
      if (!res.ok) {
        this.entries.errors.push(`GET /api/approvals/pending returned ${res.status}`);
        return;
      }
      const body = (await res.json()) as { approvals?: unknown };
      pending = Array.isArray(body.approvals) ? (body.approvals as PendingApprovalShape[]) : [];
    } catch (err) {
      this.entries.errors.push(`GET /api/approvals/pending failed: ${message(err)}`);
      return;
    }

    for (const approval of pending) {
      const approvalId = typeof approval.approvalId === 'string' ? approval.approvalId : undefined;
      const capabilityId =
        typeof approval.capabilityId === 'string' ? approval.capabilityId : undefined;
      if (!approvalId || this.seenApprovals.has(approvalId)) continue;
      this.seenApprovals.add(approvalId);
      if (capabilityId !== target.capabilityId) {
        this.entries.ignored.push({ approvalId, capabilityId: capabilityId ?? '' });
        continue;
      }
      await this.decide(approvalId, capabilityId, String(approval.tier ?? ''), target.decision);
    }
  }

  /**
   * POST one grant or deny, capturing the case's probe first.
   *
   * The probe runs BEFORE the POST and its result is stored on the record, so an
   * oracle can assert what was true at the moment consent was given rather than
   * only what is true once everything has settled.
   *
   * No `X-DorkOS-Agent` and no `X-DorkOS-Approval` header, deliberately — see the
   * module TSDoc on why that is what makes this a legitimate decision rather than
   * a bypass.
   */
  private async decide(
    approvalId: string,
    capabilityId: string,
    tier: string,
    decision: 'grant' | 'deny'
  ): Promise<void> {
    let probe: unknown;
    if (this.options.probe) {
      try {
        probe = await this.options.probe();
      } catch (err) {
        this.entries.errors.push(`probe before deciding ${approvalId} failed: ${message(err)}`);
      }
    }
    try {
      const res = await fetch(
        `${this.options.baseUrl}/api/approvals/${encodeURIComponent(approvalId)}/${decision}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      );
      this.entries.decisions.push({
        approvalId,
        capabilityId,
        tier,
        decision: decision === 'grant' ? 'granted' : 'denied',
        decidedAt: new Date().toISOString(),
        status: res.status,
        ...(probe !== undefined ? { probe } : {}),
      });
      if (!res.ok) {
        this.entries.errors.push(`${decision} of approval ${approvalId} returned ${res.status}`);
      }
    } catch (err) {
      this.entries.errors.push(`${decision} of approval ${approvalId} failed: ${message(err)}`);
    }
  }

  /** Register a promise `stop()` must await, and keep its rejection from escaping. */
  private track(work: Promise<void>): void {
    const tracked = work
      .catch((err: unknown) => {
        this.entries.errors.push(`approval driver task failed: ${message(err)}`);
      })
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);
  }
}

/** One-line description of an unknown thrown value. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
