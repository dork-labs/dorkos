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
 * rendered). Same honest JSON rendering as the Codex adapter.
 */
function renderContextEntry(entry: AdditionalContextEntry): string {
  const tag = CONTEXT_TAG[entry.kind];
  return `<${tag}>\n${JSON.stringify(entry.data, null, 2)}\n</${tag}>`;
}

/**
 * Assemble the `parts` array for one turn: an optional `synthetic` context
 * part (system-prompt append + the additional-context bag) followed by the
 * user's `content`, byte-for-byte unmutated in its own part — the EventLog
 * records the pristine `content` via the turn_start userMessage, and the
 * synthetic flag keeps the injected block out of rendered history. The static
 * `<gen_ui>` teaching block leads the synthetic part so the generative-UI syntax
 * is taught on every turn (OpenCode has no cacheable system-prompt channel here).
 *
 * @param content - The user's message, passed through pristine
 * @param opts - Per-turn options carrying systemPromptAppend/additionalContext
 */
export function buildOpenCodeParts(content: string, opts?: MessageOpts): OpenCodeTextPartInput[] {
  const blocks: string[] = [GEN_UI_CONTEXT];
  if (opts?.systemPromptAppend) blocks.push(opts.systemPromptAppend);
  for (const entry of opts?.additionalContext ?? []) blocks.push(renderContextEntry(entry));

  const parts: OpenCodeTextPartInput[] = [];
  if (blocks.length > 0) parts.push({ type: 'text', text: blocks.join('\n\n'), synthetic: true });
  parts.push({ type: 'text', text: content });
  return parts;
}
