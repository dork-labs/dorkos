/**
 * Ask before an installed package writes shell commands into the files a coding
 * agent runs on your behalf (DOR-522).
 *
 * ## What was wrong
 *
 * A marketplace `plugin` may ship `hooks/hooks.json`. Harness Sync projects those
 * hooks into every enabled harness: they merge into the user-owned
 * `.claude/settings.local.json` and fold into the generated `.codex/hooks.json`,
 * `.cursor/hooks.json` and `.github/hooks/copilot-hooks.json`. A hook is a shell
 * command the harness runs unattended, so installing a package was enough to make
 * a stranger's `curl … | sh` run on the next tool call — and installing asks
 * nobody: `marketplace.install` is tier `act`, which passes for every caller.
 *
 * ## Where the gate sits, and why here
 *
 * Not on the install. Promoting `marketplace.install` to `destructive` would put
 * an approval card in front of every ordinary install, which is the routine-card
 * harm this repo has refused twice (DOR-504, DOR-506) and which
 * `routes/__tests__/marketplace.test.ts` pins outright. The gate is on the
 * CONTENT: a package that declares no hooks is never asked about, and one that
 * does is asked once, naming the exact commands.
 *
 * Not inside `@dorkos/harness` either. That package is a pure projection engine
 * with no approval primitive and no config store, and dragging both into it for
 * one call site would be an architectural regression. It exposes a per-package
 * predicate (`project(root, { allowPluginHooks })`) and the list of commands each
 * package wants to install (`projectedHookCommands`); this module decides.
 *
 * The predicate is applied at PLAN time rather than at apply time because a
 * package's hooks reach every harness, not only the Claude Code settings merge.
 * Filtering the merge alone would have left the same commands landing in
 * `.codex/hooks.json`, which the reproduction confirmed.
 *
 * ## What a person is agreeing to
 *
 * One package's exact hooks, in one project: each command, the event that fires
 * it, and the matcher that narrows it. Both the yes and the no are recorded in
 * `hook-consent.ts`, which owns the stored form and states what the digest binds
 * and what it cannot.
 *
 * ## Every way in is gated now
 *
 * `dorkos harness sync --fix` used to pass no predicate and consult no record,
 * so it installed every hook on disk including a package's somebody had refused
 * — a refusal lived in this process's memory and the CLI had nothing to read. It
 * now goes through the same seam every other trigger uses
 * (`project-with-consent.ts`) and reads the same two lists: an unapproved
 * package's hooks are WITHHELD, printed command by command with the exact
 * re-run, and installed only by `--allow-hooks <package>`, which records the
 * same entry this card writes (DOR-1849, contract D5).
 *
 * ## The two ways in still disagree, and this does not change that
 *
 * The MCP install path already raises a card for the install itself
 * (`marketplace-mcp/confirmation-provider.ts`); the HTTP route does not. This gate
 * sits AFTER both, on the projection, so it fires the same way whichever surface
 * installed the package. Converging the two install surfaces is a separate change.
 *
 * @module services/harness/hook-approval
 */
import { resolve } from 'node:path';
import type { ProjectedHook } from '@dorkos/harness';
import type {
  ApprovalBinding,
  ApprovalConsumeResult,
  ApprovalRequestInput,
  ApprovalTicket,
} from '../core/approvals/approval-service.js';
import {
  hashApprovalInput,
  quoteSummaryValue,
  redactSecretsInText,
} from '../core/approvals/index.js';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import {
  hookApprovalEntry,
  isHookProjectionRefused,
  recordHookRefusal,
  type HookProjectionRequest,
} from './hook-consent.js';
import { logger } from '../../lib/logger.js';

/**
 * What an approval card calls this, and how loudly.
 *
 * A third id space alongside registry capabilities and hand-registered MCP tools
 * (the two `routes/approvals.ts` already resolves titles from), because this is
 * not something an agent can invoke: nothing accepts `harness.project_hooks` as a
 * call. It exists so the card, the stored row, and the audit trail name the action
 * rather than an empty string. `index.ts` teaches `ApprovalService` this one
 * descriptor; without it the card would fall back to showing the raw id.
 */
export const HOOK_PROJECTION_CAPABILITY_ID = 'harness.project_hooks';

/** The card's title. Plain enough to decide from without reading the summary twice. */
export const HOOK_PROJECTION_CAPABILITY_TITLE =
  'Let an installed package run commands automatically';

/**
 * Describe {@link HOOK_PROJECTION_CAPABILITY_ID} for an approval card.
 *
 * `destructive` because that is what the tier means to a person reading the card:
 * this one needs a decision, and a `curl … | sh` that runs on every tool call is
 * not a routine action.
 *
 * @param capabilityId - The id `ApprovalService` is resolving.
 * @returns The descriptor, or `undefined` for any other id (so the caller falls
 *   through to the capability registry).
 */
export function describeHookProjectionCapability(
  capabilityId: string
): { title: string; tier: CapabilityTier } | undefined {
  if (capabilityId !== HOOK_PROJECTION_CAPABILITY_ID) return undefined;
  return { title: HOOK_PROJECTION_CAPABILITY_TITLE, tier: 'destructive' };
}

/**
 * The slice of `ApprovalService` this gate uses.
 *
 * Narrow on purpose: the gate asks and waits, it never decides. Taking the
 * interface rather than the class also lets the reproduction test drive the whole
 * projection without a database.
 */
export interface HookApprovalGateway {
  /** Record a pending approval and return the one-time token to retry with. */
  request(input: ApprovalRequestInput): ApprovalTicket;
  /** Present the token for the action it was granted for. */
  consume(token: string, binding: ApprovalBinding): ApprovalConsumeResult;
}

/**
 * The canonical form of a request, for the approval BINDING.
 *
 * `path.resolve` is the whole of it, and it is not cosmetic: `/x/proj` and
 * `/x/proj/` are one directory, and the app is not the only caller. The stored
 * entry canonicalizes the same way (`hook-consent.ts`), so the token a card is
 * granted for and the record it writes describe one thing.
 */
function canonical(request: HookProjectionRequest): {
  projectPath: string;
  packageName: string;
  hooks: ProjectedHook[];
} {
  return {
    projectPath: resolve(request.projectPath),
    packageName: request.packageName,
    hooks: request.hooks,
  };
}

/**
 * How much of one command the card shows.
 *
 * Deliberately larger than {@link quoteSummaryValue}'s 80, which exists so a
 * padded ARGUMENT cannot crowd out the argument that decides how destructive an
 * action is. Here the shell command IS the decision, and 80 characters is enough
 * to hide the interesting half of `node ./hooks/setup.mjs && curl … | sh`.
 * Recognition is not the bar when what is being recognized is a command line.
 *
 * The residual, stated: `APPROVAL_SUMMARY_MAX_LENGTH` still caps the whole
 * sentence at 500, so a package declaring many long hooks is shown truncated
 * (visibly, with an ellipsis). The count in the sentence always names how many
 * there are, so a truncated card under-shows rather than under-reports.
 */
const COMMAND_DISPLAY_MAX_LENGTH = 200;

/**
 * Render one command for the card: swept for secrets, shortened, then quoted and
 * escaped.
 *
 * The order matters and is the same one {@link quoteSummaryValue} documents:
 * shortening first can slice a token below the length its pattern matches, so
 * redaction has to run on the full string. `JSON.stringify` last both quotes the
 * value and flattens newlines, so a command cannot fake a second line of card.
 */
function renderCommandForCard(command: string): string {
  const safe = redactSecretsInText(command);
  const shortened =
    safe.length <= COMMAND_DISPLAY_MAX_LENGTH
      ? safe
      : `${safe.slice(0, COMMAND_DISPLAY_MAX_LENGTH - 1).trimEnd()}…`;
  return JSON.stringify(shortened);
}

/**
 * Say when a hook fires, in words rather than in event names.
 *
 * "Before every tool call" and "when a session ends" are materially different
 * permissions, and an event name like `PreToolUse` means nothing to a person who
 * has never read the harness docs. Unknown events fall back to their own name
 * rather than being dropped: an event DorkOS does not have a phrase for still has
 * to appear on the card.
 */
function describeHookTrigger(hook: ProjectedHook): string {
  const scope = hook.matcher && hook.matcher !== '*' ? ` matching ${hook.matcher}` : '';
  switch (hook.event) {
    case 'PreToolUse':
      return `before every tool call${scope}`;
    case 'PostToolUse':
      return `after every tool call${scope}`;
    case 'UserPromptSubmit':
      return 'every time you send a message';
    case 'SessionStart':
      return 'when a session starts';
    case 'SessionEnd':
      return 'when a session ends';
    case 'Stop':
      return 'when a turn finishes';
    case 'SubagentStop':
      return 'when a subagent finishes';
    case 'Notification':
      return 'on every notification';
    case 'PreCompact':
      return 'before the conversation is compacted';
    default:
      return `on ${hook.event}${scope}`;
  }
}

/**
 * The sentence on the card.
 *
 * Leads with what will run and WHEN, because both are the decision — the same
 * command on `Stop` and on `PreToolUse` are not the same permission, and a card
 * that showed only the command would let the second inherit consent given for the
 * first. Every value is quoted, escaped and capped, so a command carrying its own
 * quotes and connectives cannot forge the rest of the sentence.
 *
 * @param request - The package, project, and hooks being asked about.
 * @returns One plain sentence.
 */
export function summariseHookProjection(request: HookProjectionRequest): string {
  const name = quoteSummaryValue(request.packageName);
  const where = quoteSummaryValue(request.projectPath);
  const hooks = request.hooks
    .map((hook) => `${renderCommandForCard(hook.command)} ${describeHookTrigger(hook)}`)
    .join('; ');
  const count = request.hooks.length;
  return (
    `Let the installed package ${name} run ${count} command${count === 1 ? '' : 's'} ` +
    `automatically in ${where}: ${hooks}`
  );
}

/**
 * Entries with a card open right now, so a concurrent projection does not raise
 * a second for the same package.
 *
 * This is all that is left of the process-scoped memory. A refusal used to live
 * here too, because a durable "no" would have been a decision with no way back:
 * nothing listed the stored decisions and nothing revoked one, so a misclick
 * would have disabled a package's hooks for ever, recoverable only by
 * hand-editing `~/.dork/config.json`. `dorkos harness hooks --list` and
 * `--revoke <package>` are that way back, so the refusal now goes in the file
 * (`hook-consent.ts`) where every trigger can read it — including the CLI, which
 * could not see this set at all and installed refused hooks because of it.
 *
 * An EXPIRED card is still deliberately not remembered anywhere: nobody decided,
 * so nobody said no, and the person who missed it should be asked again. This
 * set is what keeps that from stacking two open cards for one package meanwhile.
 */
const askingNow = new Set<string>();

/**
 * Whether this projection may be put in front of a person, or has already been
 * answered "no" (or is on screen right now).
 *
 * @param request - The projection about to be asked about.
 * @returns True when a card would be new information.
 */
export function mayAskAboutHooks(request: HookProjectionRequest): boolean {
  return !askingNow.has(hookApprovalEntry(request)) && !isHookProjectionRefused(request);
}

/** Seams the wait loop uses, injectable so tests do not sleep in real time. */
export const _internal = {
  /** Pause between presentations of a pending token. */
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      // Unref'd: a pending approval must never be the reason a CLI-embedded
      // server refuses to exit.
      setTimeout(resolve, ms).unref?.();
    }),
  /** How long to wait between presentations. */
  pollIntervalMs: 5_000,
  /** Drop the open-card memory, so one test cannot answer for the next. */
  forgetDecisions: (): void => {
    askingNow.clear();
  },
};

/**
 * Ask a person whether this package may install these commands, and wait for the
 * answer.
 *
 * The token is presented on a slow loop rather than awaited on an event, because
 * `ApprovalService` is a token-and-retry primitive with no server-side
 * subscription: `consume` reports `pending` without spending, and reports
 * `expired` on its own once the decision window closes, so the loop always ends.
 * It runs inside auto-projection, which is already fire-and-forget from the
 * install route, so nothing is blocked while it waits.
 *
 * Fails CLOSED on every path that is not an explicit yes: denied, expired,
 * mismatched, or nobody deciding before the window shuts. A store that throws
 * propagates, and the caller's own catch withholds the hooks the same way.
 *
 * @param gateway - The approval primitive.
 * @param request - The package, project, and hooks to ask about.
 * @returns True only when a person granted it.
 */
export async function askForHookProjection(
  gateway: HookApprovalGateway,
  request: HookProjectionRequest
): Promise<boolean> {
  const { projectPath, packageName, hooks } = canonical(request);
  const binding: ApprovalBinding = {
    capabilityId: HOOK_PROJECTION_CAPABILITY_ID,
    // Bound to the same facts the stored entry digests, so a token granted for one
    // package's hooks can never be spent on another's — or on the same commands
    // moved to a different event.
    inputHash: hashApprovalInput({
      projectPath,
      packageName,
      hooks: hooks.map((hook) => [hook.event, hook.matcher ?? null, hook.command]),
    }),
  };

  const entry = hookApprovalEntry(request);
  askingNow.add(entry);
  const ticket = gateway.request({
    ...binding,
    summary: summariseHookProjection(request),
  });
  logger.info('[HarnessSync] Waiting on a person to allow a package to install hooks', {
    packageName: request.packageName,
    projectPath: request.projectPath,
    approvalId: ticket.approvalId,
    hooks: request.hooks.length,
  });

  const deadline = new Date(ticket.expiresAt).getTime();
  try {
    for (;;) {
      const result = gateway.consume(ticket.token, binding);
      if (result.outcome === 'granted') return true;
      if (result.outcome !== 'pending') {
        // Only an explicit no is recorded. Expiry means nobody decided, and
        // the person who missed the card is asked again.
        if (result.outcome === 'denied') recordHookRefusal(request);
        logger.info('[HarnessSync] Package hooks were not allowed', {
          packageName: request.packageName,
          projectPath: request.projectPath,
          outcome: result.outcome,
        });
        return false;
      }
      // A finite deadline as well as the primitive's own expiry check: a clock the
      // store disagrees with must not turn this into a loop that never ends.
      if (Number.isFinite(deadline) && Date.now() > deadline) return false;
      await _internal.sleep(_internal.pollIntervalMs);
    }
  } finally {
    // Whatever happened, including a throw out of the store, this card is no
    // longer on screen.
    askingNow.delete(entry);
  }
}
