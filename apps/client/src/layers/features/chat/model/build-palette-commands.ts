/**
 * Projects the shared command-intent registry into the inline slash palette and
 * folds a runtime's native command for the same action into the single intent
 * row (DOR-109). One row per canonical intent (`/compact`, `/clear`, `/context`),
 * each carrying its cross-agent aliases so the shipped ranker and the "matched
 * /{alias}" hint (DOR-119/120) light up for free.
 *
 * Pure and dependency-free (no React) so the merge is unit-testable without a
 * rendered palette.
 *
 * @module features/chat/model/build-palette-commands
 */
import type { CommandEntry } from '@dorkos/shared/types';
import {
  COMMAND_INTENTS,
  commandIntentTokens,
  type RuntimeCommandIntentId,
} from '@dorkos/shared/command-intents';
import type { PaletteCommandEntry } from '@/layers/entities/command';
import { NATIVE_COMMAND_ENTRIES } from './native-commands';

/**
 * Honest capability gate for the runtime-fulfilled intents (currently `compact`).
 * A runtime that declares an intent unsupported renders its row disabled rather
 * than silently failing.
 */
export interface CommandIntentGate {
  /**
   * The active runtime's per-intent support, from
   * `RuntimeCapabilities.commandIntents`. `undefined` while capabilities load —
   * treated as enabled (optimistic; the submit path re-gates on the real caps).
   */
  commandIntents?: Record<RuntimeCommandIntentId, { supported: boolean }>;
  /** Display label of the active runtime for the disabled reason, e.g. `"Codex"`. */
  runtimeLabel: string;
}

/**
 * The composer's gate for the runtime-fulfilled `compact` intent, injected into
 * the send funnel (`useNativeCommands`). Deliberately OPTIMISTIC while
 * capabilities load, exactly like the palette gate in
 * {@link buildPaletteCommands}: it refuses only when the caps map is PRESENT and
 * declares compact unsupported. An undefined caps map (still fetching) must not
 * produce a false "not supported" toast — if the optimistic dispatch turns out
 * wrong, the server's capability gate (422) is the backstop.
 *
 * @param commandIntents - The active runtime's `commandIntents` capability map,
 *   or `undefined` while capabilities load.
 * @param runtimeLabel - The active runtime's display label for the refusal toast.
 */
export function compactComposerGate(
  commandIntents: Record<RuntimeCommandIntentId, { supported: boolean }> | undefined,
  runtimeLabel: string
): { supported: boolean; runtimeLabel: string } {
  return {
    supported: commandIntents?.compact.supported !== false,
    runtimeLabel,
  };
}

/** Lowercase a slash token and ensure a single leading `/`, matching the shared registry tokens. */
function normalizeSlashToken(token: string): string {
  const trimmed = token.trim().toLowerCase();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * The canonical intents projected into palette rows (one per intent, with
 * aliases). A runtime-fulfilled intent the active runtime cannot fulfill is
 * marked disabled with a plain-language reason; client-native intents
 * (clear/context) are universal and never gated.
 */
function buildIntentEntries(gate?: CommandIntentGate): PaletteCommandEntry[] {
  return COMMAND_INTENTS.map((intent) => {
    // Only runtime-fulfilled intents are capability-gated. `supported` is
    // treated as true unless the runtime declares it false, so a loading caps
    // map never falsely disables the row.
    const unsupported =
      intent.fulfillment === 'runtime' &&
      gate?.commandIntents?.[intent.id as RuntimeCommandIntentId]?.supported === false;
    return {
      command: intent.id,
      fullCommand: intent.canonical,
      description: intent.description,
      argumentHint: intent.argumentHint,
      // Spread the readonly registry aliases into a mutable array for CommandEntry.
      aliases: [...intent.aliases],
      ...(unsupported
        ? { disabled: true, disabledReason: `Not supported by ${gate.runtimeLabel}` }
        : {}),
    };
  });
}

/**
 * Merge the intent rows, DorkOS-native commands, and the session's runtime
 * commands into the palette list, deduped so a runtime's native command for an
 * intent folds into that intent's single row.
 *
 * Dedupe rules:
 * - Intent rows come first (the canonical `/compact` `/clear` `/context`).
 * - Native commands that are themselves an intent (`/clear`, `/context`) are
 *   dropped here — their rows come from the intent list; only non-intent natives
 *   (`/rename`) pass through.
 * - A runtime command is dropped when its canonical token OR any of its aliases
 *   collides with an intent token (so Claude's SDK `/usage` folds into the
 *   `context` intent rather than doubling), or when it collides with a native
 *   command already represented.
 *
 * @param runtimeCommands - The active session's runtime slash commands.
 * @param gate - Capability gate for the runtime-fulfilled intents (optional; a
 *   missing gate leaves every intent enabled).
 */
export function buildPaletteCommands(
  runtimeCommands: CommandEntry[],
  gate?: CommandIntentGate
): PaletteCommandEntry[] {
  const intentTokens = commandIntentTokens();
  const intentEntries = buildIntentEntries(gate);

  // Native rows minus any that are themselves an intent (clear/context), so a
  // native and an intent row never both render for the same token.
  const nativeEntries = NATIVE_COMMAND_ENTRIES.filter(
    (entry) => !(entry.command !== undefined && intentTokens.has(`/${entry.command}`))
  );
  const nativeTokens = new Set(NATIVE_COMMAND_ENTRIES.map((entry) => entry.command));

  const runtime = runtimeCommands.filter((cmd) => {
    if (cmd.command !== undefined && nativeTokens.has(cmd.command)) return false;
    const candidateTokens = [cmd.fullCommand, ...(cmd.aliases ?? [])].map(normalizeSlashToken);
    if (cmd.command !== undefined) candidateTokens.push(normalizeSlashToken(cmd.command));
    return !candidateTokens.some((token) => intentTokens.has(token));
  });

  return [...intentEntries, ...nativeEntries, ...runtime];
}
