/**
 * Fit a Doe turn into a model's context window (DOR-2839, FB-55), and say so
 * plainly when it cannot fit.
 *
 * Doe is the runtime that runs local models, and the one whose whole request
 * DorkOS builds: the system prompt, the tool list and the conversation. So it is
 * the one runtime that can both trim DorkOS's own share (`../shared/window/context-fit.ts`)
 * and check the result before a model ever sees it.
 *
 * @module services/runtimes/doe/window-fit
 */
import { businessPrompt, estimateInput, type ToolDescriptor } from '@dorkos/doe';
import type { TrimmableBlock } from '../shared/window/context-fit.js';

/** The model's window, as the turn resolved it. */
export interface DoeWindow {
  /** The whole context window, in tokens. */
  readonly contextWindow: number;
  /** Tokens kept free for the reply. */
  readonly maxOutputTokens: number;
}

/**
 * The DorkOS tools that stay loaded on a room turn when the rest load on demand:
 * a room turn answers only by posting or reacting, so these must be callable
 * without a search first.
 */
const ROOM_SPEECH_TOOLS: ReadonlySet<string> = new Set(['post_to_room', 'react_to_room_entry']);

/** Characters the always-loaded DorkOS tools take, serialized as the registry sends them. */
export function hostToolChars(tools: readonly ToolDescriptor[], host: ReadonlySet<string>): number {
  const loaded = tools.filter((tool) => tool.initialLoad && host.has(tool.name));
  if (loaded.length === 0) return 0;
  return JSON.stringify(
    loaded.map(({ name, description, schema }) => ({ name, description, schema }))
  ).length;
}

/**
 * The tools to register once the fit is decided. When the DorkOS tool
 * descriptions were left out, those tools still register, but load on demand
 * through `tool_search`; on a room turn the two room speech tools stay loaded.
 *
 * @param tools - The MCP tools the turn discovered.
 * @param host - Names of the DorkOS host tools among them.
 * @param dropped - What the fit left out.
 * @param roomTurn - Whether this turn answers a room.
 */
export function fitHostTools(
  tools: readonly ToolDescriptor[],
  host: ReadonlySet<string>,
  dropped: readonly TrimmableBlock[],
  roomTurn: boolean
): ToolDescriptor[] {
  if (!dropped.includes('dorkos_tool_schemas')) return [...tools];
  return tools.map((tool) =>
    tool.initialLoad && host.has(tool.name) && !(roomTurn && ROOM_SPEECH_TOOLS.has(tool.name))
      ? { ...tool, initialLoad: false }
      : tool
  );
}

/**
 * Refuse a turn whose first request cannot fit the model, with a sentence that
 * says what to do, before the model is called.
 *
 * Without this the turn reached Doe's compaction, which cannot shorten the
 * instructions and tools, and stopped with "Current instructions, schemas and
 * recent turns exceed the context limit": true, and no help. The estimate is the
 * one compaction uses, so the two agree on what fits.
 *
 * @param input - The loaded resources, the tools the first request will carry,
 *   the person's message and the model's window.
 * @throws Error with a plain explanation when the first request does not fit.
 */
export function assertDoeTurnFits(input: {
  resources: string;
  tools: readonly ToolDescriptor[];
  content: string;
  window: DoeWindow;
}): void {
  const limit = input.window.contextWindow - input.window.maxOutputTokens;
  const needed = estimateInput(businessPrompt(undefined, input.resources), input.tools, [
    { role: 'user', content: input.content, timestamp: 0 },
  ]).tokens;
  if (needed < limit) return;
  const format = (n: number) => n.toLocaleString('en-US');
  throw new Error(
    `This model's context window is too small for this agent: it needs about ${format(needed)} tokens before replying, and the model can take ${format(limit)}. ` +
      'Choose a model with a larger context window, or shorten the AGENTS.md files in this folder.'
  );
}
