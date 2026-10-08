/**
 * The `<context_warning>` body every runtime renders (DOR-2732).
 *
 * A session whose conversation has filled past the early-warning line gets
 * this note once, on its next turn. It is short on purpose: it rides a turn the
 * agent is already close to its limit on, and its only job is to say how full
 * the conversation is and what the agent can do about it.
 *
 * Shared rather than rendered per adapter for the reason
 * `approval-verdict-block.ts` gives: Codex and OpenCode render a kind they were
 * not taught as raw JSON, and `{"percent":81,"canCompact":true}` tells an agent
 * nothing it can act on. The tool names are qualified per runtime, because a
 * bare name in a prompt block is a name the model cannot call (DOR-1292).
 *
 * @module services/session/agent-compaction/context-warning-block
 */
import type { ContextWarningData } from '@dorkos/shared/additional-context';
import { dorkosToolNameFor } from '../../runtimes/shared/dorkos-tool-names.js';
// Both names come from where each tool is registered, never spelled here: this
// module is read by three runtimes, and a bare name in it would be one none of
// them can call (DOR-1292).
import { MEMORY_WRITE_TOOL_NAME } from '../../memory/memory-capabilities.js';
import { COMPACT_MY_SESSION_TOOL_NAME } from './compaction-capabilities.js';

/**
 * Render the warning for one runtime.
 *
 * Where the runtime cannot summarize on request (Codex on exec, which compacts on its own), the
 * note still says how full the conversation is and still asks the agent to save
 * what matters, but never names a tool that would only refuse.
 *
 * @param data - The percentage at the crossing, and whether this runtime can
 *   summarize on request.
 * @param runtime - The runtime the note is rendered for, so tool names are ones
 *   the model can call.
 */
export function formatContextWarning(
  data: ContextWarningData,
  runtime: 'claude-code' | 'codex' | 'opencode',
  toolName?: (name: string) => string
): string {
  const memory = (toolName ?? ((name) => dorkosToolNameFor(runtime, name)))(MEMORY_WRITE_TOOL_NAME);
  const head = `This conversation is using ${data.percent}% of its context window.`;
  if (!data.canCompact) {
    return (
      `${head} Save open work, session ids and pending decisions with ${memory} now; ` +
      'this runtime summarizes the conversation on its own when it fills up.'
    );
  }
  const compact = (toolName ?? ((name) => dorkosToolNameFor(runtime, name)))(
    COMPACT_MY_SESSION_TOOL_NAME
  );
  return (
    `${head} Consider saving open work, session ids and pending decisions with ${memory}, ` +
    `then calling ${compact} so the conversation is summarized once this turn ends.`
  );
}
