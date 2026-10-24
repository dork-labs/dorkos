/**
 * The mode a Claude Code turn really runs at once its per-turn ceiling is
 * applied (spec `trusted-by-default-flip` §4, "power flows downstream, never
 * up").
 *
 * A session's `permissionMode` is the level a person chose for the
 * conversation. A turn another agent's post or a stranger's message started may
 * carry a lower ceiling (`MessageOpts.permissionCeiling`), and that turn runs at
 * the stricter of the two without the session's choice being rewritten. Every
 * reader that decides what a turn may do asks here: the launch (which sets the
 * SDK's mode, and through the warm process's fingerprint moves a live process
 * down and back up), the tool-approval callback, and `session_start`'s ceiling.
 *
 * And what that mode then does with a call the CLI hands the tool gate
 * (`resolveModeDecision`): run it, ask a person, or refuse it unasked.
 *
 * @module services/runtimes/claude-code/turn-permission
 */
import type { TurnPermissionBound, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { ceilingCarriesOutsider, clampModeToCeiling } from '@dorkos/shared/permission-semantics';
import { PermissionModeSchema, type PermissionModeId } from '@dorkos/shared/schemas';
import { CLAUDE_CODE_CAPABILITIES, NEVER_ASK_MODE_ID } from './runtime-constants.js';

/**
 * The mode this turn runs at: the session's own mode (or, for a chat that
 * follows its agent up, the agent's level this turn starts from, DOR-3175),
 * held to the turn's ceiling when it carries one.
 *
 * @param session - The session's chosen mode, this turn's level, and its ceiling.
 */
export function turnPermissionMode<M extends string | undefined>(session: {
  permissionMode: M;
  turnLevelMode?: string;
  turnPermissionCeiling?: TurnPermissionCeiling;
}): M | string {
  const mode: M | string = session.turnLevelMode ?? session.permissionMode;
  const ceiling = session.turnPermissionCeiling;
  if (ceiling === undefined || mode === undefined) return mode;
  return clampClaudeMode(mode, ceiling);
}

/**
 * Set the mode a person chose for the conversation. It replaces the agent's
 * level a running turn started from (DOR-3175): the chat runs at the person's
 * choice from here.
 *
 * @param session - The session.
 * @param mode - The mode the person chose.
 */
export function setChosenMode(
  session: { permissionMode: string; turnLevelMode?: string },
  mode: string
): void {
  session.permissionMode = mode;
  delete session.turnLevelMode;
}

/**
 * One Claude Code mode held to one ceiling, by what each mode declares.
 *
 * "Never ask" (`dontAsk`) needs no rule of its own here: it declares Default's
 * level (`runtime-constants.ts`), so wherever a ceiling admits Default it admits
 * Never ask too, and a stranger's turn keeps an agent set to it there (spec
 * `official-community-space` D10, D11). Under a stricter ceiling, such as another
 * agent's Plan, it is clamped like any other mode. And because Default is
 * declared first, a mode a ceiling refuses is replaced by Default, never by it.
 *
 * @param mode - The mode a person chose for the conversation.
 * @param ceiling - The ceiling the turn or its background work carries.
 */
export function clampClaudeMode(mode: string, ceiling: TurnPermissionCeiling): string {
  return clampModeToCeiling(CLAUDE_CODE_CAPABILITIES.permissionModes, mode, ceiling);
}

/**
 * Whether a mode is one only a person picks, on the trust dial: "Never ask". An
 * agent cannot name it for a chat it starts, and an "Always allow" click does not
 * adopt it (a click that allowed one call is not a choice to refuse the rest).
 *
 * @param mode - A mode id.
 */
export function isPersonOnlyMode(mode: string | undefined): boolean {
  return mode === NEVER_ASK_MODE_ID;
}

/**
 * Whether the tool gate refuses every ask right now (a tool approval, a
 * question, an MCP server's request) rather than putting it to a person: the
 * chat is set to "Never ask", or the turn runs at it.
 *
 * The chosen mode counts on its own because a ceiling stricter than Default
 * (another agent's Plan) clamps the turn to Plan, which asks. Held to Plan, a
 * chat set to never ask still asks nobody: refusing is stricter than asking, so
 * reading both can never let anything more run.
 *
 * @param session - The session's chosen mode and both ceilings.
 */
export function neverAsks(session: CeilingedMode<string | undefined>): boolean {
  return (
    isPersonOnlyMode(session.permissionMode) || gatePermissionMode(session) === NEVER_ASK_MODE_ID
  );
}

/** A session's chosen mode with both ceilings the tool gate reads. */
export interface CeilingedMode<M extends string | undefined> {
  /** The mode a person chose for the conversation. */
  permissionMode: M;
  /** The agent's level this turn starts from instead, when it follows its agent up (DOR-3175). */
  turnLevelMode?: string;
  /** This turn's ceiling, assigned on every send. */
  turnPermissionCeiling?: TurnPermissionCeiling;
  /** The ceiling background work an earlier ceilinged turn left running carries. */
  backgroundPermissionCeiling?: TurnPermissionCeiling;
}

/**
 * The mode the TOOL GATE answers at, read at call time: {@link turnPermissionMode},
 * further held to the ceiling a stranger's (or another agent's) earlier turn left on
 * background work that may still be running in the warm process.
 *
 * Apart from the launch on purpose. The launch sets the mode of the turn about to
 * run; a helper or shell an earlier, ceilinged turn started keeps calling the gate
 * after that turn ended, including while the next turn waits to restart the
 * process, and must not be answered at the next turn's looser level.
 *
 * @param session - The session's chosen mode, this turn's ceiling, and the
 *   ceiling still carried by background work.
 */
export function gatePermissionMode<M extends string | undefined>(
  session: CeilingedMode<M>
): M | string {
  const mode = turnPermissionMode(session);
  const carried = session.backgroundPermissionCeiling;
  if (carried === undefined || mode === undefined) return mode;
  return clampClaudeMode(mode, carried);
}

/**
 * Whether anything the gate answers right now is held to a ceiling: this turn,
 * or background work an earlier ceilinged turn left running.
 *
 * @param session - This turn's ceiling and the one background work carries.
 */
export function heldToACeiling(session: {
  turnPermissionCeiling?: TurnPermissionCeiling;
  backgroundPermissionCeiling?: TurnPermissionCeiling;
}): boolean {
  return (
    session.turnPermissionCeiling !== undefined || session.backgroundPermissionCeiling !== undefined
  );
}

/**
 * Both ceilings at once, as one list ceiling every bound of which holds. Either
 * may be absent; identical bounds are kept once.
 *
 * @param a - One ceiling.
 * @param b - Another.
 */
export function bothCeilings(
  a: TurnPermissionCeiling | undefined,
  b: TurnPermissionCeiling | undefined
): TurnPermissionCeiling | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const list = (c: TurnPermissionCeiling): readonly TurnPermissionBound[] =>
    Array.isArray(c) ? c : [c as TurnPermissionBound];
  // Deduplicated, so a run of ceilinged turns over long-lived work stays one short list.
  const bounds = new Map([...list(a), ...list(b)].map((bound) => [JSON.stringify(bound), bound]));
  return bounds.size === 1 ? [...bounds.values()][0]! : [...bounds.values()];
}

/**
 * What bounds the tool gate right now: `'none'`, `'held'` for a ceiling ({@link heldToACeiling}),
 * or `'stranger'` when this turn's ceiling, or the one background work carries, holds the
 * `runtime-default` bound only a message from off this machine sets (spec
 * `official-community-space` D10). Under a stranger's, the read-only tools the CLI asks about
 * (a file outside the agent's folder, a web page) need a person, as the mode that asks would.
 *
 * @param session - This turn's ceiling and the one background work carries.
 */
export function ceilingOn(session: {
  turnPermissionCeiling?: TurnPermissionCeiling;
  backgroundPermissionCeiling?: TurnPermissionCeiling;
}): 'none' | 'held' | 'stranger' {
  const stranger = (ceiling: TurnPermissionCeiling | undefined) =>
    ceiling !== undefined &&
    (Array.isArray(ceiling) ? ceiling.includes('runtime-default') : ceiling === 'runtime-default');
  if (stranger(session.turnPermissionCeiling) || stranger(session.backgroundPermissionCeiling))
    return 'stranger';
  return heldToACeiling(session) ? 'held' : 'none';
}

/**
 * Whether the gate is held for words DorkOS cannot vouch for (DOR-3204): this turn's ceiling, or
 * the one background work carries, holds the `runtime-default` bound or a level marked as having
 * read an outsider's words. Wider than `ceilingOn(…) === 'stranger'` on purpose: a marked level
 * that reached a ceiling without the bound beside it is still a stranger's turn.
 *
 * @param session - This turn's ceiling and the one background work carries.
 */
export function heldForOutsider(session: {
  turnPermissionCeiling?: TurnPermissionCeiling;
  backgroundPermissionCeiling?: TurnPermissionCeiling;
}): boolean {
  return [session.turnPermissionCeiling, session.backgroundPermissionCeiling].some(
    (ceiling) => ceiling !== undefined && ceilingCarriesOutsider(ceiling)
  );
}

/**
 * What a permission mode says to do with a tool call: run it, ask a person, or
 * refuse it without asking ("Never ask").
 */
export type ModeDecision = 'allow' | 'ask' | 'refuse';

/**
 * Decide what a session's permission mode does with one tool call.
 *
 * This is the gate's closed end: an **exhaustive** switch over
 * `PermissionMode` where every arm names its mode. Adding a member to the
 * union without deciding here is a `tsc` error, not a silent auto-allow — the
 * `never` assignment in the `default` arm enforces that, and it is the whole
 * point of the function.
 *
 * The parameter is nevertheless a `PermissionModeId`: a mode id is
 * whatever its runtime declared, and a session can be sitting in one this
 * runtime has since retired (DOR-885). Such an id is not a member of the union
 * and gets no arm — it asks, for the same reason every unnamed mode does.
 *
 * ## Why every other mode but `bypassPermissions` asks
 *
 * `canUseTool` is not the first gate — it is the last one. The Claude Code CLI
 * runs its own permission engine first and only round-trips to this callback for
 * calls it has **already decided need asking** (`--permission-prompt-tool stdio`;
 * its `createCanUseTool` returns straight away on `allow`/`deny` and sends a
 * `can_use_tool` control request only on `ask`). Verified against the shipped
 * binary at SDK 0.3.177 / CLI 2.1.177:
 *
 * - Under `acceptEdits` the CLI auto-allows a write **inside** the allowed
 *   working directories on its own. An edit that reaches DorkOS is one the CLI
 *   escalated on purpose — `decisionReason: {type:'workingDir', reason:'Path is
 *   outside allowed working directories'}`. Auto-accepting it here would
 *   rubber-stamp exactly that escalation, which is how `~/.ssh/authorized_keys`
 *   or `~/.zshrc` gets written by an agent that was told to stay in a project.
 * - Under `acceptEdits` the CLI also auto-allows a 7-command filesystem
 *   allowlist (`mkdir touch rm rmdir mv cp sed`) and any read-only command.
 *   Every other shell command — `curl … | sh`, `npm install`, `python x.py` —
 *   falls through to `ask` and lands here. Returning `allow` for those is what
 *   let a Slack message run a shell command on the operator's machine (DOR-604).
 *
 * So the honest rule is: if a call got this far, someone should look at it. The
 * shipped description "Auto-accept file edits; still prompt for other tools"
 * stays true end-to-end — the auto-accepting happens one layer up, where it can
 * still tell an in-workspace edit from an escape.
 *
 * The two bullets above are **still dated to SDK 0.3.177 / CLI 2.1.177 and were
 * NOT re-verified** on the 0.3.224 bump — nobody re-read the CLI's permission
 * engine for the `acceptEdits` working-directory escalation or the 7-command
 * allowlist. Note that this function's own conclusion does not rest on them: it
 * asks for everything but `bypassPermissions`, so a CLI that escalated MORE than
 * these bullets describe is still handled correctly. They would only become wrong
 * in the direction that matters if the CLI started escalating LESS.
 *
 * `bypassPermissions` is the sole exception, because it means "skip all tool
 * approval prompts". Note this is a policy choice, not an unreachable branch:
 * the CLI resolves most calls itself under that mode, but it still escalates a
 * few — a dangerous `rm`/`rmdir`, for one — and those do arrive here, where this
 * function allows them. That is the same "the CLI escalated on purpose and we
 * rubber-stamped it" shape fixed above for `acceptEdits`, and it is deliberate
 * only because the mode is named for it. Tracked separately.
 *
 * ## `dontAsk` refuses
 *
 * "Never ask" is the one mode that answers `refuse`: what would ask anywhere
 * else is refused, and nobody is asked. The CLI refuses those calls itself
 * before this callback; `createCanUseTool` refuses the rest.
 *
 * @param mode - The session's permission mode.
 * @returns `'allow'` to run without asking, `'ask'` to raise an approval card,
 *   `'refuse'` to deny without asking.
 */
export function resolveModeDecision(mode: PermissionModeId): ModeDecision {
  const named = PermissionModeSchema.safeParse(mode);
  // An id this runtime does not name has no rule here, and absence of a rule is
  // never consent — the same answer the exhaustive arms below give every mode
  // but `bypassPermissions`.
  if (!named.success) return 'ask';
  const namedMode = named.data;
  switch (namedMode) {
    // "Skip all tool approval prompts" — this mode IS consent. The CLI resolves
    // most calls under it upstream, but not quite all (see the TSDoc above).
    case 'bypassPermissions':
      return 'allow';

    // Every remaining mode asks, each for its own reason:
    //   `default`     — "Prompt on tool use", exactly as shipped.
    //   `acceptEdits` — the CLI already auto-accepted in-workspace writes; what
    //                   reaches here left the working directory.
    //   `auto`        — research-preview classifier; DorkOS still raises a card.
    //   `plan`        — read-only planning; the CLI answers writes with "Cannot
    //                   write to X while in plan mode". Nothing executes here.
    case 'default':
    case 'acceptEdits':
    case 'auto':
    case 'plan':
      return 'ask';

    // "Never ask": refuse what any other mode would ask about. Never `ask`
    // (nobody may be asked) and never `allow` (that would widen it).
    case 'dontAsk':
      return 'refuse';

    default: {
      // Unreachable while the switch is exhaustive; if a new mode is added to
      // `PermissionMode` this line stops compiling. At runtime an unknown mode
      // asks — absence of a rule is never consent.
      const exhaustive: never = namedMode;
      void exhaustive;
      return 'ask';
    }
  }
}
