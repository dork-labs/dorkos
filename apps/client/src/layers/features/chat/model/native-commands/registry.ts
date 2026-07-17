/**
 * Client-side ("DorkOS-native") chat commands — slash commands DorkOS executes
 * locally and never sends to the runtime/model (spec web-chat-native-commands,
 * ADR-0300). `/rename` is the first such command.
 *
 * This module is pure (no React hooks): the registry, a parser, and an
 * autocomplete projection. Executor capabilities (rename, toast) are injected at
 * call time via {@link NativeCommandContext} by `useNativeCommands`, so this
 * module stays free of React and transport concerns.
 *
 * @module features/chat/model/native-commands/registry
 */
import type { CommandEntry } from '@dorkos/shared/types';
import { resolveCommandIntent } from '@dorkos/shared/command-intents';

/**
 * Capabilities a native command executor may use, injected by the host hook.
 */
export interface NativeCommandContext {
  /** The active session id, or null when no session is selected. */
  sessionId: string | null;
  /** Rename the current session (reuses the sidebar rename path + a success toast). */
  renameSession: (title: string) => void;
  /** Surface a transient message to the operator (validation hints, errors). */
  notify: (message: string, kind?: 'error' | 'success') => void;
  /**
   * Start a fresh session in the same project and navigate to it, linking back to
   * `fromSessionId` (the `/clear` intent). No message is sent — no model turn.
   */
  startFreshSession: (fromSessionId: string | null) => void;
  /**
   * Reveal (pin open) the runtime-neutral usage & cost surface (the `/context`
   * intent), so a keyboard user sees utilization + cost without hovering.
   */
  focusUsageSurface: () => void;
}

/**
 * A client-side command: discovery metadata plus a local executor. The executor
 * must never send anything to the runtime — that is the point of a native command.
 */
export interface NativeCommand {
  /** Command token without the leading slash, e.g. `"rename"`. */
  name: string;
  /** One-line description shown in the slash autocomplete. */
  description: string;
  /** Argument hint shown in the autocomplete, e.g. `"<new title>"`. */
  argHint?: string;
  /**
   * Execute the command locally.
   *
   * @param args - The trimmed remainder after the command token.
   * @param ctx - Injected capabilities (session id, rename, notify).
   * @returns `true` when the command performed its action; `false` when it was
   *   rejected before acting (e.g. a missing or invalid argument). The send path
   *   keeps the composer text on `false` so the operator can correct it in place.
   */
  run: (args: string, ctx: NativeCommandContext) => boolean;
}

/**
 * Upper bound on a `/rename` title. Session titles render in the sidebar, so a
 * runaway paste is collapsed to a single line (see {@link NATIVE_COMMANDS}) and
 * capped here rather than persisted verbatim.
 */
const MAX_RENAME_TITLE_LENGTH = 200;

/**
 * The native command registry. Adding a client-side command is a single entry.
 *
 * `clear` and `context` are the client-native halves of the DorkOS command
 * intents (DOR-109) — identical on every runtime, never reaching the model. Their
 * cross-agent aliases (`/new`, `/usage`, `/status`, …) route here through
 * {@link parseNativeCommand}. Each command's `name` matches its
 * {@link CommandIntentId}, so the alias resolver maps directly to the executor.
 */
export const NATIVE_COMMANDS: NativeCommand[] = [
  {
    name: 'rename',
    description: 'Rename the current session',
    argHint: '<new title>',
    run: (args, ctx) => {
      // Collapse internal whitespace (Shift+Enter newlines included) to a single
      // line and cap the length — a session title is a one-line sidebar label.
      const title = args.replace(/\s+/g, ' ').trim().slice(0, MAX_RENAME_TITLE_LENGTH).trim();
      if (!title) {
        ctx.notify('Usage: /rename <new title>', 'error');
        return false;
      }
      if (!ctx.sessionId) {
        ctx.notify('No active session to rename', 'error');
        return false;
      }
      ctx.renameSession(title);
      return true;
    },
  },
  {
    name: 'clear',
    description: 'Start a fresh session in this project',
    run: (_args, ctx) => {
      // Open a fresh session in the same project, linked back to the current one.
      // No message is sent — this is a client navigation, not a model turn.
      ctx.startFreshSession(ctx.sessionId);
      return true;
    },
  },
  {
    name: 'context',
    description: 'Show context usage and cost',
    run: (_args, ctx) => {
      // Reveal the shipped DOR-100 usage & cost surface. No message is sent.
      ctx.focusUsageSurface();
      return true;
    },
  },
];

/** Matches a leading `/<token>` and captures the remainder as a single arg string. */
const NATIVE_COMMAND_PATTERN = /^\/(\S+)(?:\s+([\s\S]*))?$/;

/**
 * Parse already-trimmed input into a registered native command + its args.
 *
 * @param content - The trimmed submit content.
 * @returns The matched command and trimmed args, or `null` when the input is not
 *   a registered native command (so unknown `/...` falls through to the runtime).
 */
export function parseNativeCommand(
  content: string
): { command: NativeCommand; args: string } | null {
  const match = NATIVE_COMMAND_PATTERN.exec(content);
  if (!match) return null;
  const token = match[1];
  const args = (match[2] ?? '').trim();

  // Client-native command intents (clear/context) resolve through the shared
  // registry so their cross-agent aliases (/new, /new-chat, /usage, /status, …)
  // reach the local executor — not just the canonical token. The runtime-fulfilled
  // intent (compact) is deliberately NOT matched here: it falls through so the
  // send funnel dispatches it via runCommandIntent (DOR-109).
  const intent = resolveCommandIntent(token);
  if (intent && intent.fulfillment === 'client-native') {
    const intentCommand = NATIVE_COMMANDS.find((c) => c.name === intent.id);
    if (intentCommand) return { command: intentCommand, args };
  }

  const command = NATIVE_COMMANDS.find((c) => c.name === token.toLowerCase());
  if (!command) return null;
  return { command, args };
}

/**
 * The registry projected into {@link CommandEntry} rows so native commands appear
 * in the chat slash autocomplete alongside runtime commands. A module-level
 * constant (the registry is static) so consumers can spread a stable reference
 * into a memo dependency without rebuilding the array each render.
 */
export const NATIVE_COMMAND_ENTRIES: CommandEntry[] = NATIVE_COMMANDS.map((command) => ({
  command: command.name,
  fullCommand: `/${command.name}`,
  description: command.description,
  argumentHint: command.argHint,
}));
