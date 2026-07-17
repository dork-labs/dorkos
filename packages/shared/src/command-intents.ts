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
