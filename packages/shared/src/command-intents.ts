/**
 * Canonical DorkOS command intents and their cross-agent aliases.
 *
 * The single, pure, dependency-free source of truth for the three everyday
 * command intents — `compact`, `clear`, `context` — each with the vocabulary
 * different agent runtimes use for the same action (`/compress`, `/summarize`
 * for compact; `/new`, `/new-chat` for clear; `/usage`, `/cost`, `/stats`,
 * `/status` for context). Consumed by the client palette (dedupe, alias hints,
 * honest gating) and the server (compact dispatch + capability gating), so a
 * user's muscle memory keeps working when they switch runtimes (ADR-0273
 * "neutral intent down, per-runtime expansion in the adapter").
 *
 * @module shared/command-intents
 */

/**
 * How long a client waits for the command-intent trigger to answer before it
 * abandons the request (ms).
 *
 * The web transport's `runCommandIntent` is a raw `fetch` that arms
 * `AbortSignal.timeout` with this; the in-process (embedded) transport has no
 * socket to abandon and so is bounded only by the server. It lives here rather
 * than in the client because the server has to know it — see
 * {@link COMMAND_INTENT_QUEUE_WAIT_MS}.
 */
export const COMMAND_INTENT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Slack between the server giving up on a queued intent and the client giving up
 * on the request (ms) — room for the lock probe, the 409, and the wire.
 *
 * **Nothing else may be charged here, and one thing has tried.** The server's
 * pre-flight settles a turn the runtime could not finish before opening the
 * intent's own, and waits for that terminal to reach the projector (DOR-1295,
 * `services/session/settle-open-turn.ts`). That wait is real time inside the
 * request, so it needed a budget — and taking it out of this one would have
 * quietly shortened the margin the DOR-1101 invariant rests on. It is charged
 * against {@link COMMAND_INTENT_QUEUE_WAIT_MS} instead: both are waits on other
 * people's work, they share one clock started at queue reservation, and a run
 * that has already spent the whole of it waits no longer. So this number still
 * means exactly what it says, and a future consumer that cannot be charged to
 * the queue budget has to enlarge it here rather than borrow from it.
 */
const COMMAND_INTENT_RESPONSE_HEADROOM_MS = 5_000;

/**
 * How long a queued command intent may wait for the session's in-flight work
 * before the server stops waiting and answers (ms).
 *
 * **The invariant this exists for (DOR-1101): if the person is shown a failure,
 * the intent must never run afterwards.** Aborting a `fetch` does not cancel the
 * Express handler behind it, so any server-side wait that outlasts
 * {@link COMMAND_INTENT_REQUEST_TIMEOUT_MS} can report failure to the person and
 * then compact the conversation minutes later — a ghost compaction, which reads
 * as data loss. Deriving this by subtraction keeps the two bounds coupled: the
 * server is budgeted to give up first, so the answer the person sees is the
 * real one. The headroom is a budget, not an enforced deadline — the 25s clock
 * starts at queue reservation, so unusually slow pre-reservation work (routing,
 * runtime resolution) eats into it. In the scenario that matters (a turn already
 * running) that preamble is a local read measured in milliseconds.
 *
 * **This is a budget for WAITING, not only for queueing.** The stranded-turn
 * pre-flight (DOR-1295) waits inside the same request and is charged here too,
 * against one clock started at queue reservation — see
 * {@link COMMAND_INTENT_RESPONSE_HEADROOM_MS}. Anything else added to this path
 * that waits on work the request does not own belongs on the same clock.
 *
 * A turn's queue wait is bounded by the lock TTL instead (minutes), because a
 * turn's POST carries no abort signal and so has no client-side deadline to
 * stay under.
 */
export const COMMAND_INTENT_QUEUE_WAIT_MS =
  COMMAND_INTENT_REQUEST_TIMEOUT_MS - COMMAND_INTENT_RESPONSE_HEADROOM_MS;

/** The closed set of canonical DorkOS command-intent ids. */
export type CommandIntentId = 'compact' | 'clear' | 'context';

/** Which layer fulfills an intent: the runtime, or a DorkOS-native client action. */
export type CommandIntentFulfillment = 'runtime' | 'client-native';

/**
 * Intent ids the runtime must fulfill — the subset gated by
 * {@link RuntimeCapabilities.commandIntents}. Currently only `compact`; the
 * client-native intents (`clear`, `context`) are universal and never gated.
 */
export type RuntimeCommandIntentId = Extract<CommandIntentId, 'compact'>;

/** One canonical command intent plus its cross-agent aliases and fulfillment seam. */
export interface CommandIntentDescriptor {
  /** Canonical intent id. */
  id: CommandIntentId;
  /** Canonical DorkOS slash token, e.g. `'/compact'`. */
  canonical: string;
  /** One-line palette description (writing-for-humans; plain, user-facing). */
  description: string;
  /** Argument hint for the palette, if the intent takes arguments. */
  argumentHint?: string;
  /** Cross-agent aliases users may type (muscle memory), each `'/'`-prefixed. */
  aliases: readonly string[];
  /** Whether the runtime or a DorkOS-native client action fulfills this intent. */
  fulfillment: CommandIntentFulfillment;
}

/**
 * The three canonical command intents. Alias vocabulary is drawn verbatim from
 * the verified cross-agent table: `compact` ← `/compress` (Gemini/Cursor),
 * `/summarize` (OpenCode); `clear` ← `/new` (Codex/OpenCode), `/new-chat`
 * (Cursor); `context` ← `/usage`, `/cost`, `/stats` (Claude/Copilot/Gemini),
 * `/status` (Codex). Exactly three entries by operator decision — a fourth is a
 * separate issue.
 */
export const COMMAND_INTENTS: readonly CommandIntentDescriptor[] = [
  {
    id: 'compact',
    canonical: '/compact',
    description: 'Shrink the conversation to free up context',
    aliases: ['/compress', '/summarize'],
    fulfillment: 'runtime',
  },
  {
    id: 'clear',
    canonical: '/clear',
    description: 'Start a fresh session in this project',
    aliases: ['/new', '/new-chat'],
    fulfillment: 'client-native',
  },
  {
    id: 'context',
    canonical: '/context',
    description: 'Show context usage and cost',
    aliases: ['/usage', '/cost', '/stats', '/status'],
    fulfillment: 'client-native',
  },
];

/**
 * Resolve a typed slash token (with or without a leading `'/'`) to its canonical
 * intent, matching the canonical token or any alias case-insensitively. Returns
 * `null` when the token is not a canonical intent (so it falls through to the
 * runtime/composer as today), including near-misses like `'/summarizefoo'`.
 *
 * @param token - The raw token the user typed (trimmed and lowercased here).
 */
export function resolveCommandIntent(token: string): CommandIntentDescriptor | null {
  const trimmed = token.trim().toLowerCase();
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  for (const intent of COMMAND_INTENTS) {
    if (intent.canonical === normalized || intent.aliases.includes(normalized)) {
      return intent;
    }
  }
  return null;
}

/**
 * The set of every canonical + alias token (lowercased, `'/'`-prefixed), for the
 * palette's dedupe pass that folds a runtime's native command into its intent row.
 */
export function commandIntentTokens(): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const intent of COMMAND_INTENTS) {
    tokens.add(intent.canonical);
    for (const alias of intent.aliases) tokens.add(alias);
  }
  return tokens;
}
