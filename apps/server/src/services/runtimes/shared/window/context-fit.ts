/**
 * Fit DorkOS's own share of a turn into a model with a small context window
 * (DOR-2839, FB-55).
 *
 * ## The problem this solves
 *
 * DorkOS adds its own instructions and tool descriptions to every turn. On a
 * 128k-token model that is a rounding error; on a 32k local model it was most of
 * the window. Measured on the Doe runtime with a synthetic agent (default SOUL.md
 * and NOPE.md, a 30-line memory file, the DorkOS tools connected), DorkOS's text
 * was 24,560 characters and its always-loaded tool descriptions 22,765 more:
 * about 11.8k tokens of a 28,672-token input limit (Ollama's preset, 32,768 less
 * 4,096 kept for the reply) before the project's own `AGENTS.md` or a single
 * message. A project with a large `AGENTS.md` crossed the limit on turn one, and
 * the chat stopped with an error nobody could act on.
 *
 * ## The rule
 *
 * DorkOS's own share may use at most {@link DORKOS_WINDOW_SHARE} of what the
 * model can read. When it would use more, blocks are left out in
 * {@link CONTEXT_TRIM_ORDER}, least useful first, until it fits or the list
 * runs out. On a model whose window is large nothing is ever left out: the rule
 * is a fraction, not a threshold, so a 128k model's budget (about 30k tokens)
 * is far above everything DorkOS sends.
 *
 * ## What is never left out
 *
 * Anything not in {@link CONTEXT_TRIM_ORDER}: the agent's identity, its safety
 * boundaries (`NOPE.md`), the working rules, the lines naming the agent's Blocked
 * permission areas, the person's profile and the `<env>` block, the caller's own
 * per-run instructions, and everything per-turn (what was said in the room, why
 * a spin-off was started). Those carry what the agent may and may not do, or the
 * thing it was asked to do; a smaller model needs them as much as a large one.
 *
 * Token counts here are estimates at {@link CHARS_PER_TOKEN} characters each,
 * the same heuristic Doe's own compaction uses, so the two agree on what fits.
 *
 * @module services/runtimes/shared/context-fit
 */

/**
 * What may be left out of a turn for a small window, least useful first.
 *
 * 1. `gen_ui`: how to draw widgets. Nice to have; a reply in plain text is fine.
 * 2. `dorkos_areas`: the area-by-area list of what DorkOS can do. The capability
 *    catalog tool answers the same question when asked.
 * 3. `room_tools`: how to speak in a room. Left out only on a turn that is not a
 *    room turn; a room turn always keeps it (the caller marks it as kept).
 * 4. `dorkos_tool_schemas`: the full descriptions of DorkOS's always-loaded
 *    tools. They load on demand through tool search instead. Only a runtime that
 *    controls its own tool list can do this (Doe).
 * 5. `dorkos_context`: what DorkOS is and how to point a person at a chat.
 * 6. `session_model`: that the agent is one session of several.
 * 7. `agent_persona`: the agent's personality (SOUL.md).
 * 8. `agent_memory`: the agent's saved notes. Last, because forgetting is the
 *    most surprising thing a person can see.
 */
export const CONTEXT_TRIM_ORDER = [
  'gen_ui',
  'dorkos_areas',
  'room_tools',
  'dorkos_tool_schemas',
  'dorkos_context',
  'session_model',
  'agent_persona',
  'agent_memory',
] as const;

/** One block {@link CONTEXT_TRIM_ORDER} allows to be left out. */
export type TrimmableBlock = (typeof CONTEXT_TRIM_ORDER)[number];

/** The most of a model's readable window DorkOS's own share may take. */
export const DORKOS_WINDOW_SHARE = 0.25;

/** Characters per token for every estimate here, matching Doe's compaction. */
export const CHARS_PER_TOKEN = 4;

/** Plain-language names for the note an agent gets when something was left out. */
const BLOCK_LABELS: Record<TrimmableBlock, string> = {
  gen_ui: 'the widget guide',
  dorkos_areas: 'the list of DorkOS areas',
  room_tools: 'the room tools guide',
  dorkos_tool_schemas: 'the DorkOS tool descriptions (find them with tool_search)',
  dorkos_context: 'the DorkOS orientation',
  session_model: 'the note about your other sessions',
  agent_persona: 'your persona',
  agent_memory: 'your saved memory',
};

/**
 * Estimate tokens for a number of characters.
 *
 * @param chars - Characters of text or serialized schema.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * The most tokens DorkOS's own share may use on this model.
 *
 * @param contextWindow - The model's whole context window, in tokens.
 * @param outputReserve - Tokens kept free for the reply, when the runtime knows.
 */
export function dorkosContextBudget(contextWindow: number, outputReserve = 0): number {
  return Math.floor(Math.max(0, contextWindow - outputReserve) * DORKOS_WINDOW_SHARE);
}

/** One piece of DorkOS's share: a block that may be left out, or one that never is. */
export interface FitItem {
  /** The block this piece belongs to, or `null` when it is never left out. */
  readonly block: TrimmableBlock | null;
  /** Its size in characters (text, or serialized tool schemas). */
  readonly chars: number;
}

/** What {@link chooseTrims} decided. */
export interface FitDecision {
  /** The blocks to leave out, in {@link CONTEXT_TRIM_ORDER}. */
  readonly dropped: readonly TrimmableBlock[];
  /** Estimated tokens of what is left. */
  readonly tokens: number;
  /** Whether what is left is within the budget. */
  readonly fits: boolean;
}

/**
 * Decide which blocks to leave out so the rest fits `budgetTokens`.
 *
 * Pure. Walks {@link CONTEXT_TRIM_ORDER} and leaves out one whole block at a
 * time, stopping as soon as the rest fits; a block that is not present costs
 * nothing and is not reported as left out.
 *
 * @param items - Every piece of DorkOS's share this turn.
 * @param budgetTokens - From {@link dorkosContextBudget}, or `undefined` when
 *   the window is unknown (nothing is left out).
 */
export function chooseTrims(
  items: readonly FitItem[],
  budgetTokens: number | undefined
): FitDecision {
  let chars = items.reduce((sum, item) => sum + item.chars, 0);
  if (budgetTokens === undefined) return { dropped: [], tokens: estimateTokens(chars), fits: true };
  const dropped: TrimmableBlock[] = [];
  for (const block of CONTEXT_TRIM_ORDER) {
    if (estimateTokens(chars) <= budgetTokens) break;
    const size = items
      .filter((item) => item.block === block)
      .reduce((sum, item) => sum + item.chars, 0);
    if (size === 0) continue;
    dropped.push(block);
    chars -= size;
  }
  const tokens = estimateTokens(chars);
  return { dropped, tokens, fits: tokens <= budgetTokens };
}

/**
 * The one-line note telling the agent what was left out, or `''`.
 *
 * Without it an agent on a small model would not know its tools are one search
 * away, or that it has a memory file it cannot see this turn. Only the line for
 * the tool descriptions names `tool_search`: that block is left out only on Doe,
 * the one runtime that has the tool.
 *
 * @param dropped - What {@link chooseTrims} left out.
 */
export function smallWindowNote(dropped: readonly TrimmableBlock[]): string {
  if (dropped.length === 0) return '';
  const labels = dropped.map((block) => BLOCK_LABELS[block]).join('; ');
  return `<small_window>\nThis model's context window is small, so DorkOS left out: ${labels}.\n</small_window>`;
}

/** One piece of rendered text, tagged with the block it belongs to. */
export interface ContextPart {
  /** The block it belongs to, or `null` when it is never left out. */
  readonly block: TrimmableBlock | null;
  /** The rendered text. */
  readonly text: string;
}

/**
 * Join the parts that were not left out, in order, with a note about what was.
 *
 * The note goes first, so the agent reads what is missing before what is there.
 *
 * @param parts - The rendered pieces, in prompt order.
 * @param dropped - What {@link chooseTrims} left out.
 */
export function joinFitted(
  parts: readonly ContextPart[],
  dropped: readonly TrimmableBlock[]
): string {
  const left = new Set<TrimmableBlock>(dropped);
  return [
    smallWindowNote(dropped),
    ...parts.filter((part) => part.block === null || !left.has(part.block)).map((p) => p.text),
  ]
    .filter(Boolean)
    .join('\n\n');
}
