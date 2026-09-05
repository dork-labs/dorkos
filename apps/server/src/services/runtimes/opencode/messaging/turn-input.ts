/**
 * Per-turn input shaping for the OpenCode runtime: the `session.promptAsync`
 * body assembly that delivers the neutral additional-context bag (ADR-0273)
 * and the DorkOS model-string → OpenCode `{providerID, modelID}` projection.
 *
 * The body is assembled on TWO channels, and which one a block takes is the
 * decision this module encodes. System-shaped content — the `<gen_ui>` teaching
 * block, the runtime-neutral DorkOS context, the caller's `systemPromptAppend` —
 * rides `body.system`, which the sidecar appends to the model's system prompt
 * without persisting it as a message (DOR-477). Per-turn payload — the
 * additional-context bag — rides a `parts` entry, because it belongs to the
 * conversation.
 *
 * That bag uses OpenCode's own `synthetic` text-part flag: synthetic user parts
 * are treated as injected (never user-authored) by OpenCode and are suppressed
 * by the session-mapper's history projection — so injected context can never
 * render as user text, on either the live stream or a revisit (the adapter half
 * of ADR-0273).
 *
 * @module services/runtimes/opencode/turn-input
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { GEN_UI_CONTEXT } from '../../shared/gen-ui-context.js';
import { OPENCODE_DORKOS_TOOL_PREFIX } from '../../shared/dorkos-tool-names.js';
import { formatRoomContext } from '../../shared/room-context-block.js';
import { formatSeedContext } from '../../shared/seed-context-block.js';
import { formatStagedContext } from '../../shared/staged-context-block.js';

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
 * Assemble the `system` string for one turn: everything that is a SYSTEM
 * PROMPT rather than turn payload — the static `<gen_ui>` teaching block, the
 * runtime-neutral DorkOS context, and the caller's `systemPromptAppend`.
 *
 * `agentContext` carries the blocks every runtime shares: `<agent_identity>`,
 * `<agent_persona>`, `<agent_safety_boundaries>`, `<dorkos_context>`, `<env>`
 * (`runtimes/shared/agent-context.ts`). It precedes the caller's
 * `systemPromptAppend` for the same reason it does in the Claude adapter: who the
 * agent is comes before what this particular turn was scheduled to do.
 *
 * ## Why this is the system channel and not a prompt part (DOR-477)
 *
 * This content used to ride the same `synthetic` part as the per-turn context
 * bag. OpenCode persists parts as conversation messages, so every block above
 * landed in the transcript and was re-sent — with every earlier copy of itself —
 * on each later turn of the session.
 *
 * **In BYTES of the assembled prefix, not provider tokens** — measured by running
 * the real builder over the real DorkBot workspace, never by summing file sizes,
 * and never by counting what a provider billed: across a 20-turn session the
 * cumulative injected prefix falls from 2,053,800 B to 195,600 B, about 90%. That
 * ratio does carry over to tokens, and only because what is removed is
 * byte-identical repetition of one string, which tokenizes the same way each
 * time. (DOR-477's ~2.2 KB per-turn figure was a file-size estimate; the real
 * append is larger — see `codex/context-gate.ts` for the block-by-block numbers.)
 *
 * `SessionPromptData.body.system` is the channel that was already there for it.
 * The sidecar stores the string on the user message and reads back only the LAST
 * user message's copy when it assembles the request
 * (`session/llm/request.ts`: `...(input.user.system ? [input.user.system] : [])`),
 * APPENDING it to the agent/provider prompt rather than replacing it, and
 * `toModelMessages` never replays it into history. So one copy reaches the model
 * however long the conversation runs — and because it is re-sent in full every
 * turn, an edited SOUL.md still lands on the very next turn, which a
 * send-once-per-thread scheme could not promise.
 *
 * Codex has no equivalent field and pays for that differently — see
 * `codex/context-gate.ts`.
 *
 * @param opts - Per-turn options carrying `systemPromptAppend`
 * @param agentContext - The runtime-neutral DorkOS context blocks, or `''`/omitted
 *   when the working directory hosts no agent manifest
 * @returns The joined system prompt, or `undefined` when there is nothing to say
 */
export function buildOpenCodeSystem(opts?: MessageOpts, agentContext?: string): string | undefined {
  const blocks = [GEN_UI_CONTEXT, agentContext ?? '', opts?.systemPromptAppend ?? ''].filter(
    Boolean
  );
  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}

/**
 * Assemble the `parts` array for one turn: an optional `synthetic` part carrying
 * this turn's additional-context bag (ADR-0273), followed by the user's
 * `content`, byte-for-byte unmutated in its own part.
 *
 * The EventLog records the pristine `content` via the turn_start userMessage, and
 * the synthetic flag keeps the injected bag out of rendered history.
 *
 * **Only the per-turn bag rides a part.** Everything system-shaped moved to
 * {@link buildOpenCodeSystem} for DOR-477; the bag stays here because it is not
 * a system prompt but the payload of THIS turn — `<room_context>` is what other
 * people said just now, `<seed_context>` is why this turn was started. Putting it
 * on the system channel would erase it from the conversation the moment the next
 * turn replaced the system string, and an agent asked "what did they mean by
 * that?" one turn later would have nothing to read.
 *
 * @param content - The user's message, passed through pristine
 * @param opts - Per-turn options carrying `additionalContext`
 */
export function buildOpenCodeParts(content: string, opts?: MessageOpts): OpenCodeTextPartInput[] {
  const blocks = (opts?.additionalContext ?? []).map(renderContextEntry);

  const parts: OpenCodeTextPartInput[] = [];
  if (blocks.length > 0) parts.push({ type: 'text', text: blocks.join('\n\n'), synthetic: true });
  parts.push({ type: 'text', text: content });
  return parts;
}
