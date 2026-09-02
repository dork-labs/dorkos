/**
 * Per-turn input shaping for the Codex runtime: the DorkOS permission-mode →
 * ThreadOptions projection (NOTES.md Verdict 2) and the prompt assembly that
 * delivers the neutral additional-context bag (ADR-0273).
 *
 * Both `sandboxMode` and `approvalPolicy` are passed EXPLICITLY on every
 * `startThread`/`resumeThread` (ADR-0309: no implicit defaults post-0.132.0).
 * `approvalPolicy` is always `'never'`: `codex exec` has no approval channel,
 * so `on-request` would only produce auto-cancelled escalation attempts — the
 * sandbox is the enforcement boundary.
 *
 * @module services/runtimes/codex/turn-input
 */
import type { ModelReasoningEffort, SandboxMode, ThreadOptions } from '@openai/codex-sdk';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import type { EffortLevel, SessionSettings } from '@dorkos/shared/types';
import { GEN_UI_CONTEXT } from '../shared/gen-ui-context.js';
import { CODEX_DORKOS_TOOL_PREFIX } from '../shared/dorkos-tool-names.js';
import { formatRoomContext } from '../shared/room-context-block.js';
import { formatSeedContext } from '../shared/seed-context-block.js';
import { formatStagedContext } from '../shared/staged-context-block.js';

/**
 * DorkOS permission mode → Codex sandbox level (NOTES.md Verdict 2).
 * Keyed loosely (`string`) so modes Codex does not support (`plan`,
 * `dontAsk`, `auto`) fall through to the conservative read-only default.
 */
const MODE_TO_SANDBOX: Record<string, SandboxMode> = {
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
const EFFORT_TO_REASONING: Record<EffortLevel, ModelReasoningEffort> = {
  none: 'minimal',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
  xhigh: 'xhigh',
};

/**
 * Project resolved session settings into the explicit ThreadOptions for one
 * turn.
 *
 * `skipGitRepoCheck` is always set: the CLI refuses to run outside a git
 * repository by default, but DorkOS sessions legitimately run in non-repo
 * directories (e.g. `~/.dork/agents/*`), and the read-only default sandbox
 * already provides the conservative posture that check exists for.
 *
 * @param settings - Effective settings (per-send override → tracked → persisted → default)
 * @param cwd - Working directory for the turn, when known
 */
export function projectThreadOptions(settings: SessionSettings, cwd?: string): ThreadOptions {
  return {
    sandboxMode: MODE_TO_SANDBOX[settings.permissionMode ?? 'default'] ?? 'read-only',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    ...(cwd !== undefined ? { workingDirectory: cwd } : {}),
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(settings.effort !== undefined
      ? { modelReasoningEffort: EFFORT_TO_REASONING[settings.effort] }
      : {}),
  };
}

/**
 * Render one neutral context entry into a tagged block — the Codex half of
 * ADR-0273 (the server owns WHAT context exists; the adapter owns HOW it is
 * rendered). The wrapper tag comes from the shared `CONTEXT_TAG` map, and the
 * body is the structured data as JSON: honest, machine-readable, and free of
 * the Claude adapter's heavyweight formatting dependencies.
 *
 * Two kinds are exceptions, and neither is a style preference — see
 * {@link renderContextBody}.
 */
function renderContextEntry(entry: AdditionalContextEntry): string {
  const tag = CONTEXT_TAG[entry.kind];
  return `<${tag}>\n${renderContextBody(entry)}\n</${tag}>`;
}

/**
 * The body of one rendered block: structured data as JSON, except for the two
 * kinds whose body is PROSE and must read identically on every runtime.
 *
 * `room_context` carries text other people wrote, wrapped in an untrusted-input
 * fence that a JSON dump would not carry. `seed_context` carries a paragraph
 * somebody wrote for a model to read, plus the sentence telling the reader the
 * person cannot see the block — JSON would deliver both as one quoted line with
 * `\n` spelled out in it. Both go through the shared writers in
 * `runtimes/shared/`, so a room holding agents on three runtimes, and a seeded
 * turn on any of them, read the same words.
 */
function renderContextBody(entry: AdditionalContextEntry): string {
  switch (entry.kind) {
    case 'room_context':
      // The prefix Codex qualifies plugin-provided MCP tools with, so the
      // tool-only closing directive can name the posting tool rather than
      // describe it. Never guessed here: it is the shared constant (DOR-1292).
      return formatRoomContext(entry.data, { toolPrefix: CODEX_DORKOS_TOOL_PREFIX });
    case 'seed_context':
      return formatSeedContext(entry.data);
    case 'staged_context':
      return formatStagedContext(entry.data);
    default:
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
 * ## The cost this trades, recorded deliberately
 *
 * Claude gets this block on `systemPrompt.append`, which is cacheable and sent
 * once. Codex has no system-prompt channel at all (see above), so the block rides
 * the PROMPT: it lands in the persisted conversation and is re-sent verbatim every
 * turn. Measured against the real DorkBot workspace that is roughly 2.2 KB (~550
 * tokens) duplicated per turn, with a schema ceiling near 6.6 KB, so a 20-turn
 * session carries about 11k tokens of byte-identical repetition. The `<gen_ui>`
 * block above accepts the same deal but is compact by design; this one is not.
 *
 * Shipped as-is because an agent that does not know its own safety boundaries or
 * how to reach its capabilities is the worse failure, and correctness comes before
 * token economy. Compaction is tracked separately. Unlike OpenCode, Codex has no
 * unused system channel to move it to, so the fix here would have to be making the
 * block itself smaller or sending it only on the first turn of a thread.
 *
 * @param content - The user's message, passed through pristine
 * @param opts - Per-turn options carrying systemPromptAppend/additionalContext
 * @param agentContext - The runtime-neutral DorkOS context blocks, or `''`/omitted
 *   when the working directory hosts no agent manifest
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
