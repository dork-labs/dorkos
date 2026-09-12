/**
 * The two facts about a session's CURRENT turn that a `ui` verb cannot work out
 * from a session id (spec `canvas-agent-seat` §5).
 *
 * A `ui` capability handler is handed `context.sessionId` and nothing else, on
 * purpose: that is the one caller fact every surface derives rather than
 * accepting. Two of the verbs need more than an id, and neither thing is
 * discoverable from the database:
 *
 * - **which room this turn is answering in**, if any. `control_ui` writes a
 *   canvas verb to the ROOM's shared table during a room turn and to the
 *   session's own table otherwise, and `get_ui_state` answers about the same
 *   surface. A session is not bound to a room — it answers in one room this turn
 *   and directly the next — so the fact is per TURN.
 * - **what the client last said its window looked like.** Panels, the sidebar
 *   and the active agent are the client's to report; the server only folds this
 *   turn's commands into that snapshot so a same-turn `get_ui_state` reflects a
 *   `control_ui` the agent just issued.
 *
 * ## Why it lives here rather than on a runtime's session object
 *
 * It used to live on claude-code's `AgentSession`, which is exactly why Codex
 * and OpenCode had neither: `control_ui` on Codex was a stub with no session in
 * scope, and `get_ui_state` was not offered at all. Binding the facts in the
 * runtime-neutral trigger path (`trigger-turn.ts`) is what makes one handler
 * serve all three.
 *
 * ## Keyed by session id, and rekeyed with the projector
 *
 * A brand-new claude-code session is triggered under the request UUID and
 * renamed to the canonical SDK id mid-first-turn. The capability context carries
 * the CANONICAL id, so the binding has to move with it — the same hazard the
 * DevTools capture buffer has, solved the same way and on the same line of
 * `rekeyProjector`.
 *
 * @module services/session/browser-seat/ui-turn-facts
 */
import type { UiState } from '@dorkos/shared/types';
import { WORKBENCH } from '../../../config/constants.js';

/**
 * Where a turn is happening when a ROOM triggered it — routing metadata, never
 * prompt context (spec `room-canvas` §5.3).
 *
 * The same shape `MessageOpts.roomTurn` carries, restated here rather than
 * imported from a runtime's types so this module stays runtime-neutral.
 */
export interface UiRoomTurn {
  /** The room this turn is answering in. */
  roomId: string;
  /** The acting member, as the room's author registry knows them. */
  authorId: string;
  /** This dispatch's id, which the room's per-turn canvas ceiling counts. */
  turnId: string;
  /** The directory this turn was placed in, when the room has one. */
  cwd?: string;
  /** Commits ahead of main in that directory, or `null` when git could not say. */
  aheadOfMain?: number | null;
}

/** What the `ui` verbs know about one session's current turn. */
export interface UiTurnFacts {
  /** The client's last reported window state, folded with this turn's commands. */
  uiState?: UiState;
  /** The room this turn is answering in, or absent for a direct turn. */
  roomTurn?: UiRoomTurn;
}

/** What {@link UiTurnFactStore.bindTurn} is told when a turn starts. */
export interface UiTurnBinding {
  /**
   * The client's window snapshot for this turn, when it sent one. Absent leaves
   * the last one in place — a room turn and a scheduled run carry none, and
   * blanking the session's state because nobody re-sent it would make
   * `get_ui_state` forget what it was told one message ago.
   */
  uiState?: UiState;
  /**
   * The room this turn answers in. Read unconditionally, `undefined` included:
   * a marker left over from the last turn would put a person's own
   * `open_canvas` on a channel they are not looking at.
   */
  roomTurn?: UiRoomTurn;
}

/**
 * Per-session turn facts for the `ui` capability domain.
 *
 * One instance, process-wide ({@link uiTurnFacts}), because there is one set of
 * live sessions. Bounded by a session cap rather than left to grow: a long-lived
 * server sees every session id that ever ran, and each entry holds a small
 * snapshot object.
 */
export class UiTurnFactStore {
  private readonly facts = new Map<string, UiTurnFacts>();

  /**
   * Record what this session's turn is doing, at the moment it is dispatched.
   *
   * @param sessionId - The id the turn was dispatched under.
   * @param binding - The room marker (always) and the window snapshot (when the
   *   client sent one).
   */
  bindTurn(sessionId: string, binding: UiTurnBinding): void {
    const entry = this.facts.get(sessionId) ?? this.open(sessionId);
    if (binding.uiState !== undefined) entry.uiState = binding.uiState;
    if (binding.roomTurn !== undefined) entry.roomTurn = binding.roomTurn;
    else delete entry.roomTurn;
  }

  /**
   * The turn is over: forget which room it answered in.
   *
   * The window snapshot stays — it is the client's standing report about a
   * window that is still open — but the room marker is strictly per turn, and a
   * path that starts a turn WITHOUT going through the trigger (a scheduled run,
   * a relay delivery) would otherwise inherit the last room turn's marker and
   * write a person's canvas into a channel.
   *
   * @param sessionId - The id the turn ran under.
   */
  endTurn(sessionId: string): void {
    const entry = this.facts.get(sessionId);
    if (entry) delete entry.roomTurn;
  }

  /**
   * What the `ui` verbs know about this session right now.
   *
   * @param sessionId - The calling session, from the verified context.
   * @returns The facts, or an empty record for a session nothing has bound.
   */
  read(sessionId: string): UiTurnFacts {
    return this.facts.get(sessionId) ?? {};
  }

  /**
   * Replace the window snapshot — the optimistic fold `control_ui` performs so a
   * same-turn `get_ui_state` reflects the command that just ran.
   *
   * @param sessionId - The calling session.
   * @param uiState - The folded snapshot.
   */
  setUiState(sessionId: string, uiState: UiState): void {
    const entry = this.facts.get(sessionId) ?? this.open(sessionId);
    entry.uiState = uiState;
  }

  /**
   * Carry a session's facts across the first-turn canonical rename.
   *
   * @param oldId - The retired id.
   * @param newId - The canonical id.
   */
  rekeySession(oldId: string, newId: string): void {
    const entry = this.facts.get(oldId);
    if (!entry) return;
    this.facts.delete(oldId);
    this.facts.set(newId, entry);
  }

  /**
   * Forget a session entirely, when its projector is disposed.
   *
   * @param sessionId - The session going away.
   */
  dropSession(sessionId: string): void {
    this.facts.delete(sessionId);
  }

  /** Forget everything. Tests only. */
  clear(): void {
    this.facts.clear();
  }

  /** Open an entry, evicting the oldest first when the store is at its cap. */
  private open(sessionId: string): UiTurnFacts {
    if (this.facts.size >= WORKBENCH.DEVTOOLS_MAX_SESSIONS) {
      // Insertion order is the Map's own, and the oldest key is the session
      // whose facts were bound longest ago — the same eviction rule and the same
      // cap the capture buffers use, because they are bounded by the same thing:
      // how many sessions one server has seen.
      const oldest = this.facts.keys().next();
      if (!oldest.done) this.facts.delete(oldest.value);
    }
    const entry: UiTurnFacts = {};
    this.facts.set(sessionId, entry);
    return entry;
  }
}

/** The process-wide turn-fact store the `ui` capability handlers read. */
export const uiTurnFacts = new UiTurnFactStore();
