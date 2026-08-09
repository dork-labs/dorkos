/**
 * Runtime-neutral additional-context assembler (ADR-0273).
 *
 * Merges {@link ClientContext} signals (ui_state, queued) with SERVER-DERIVED
 * context (git_status) into the canonical per-turn {@link AdditionalContext}
 * bag. Git status is derived HERE — once, server-side — so EVERY runtime gets
 * identical structured data; formatting into a backend-specific block is the
 * adapter's job (`renderContextEntry`), not the assembler's.
 *
 * The assembler is the chokepoint for the `nativeContext` omission rule: a kind
 * a target runtime injects itself is never added to the bag (no double
 * injection). Today no runtime declares any native kind (Claude suppresses its
 * preset git via `excludeDynamicSections`, ADR-0273 A2), but the mechanism is
 * honored uniformly so a future runtime can opt out of a kind.
 *
 * @module services/session/context-assembler
 */
import type {
  AdditionalContext,
  ClientContext,
  ContextKind,
  GitStatusData,
  RoomContextData,
} from '@dorkos/shared/additional-context';
import { getGitStatus } from '../core/git-status.js';

/** Inputs for {@link assembleAdditionalContext}. */
export interface AssembleContextOpts {
  /** Effective working directory for git derivation. */
  cwd: string;
  /** Client-sourced signals (ui_state, queued); absent for non-interactive turns. */
  clientContext?: ClientContext;
  /**
   * Where this turn is happening, when a room triggered it. SERVER-derived and
   * deliberately not part of {@link ClientContext}: that bag is parsed off the
   * wire, and a roster a caller could supply is a roster a caller could forge.
   */
  roomContext?: RoomContextData;
  /**
   * Background the CALLER attached to this turn (`SendMessageRequest.seedContext`)
   * — the agent reads it, the person never sees it.
   *
   * A sibling of `roomContext` rather than part of {@link ClientContext}, and for
   * the opposite reason: that bag holds structured signals the server renders,
   * this holds prose a caller wrote. It is parsed off the wire, so it carries no
   * more authority than `content` does — the rendered block says so out loud
   * (`runtimes/shared/seed-context-block.ts`).
   */
  seedContext?: string;
  /**
   * Kinds the target runtime injects itself (from `getCapabilities().nativeContext`)
   * — omitted from the bag to avoid double-injection.
   */
  nativeContext: ContextKind[];
}

/**
 * Derive structured git status for `cwd`, mapping `getGitStatus`'s
 * response/error union into {@link GitStatusData}. A non-git directory (or any
 * failure) yields `{ isRepo: false }` — git context is advisory, never fatal.
 *
 * @param cwd - Working directory to inspect.
 */
async function deriveGitStatus(cwd: string): Promise<GitStatusData> {
  try {
    const status = await getGitStatus(cwd);
    if ('error' in status) return { isRepo: false };
    return {
      isRepo: true,
      branch: status.branch,
      ahead: status.ahead,
      behind: status.behind,
      detached: status.detached,
      clean: status.clean,
      modified: status.modified,
      staged: status.staged,
      untracked: status.untracked,
      conflicted: status.conflicted,
    };
  } catch {
    return { isRepo: false };
  }
}

/**
 * Merge client signals with server-derived context into the canonical per-turn
 * {@link AdditionalContext} bag. Omits any kind in `nativeContext`.
 *
 * Behavior:
 * - `git_status`: always derived server-side and added, unless native.
 * - `ui_state`: added when `clientContext.uiState` is present, unless native.
 * - `queue_note`: added when `clientContext.queued === true`, unless native.
 * - `env`: NOT emitted — env flows via `systemPrompt.append` (`buildEnvBlock`),
 *   not the bag (ADR-0273 G2). The `env` kind exists in the union for a future
 *   runtime that cannot suppress its preset env block.
 * - `relay_context`: NOT emitted here — relay delivery builds its own block in
 *   `@dorkos/relay`. The kind exists so the assembler can carry it later.
 * - `room_context`: added when the caller supplies one, which only a
 *   room-triggered turn does. It is the fourth kind that actually flows through
 *   this bag, and the first genuine extension of it since ADR-0273 landed.
 * - `seed_context`: added when the caller supplies one — a surface that opened
 *   this conversation already knowing something the person would otherwise have
 *   had to type. The fifth kind that flows.
 *
 * @param opts - Effective cwd, optional client signals, optional room context,
 *   optional caller-supplied seed, and the runtime's native-context omission
 *   list.
 */
export async function assembleAdditionalContext(
  opts: AssembleContextOpts
): Promise<AdditionalContext> {
  const { cwd, clientContext, roomContext, seedContext, nativeContext } = opts;
  const bag: AdditionalContext = [];
  const omits = (kind: ContextKind): boolean => nativeContext.includes(kind);

  if (!omits('git_status')) {
    const data = await deriveGitStatus(cwd);
    bag.push({ kind: 'git_status', scope: 'per-turn', data });
  }

  if (clientContext?.uiState && !omits('ui_state')) {
    bag.push({ kind: 'ui_state', scope: 'per-turn', data: clientContext.uiState });
  }

  if (clientContext?.queued === true && !omits('queue_note')) {
    bag.push({
      kind: 'queue_note',
      scope: 'per-turn',
      data: { composedDuringPrevTurn: true },
    });
  }

  if (roomContext && !omits('room_context')) {
    bag.push({ kind: 'room_context', scope: 'per-turn', data: roomContext });
  }

  if (seedContext && !omits('seed_context')) {
    bag.push({ kind: 'seed_context', scope: 'per-turn', data: { text: seedContext } });
  }

  return bag;
}
