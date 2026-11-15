import { renderDocEvents } from '../../canvas/doc-channel/prompt.js';
import { formatAccountsAccess } from '../shared/accounts-access-context.js';
import { formatContextWarning } from '../../session/agent-compaction/context-warning-block.js';
/**
 * Per-turn input shaping for the Codex runtime: the DorkOS permission-mode →
 * ThreadOptions projection (NOTES.md Verdict 2) and the prompt assembly that
 * delivers the neutral additional-context bag (ADR-0273).
 *
 * The app-server thread loader selects an explicit protected permission
 * profile on every load and turn. No SDK exec options are launched here.
 *
 * @module services/runtimes/codex/turn-input
 */
import type { ModelReasoningEffort, SandboxMode } from '@openai/codex-sdk';
import type { DirectoryGrant, MessageOpts } from '@dorkos/shared/agent-runtime';
import { assertValidDirectoryGrants, DirectoryGrantError } from '@dorkos/shared/directory-grants';
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import type { EffortLevel, SessionSettings } from '@dorkos/shared/types';
import { GEN_UI_CONTEXT } from '../shared/gen-ui-context.js';
import { CODEX_DORKOS_TOOL_PREFIX } from '../shared/dorkos-tool-names.js';
import { formatRoomContext } from '../shared/room-context-block.js';
import { renderProseContextBlock, type ProseContextEntry } from '../shared/prose/prose-context.js';
import { recordTurnContext, turnPlaceOf } from '../../session/turn-context/record-turn-context.js';
import type { CodexContextSelection } from './context-gate.js';

/**
 * DorkOS permission mode → Codex sandbox level (NOTES.md Verdict 2).
 * Keyed loosely (`string`) so modes Codex does not support (`plan`,
 * `dontAsk`, `auto`) fall through to the conservative read-only default.
 */
export const MODE_TO_SANDBOX: Record<string, SandboxMode> = {
  default: 'read-only',
  acceptEdits: 'workspace-write',
  bypassPermissions: 'danger-full-access',
};

/**
 * DorkOS effort → Codex reasoning effort. Codex has no `none`/`max`; they
 * clamp to the nearest supported level.
 *
 * **The bottom two rungs mean something different here than they do on
 * claude-code, and that is now visible to people.** `none` clamps UP to
 * `minimal` — Codex always reasons, so the honest floor is its least — while
 * claude-code's `none` turns thinking OFF outright
 * (`claude-code/messaging/thinking-config.ts`). `minimal` lands on Codex's own
 * `minimal`; claude-code has no such rung and maps it to `low`. `max` clamps
 * DOWN to `xhigh`, the top Codex offers, where claude-code has a real `max`.
 *
 * This used to be invisible: effort was set per session, so nobody compared two
 * runtimes' reading of one word. A per-runtime DEFAULT changes that — a person
 * who sets `none` on both runtimes gets no thinking on one and minimal thinking
 * on the other. Keep both mappings documented, and change neither without the
 * other: the divergence is a fact about the two APIs, not a bug to reconcile.
 */
export const EFFORT_TO_REASONING: Record<EffortLevel, ModelReasoningEffort> = {
  none: 'minimal',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
  xhigh: 'xhigh',
};

/**
 * Validate a turn's grants and keep the folders Codex must be told it may
 * write. Throws before anything starts when the grant set is invalid.
 *
 * @param grants - This turn's folder grants; absent means none
 * @param cwd - Working directory the grants are checked against
 * @throws DirectoryGrantError when the grant set is invalid
 */
export function grantedWritableDirectories(
  grants: readonly DirectoryGrant[] | undefined,
  cwd: string | undefined
): string[] {
  if (!grants || grants.length === 0) return [];
  if (cwd === undefined) {
    throw new DirectoryGrantError('Folder grants need the turn’s working directory to check.');
  }
  assertValidDirectoryGrants(grants, cwd);
  return grants.filter((grant) => grant.access === 'write').map((grant) => grant.path);
}

/**
 * Render one neutral context entry into a tagged block — the Codex half of
 * ADR-0273 (the server owns WHAT context exists; the adapter owns HOW it is
 * rendered). Shared prose kinds use the same complete block writer as every
 * other runtime; the remaining kinds use the shared `CONTEXT_TAG` map around
 * their runtime-specific bodies.
 */
function renderContextEntry(entry: AdditionalContextEntry): string {
  switch (entry.kind) {
    case 'doc_events':
      return renderDocEvents(entry.data);
    case 'git_status':
    case 'env':
    case 'relay_context':
    case 'queue_note':
    case 'staged_context':
    case 'seed_context':
    case 'approval_verdict':
    case 'direct_notes':
    case 'turn_cutoff':
    case 'new_since_last_run':
      return renderProseContextBlock(entry);
    case 'accounts_access':
    case 'context_warning':
    case 'room_context':
    case 'ui_state': {
      const tag = CONTEXT_TAG[entry.kind];
      return `<${tag}>\n${renderContextBody(entry)}\n</${tag}>`;
    }
  }
  const exhaustiveEntry: never = entry;
  return exhaustiveEntry;
}

/**
 * Render one runtime-specific context body after shared prose and document
 * events have already been dispatched.
 *
 * `room_context` carries text other people wrote, wrapped in an untrusted-input
 * fence that a JSON dump would not carry. `ui_state` is the sole context kind
 * whose body remains structured JSON.
 */
function renderContextBody(
  entry: Exclude<AdditionalContextEntry, ProseContextEntry | { kind: 'doc_events' }>
): string {
  switch (entry.kind) {
    case 'accounts_access':
      return formatAccountsAccess(entry.data, 'codex');
    case 'context_warning':
      return formatContextWarning(entry.data, 'codex');
    case 'room_context':
      // The prefix Codex qualifies plugin-provided MCP tools with, so the
      // tool-only closing directive can name the posting tool rather than
      // describe it. Never guessed here: it is the shared constant (DOR-1292).
      return formatRoomContext(entry.data, { toolPrefix: CODEX_DORKOS_TOOL_PREFIX });
    case 'ui_state':
      return JSON.stringify(entry.data, null, 2);
  }
}

/**
 * Assemble the prompt for one turn. Codex exec's ONLY input channel is the
 * prompt string (ThreadOptions has no system-prompt field at 0.142.5), so the
 * runtime-neutral DorkOS context, `systemPromptAppend` (e.g. Tasks scheduler
 * context), and the additional-context bag are prepended as a prefix, with the
 * user's `content` last and byte-for-byte unmutated: the EventLog records the
 * pristine `content` via the turn_start userMessage, so injected context never
 * renders as user-authored text.
 *
 * The static `<gen_ui>` teaching block leads every prompt: Codex has no
 * cacheable system-prompt channel, so the generative-UI syntax must be taught
 * inline on each turn (compact by design).
 *
 * `agentContext` carries the blocks every runtime shares: `<agent_identity>`,
 * `<agent_persona>`, `<agent_safety_boundaries>`, `<dorkos_context>`, `<env>`
 * (`runtimes/shared/agent-context.ts`). It precedes the caller's
 * `systemPromptAppend` for the same reason it does in the Claude adapter: who the
 * agent is comes before what this particular turn was scheduled to do.
 *
 * ## The cost this trades, and what carries it now
 *
 * Claude gets that block on `systemPrompt.append`, which is cacheable and sent
 * once; OpenCode gets it on `body.system`, which its sidecar never persists.
 * Codex has neither, so the block rides the PROMPT and lands in the thread's
 * persisted rollout — which means re-sending it every turn leaves one copy per
 * turn IN the conversation. Measured against the real DorkBot workspace that was
 * roughly 2.2 KB (~550 tokens) per turn, schema-capped near 6.6 KB, so a 20-turn
 * thread carried about 11k tokens of byte-identical repetition.
 *
 * **This function is not where that is decided.** It renders whatever
 * `agentContext` it is handed; `context-gate.ts` chooses what to hand it, and
 * DOR-477's whole answer lives there — read it before changing what a turn sends.
 * The `<gen_ui>` block below is the one piece deliberately left ungated: it is
 * compact by design, and it teaches OUTPUT syntax the model needs on every turn,
 * where a gated block that Codex's own compaction summarizes away would take the
 * feature with it.
 *
 * @param content - The user's message, passed through pristine
 * @param opts - Per-turn options carrying systemPromptAppend/additionalContext
 * @param agentContext - The neutral DorkOS context this turn owes, as
 *   `context-gate.ts` selected it, or `''`/omitted when the working directory
 *   hosts no agent manifest
 */
export function buildCodexPrompt(
  content: string,
  opts?: MessageOpts,
  agentContext?: string
): string {
  const blocks: string[] = [GEN_UI_CONTEXT];
  if (agentContext) blocks.push(agentContext);
  if (opts?.systemPromptAppend) blocks.push(opts.systemPromptAppend);
  for (const entry of opts?.additionalContext ?? []) blocks.push(renderContextEntry(entry));
  blocks.push(content);
  return blocks.join('\n\n');
}

/**
 * Build a turn's prompt with {@link buildCodexPrompt} and record it, byte for
 * byte, as what the thread is being handed (the turn-context record). The
 * prompt is Codex's only input channel, so it is the whole record: one part,
 * and a flag saying whether it carried the stable half the gate sends once per
 * thread.
 *
 * @param content - The user's message, passed through pristine
 * @param opts - Per-turn options carrying systemPromptAppend/additionalContext
 * @param agentContext - The neutral DorkOS context the gate selected
 * @param sessionId - The session taking the turn
 * @param settings - The turn's resolved settings, for its permission mode
 * @param selection - The gate's selection, for whether the stable half rode along
 * @returns The prompt to hand the thread
 */
export function codexTurnPrompt(
  content: string,
  opts: MessageOpts | undefined,
  agentContext: string,
  sessionId: string,
  settings: Pick<SessionSettings, 'permissionMode'>,
  selection: Pick<CodexContextSelection, 'carriesStable'>
): string {
  const prompt = buildCodexPrompt(content, opts, agentContext);
  recordTurnContext({
    sessionId,
    ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
    runtime: 'codex',
    place: turnPlaceOf(opts),
    ...(settings.permissionMode !== undefined ? { permissionMode: settings.permissionMode } : {}),
    systemSentThisTurn: selection.carriesStable,
    parts: [{ slot: 'prompt', text: prompt }],
  });
  return prompt;
}

/**
 * The text a steer carries into an open turn (spec `codex-app-server-transport`
 * §11): the context bag rendered out of band exactly as {@link buildCodexPrompt}
 * renders it, and the person's words last and untouched. Nothing the turn
 * already carries (the `<gen_ui>` block, the agent context) is sent again.
 *
 * @param content - The person's message, passed through pristine
 * @param additionalContext - The neutral context bag for this delivery
 */
export function buildSteerText(
  content: string,
  additionalContext?: readonly AdditionalContextEntry[]
): string {
  return [...(additionalContext ?? []).map(renderContextEntry), content].join('\n\n');
}
