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
  const name = match[1].toLowerCase();
  const command = NATIVE_COMMANDS.find((c) => c.name === name);
  if (!command) return null;
  return { command, args: (match[2] ?? '').trim() };
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
