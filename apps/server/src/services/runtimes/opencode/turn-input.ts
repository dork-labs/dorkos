/**
 * Per-turn input shaping for the OpenCode runtime: the `session.promptAsync`
 * body assembly that delivers the neutral additional-context bag (ADR-0273)
 * and the DorkOS model-string → OpenCode `{providerID, modelID}` projection.
 *
 * Context delivery uses OpenCode's own `synthetic` text-part flag: synthetic
 * user parts are treated as injected (never user-authored) by OpenCode and
 * are suppressed by the session-mapper's history projection — so injected
 * context can never render as user text, on either the live stream or a
 * revisit (the adapter half of ADR-0273).
 *
 * @module services/runtimes/opencode/turn-input
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { GEN_UI_CONTEXT } from '../shared/gen-ui-context.js';
import { OPENCODE_DORKOS_TOOL_PREFIX } from '../shared/dorkos-tool-names.js';
import { formatRoomContext } from '../shared/room-context-block.js';
import { formatSeedContext } from '../shared/seed-context-block.js';
import { formatStagedContext } from '../shared/staged-context-block.js';

/** The `session.promptAsync` text-part input shape (SDK `TextPartInput`). */
export interface OpenCodeTextPartInput {
  type: 'text';
  text: string;
  synthetic?: boolean;
}

/**
 * DorkOS stores one model string per session; OpenCode addresses models as
 * `{providerID, modelID}`. `getSupportedModels()` therefore encodes options
 * as `provider/model` (OpenCode's own CLI convention) and this parses them
 * back. Model ids may themselves contain `/` (e.g. Ollama org/model paths),
 * so only the FIRST separator splits.
 *
 * @param model - Stored model string, e.g. `anthropic/claude-sonnet-4-5`
 * @returns The prompt-body model selector, or undefined for an unparseable value
 */
export function parseModelSelection(
  model: string | undefined
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

/**
 * Render one neutral context entry into a tagged block — the OpenCode half of
 * ADR-0273 (the server owns WHAT context exists; the adapter owns HOW it is
 * rendered). Same honest JSON rendering as the Codex adapter, and the same two
 * exceptions — see {@link renderContextBody}.
 */
function renderContextEntry(entry: AdditionalContextEntry): string {
  const tag = CONTEXT_TAG[entry.kind];
  return `<${tag}>\n${renderContextBody(entry)}\n</${tag}>`;
}

/**
 * The body of one rendered block: structured data as JSON, except for the two
 * kinds whose body is PROSE and must read identically on every runtime.
 *
 * `room_context` carries text other people wrote inside an untrusted-input fence
 * a JSON dump would not carry. `seed_context` carries a paragraph somebody wrote
 * for a model to read, plus the sentence telling the reader the person cannot
 * see the block — JSON would deliver both as one quoted line with `\n` spelled
 * out in it. Both go through the shared writers in `runtimes/shared/`.
 */
function renderContextBody(entry: AdditionalContextEntry): string {
  switch (entry.kind) {
    case 'room_context':
      // OpenCode builds `sanitize(server) + "_" + sanitize(tool)` rather than
      // the `mcp__server__tool` the other two use, so the tool-only closing
      // directive can only name the posting tool if this adapter says how
      // (DOR-1292).
      return formatRoomContext(entry.data, { toolPrefix: OPENCODE_DORKOS_TOOL_PREFIX });
    case 'seed_context':
      return formatSeedContext(entry.data);
    case 'staged_context':
      return formatStagedContext(entry.data);
    default:
      return JSON.stringify(entry.data, null, 2);
  }
}

/**
 * Assemble the `parts` array for one turn: an optional `synthetic` context
 * part (the runtime-neutral DorkOS context + system-prompt append + the
 * additional-context bag) followed by the user's `content`, byte-for-byte
 * unmutated in its own part: the EventLog records the pristine `content` via the
 * turn_start userMessage, and the synthetic flag keeps the injected block out of
 * rendered history. The static `<gen_ui>` teaching block leads the synthetic part
 * so the generative-UI syntax is taught on every turn (OpenCode has no cacheable
 * system-prompt channel here).
 *
 * `agentContext` carries the blocks every runtime shares: `<agent_identity>`,
 * `<agent_persona>`, `<agent_safety_boundaries>`, `<dorkos_context>`, `<env>`
 * (`runtimes/shared/agent-context.ts`). It precedes the caller's
 * `systemPromptAppend` for the same reason it does in the Claude adapter: who the
 * agent is comes before what this particular turn was scheduled to do.
 *
 * ## The cost this trades, and the channel that probably fixes it
 *
 * Claude gets this block on `systemPrompt.append`, which is cacheable and sent
 * once. Here it rides a `parts` entry, so it lands in the persisted conversation
 * and is re-sent verbatim every turn. Measured against the real DorkBot workspace
 * that is roughly 2.2 KB (~550 tokens) duplicated per turn, with a schema ceiling
 * near 6.6 KB. The `<gen_ui>` block above accepts the same deal but is compact by
 * design; this one is not.
 *
 * Unlike Codex, OpenCode HAS an unused channel for exactly this:
 * `SessionPromptData.body.system?: string` (`@opencode-ai/sdk` types.gen.d.ts:2253).
 * Moving the block there is likely both correct and cheaper, but it is a behavior
 * change to how OpenCode persists and replays a session, so it belongs in its own
 * change with its own verification rather than riding along here. Shipped as-is
 * because an agent that does not know its own safety boundaries or how to reach its
 * capabilities is the worse failure.
 *
 * @param content - The user's message, passed through pristine
 * @param opts - Per-turn options carrying systemPromptAppend/additionalContext
 * @param agentContext - The runtime-neutral DorkOS context blocks, or `''`/omitted
 *   when the working directory hosts no agent manifest
 */
export function buildOpenCodeParts(
  content: string,
  opts?: MessageOpts,
  agentContext?: string
): OpenCodeTextPartInput[] {
  const blocks: string[] = [GEN_UI_CONTEXT];
  if (agentContext) blocks.push(agentContext);
  if (opts?.systemPromptAppend) blocks.push(opts.systemPromptAppend);
  for (const entry of opts?.additionalContext ?? []) blocks.push(renderContextEntry(entry));

  const parts: OpenCodeTextPartInput[] = [];
  if (blocks.length > 0) parts.push({ type: 'text', text: blocks.join('\n\n'), synthetic: true });
  parts.push({ type: 'text', text: content });
  return parts;
}
