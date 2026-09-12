/**
 * What DorkOS tells Claude Code's auto-mode permission classifier about its own
 * tools (spec `auto-mode-classifier-context`).
 *
 * ## The problem, in one paragraph
 *
 * Auto mode is the setting where the agent gets on with its work and stops only
 * for the things that deserve a stop. A classifier inside the runtime decides
 * which calls those are. It knows the model's own tools; it knows nothing about
 * DorkOS. So when an agent calls a DorkOS tool it sees an unfamiliar name with
 * some arguments and has to guess — and it guesses "ask", for calls DorkOS has
 * already run its own permission check on (`core/mcp-tool-gate.ts`). The person
 * gets stopped twice for one decision, and every stop that did not need to
 * happen makes the next real one easier to click through.
 *
 * SDK 0.3.236 added the field this module fills:
 * `PostToolUse` → `hookSpecificOutput.classifierContext`, a short note the host
 * writes and the classifier reads beside the call's result.
 *
 * ## The rule this module is built to obey
 *
 * **DorkOS may assert only facts it established itself, and an assertion widens
 * nothing unless the classifier decides it does.** The note is not a grant. It
 * cannot allow anything. That is exactly why it is the right shape where an
 * auto-approval list was the wrong one: ADR `260726-171347` (DOR-519) is the
 * record of what happened the last time this codebase handed the runtime a list
 * of tool names, and the standing rule since then is that a name list is never
 * how DorkOS makes the runtime more permissive.
 *
 * Three structural consequences, each of them load-bearing:
 *
 * 1. **A note is one constant string from {@link CLASSIFIER_SENTENCES}, chosen by
 *    tool name.** {@link classifierContextFor} is not even GIVEN the arguments,
 *    so no tool name, argument, output or conversation text can be interpolated
 *    into one — not by this code and not by an edit to it later.
 *    `__tests__/classifier-context.test.ts` pins the complete set of sentences
 *    and asserts every TIERED DorkOS tool produces one of them, byte for byte.
 * 2. **The facts come from the gate's own table**, not a hand-kept list.
 *    {@link MCP_TOOL_TIERS} decides which tools can be described and what tier
 *    each carries, so a tool cannot be described here without being gated there,
 *    and a retiered tool changes its sentence with no edit.
 *
 *    That table is also the LIMIT of what gets a note, which is easy to read past.
 *    It holds the 47 hand-registered in-session tools (pinned by
 *    `core/__tests__/mcp-tool-gate.test.ts`). The in-session `dorkos` server ALSO
 *    carries the Capability Registry's own projected tools — `config_get`,
 *    `memory_write`, `list_capabilities`, `activity_list`, the `marketplace_*`
 *    set, the room verbs — which are gated inside `registry.invoke` instead and
 *    are not in this table. They share the `mcp__dorkos__` prefix and reach this
 *    hook, and they get NOTHING: no tier entry, no note, and auto mode keeps
 *    guessing about them exactly as before. Describing them would mean asserting
 *    a tier from a second source, which is the drift this module is built to
 *    avoid — so the honest coverage is "tools with a declared tier", not "DorkOS
 *    tools".
 * 3. **The operator's power level is never named.** What permission mode a
 *    session runs in, and how much the operator trusts this agent, are DorkOS's
 *    business. The classifier is told what the tool is, not who is running it.
 *
 * ## What is deliberately NOT asserted: that a person approved this call
 *
 * The tier gate records nothing when it ALLOWS a call, including a `destructive`
 * one a person approved (see the "What is audited, and what is not" section of
 * `core/mcp-tool-gate.ts`). A first cut added a small side record keyed by tool
 * name and a hash of the arguments to close that. Review killed it, correctly:
 * with no session in the key, one session's genuine approval could be spent on
 * a DIFFERENT session's identical unapproved call, and a Codex or OpenCode
 * approval — same gate, no hook — would leave a record that any matching
 * claude-code call could claim. A false "a person approved this" in front of a
 * permission classifier is the one failure this feature must not have, so the
 * fact is not asserted at all.
 *
 * Both ids exist for a safe version (the gate holds
 * `ApprovalRequestingSession.sessionId`, the hook holds its launch's own), so
 * this is a deferral rather than a dead end. It is written up under "Out of
 * scope" in `specs/auto-mode-classifier-context/01-ideation.md`.
 *
 * ## Only Claude Code, and only in-session
 *
 * Codex and OpenCode have no equivalent hook, so their sessions get nothing —
 * documented in the runtimes table rather than papered over. The sessionless
 * external `/mcp` server has no session to hook and gets no equivalent either;
 * the MCP docs page says so in one sentence.
 *
 * @module services/runtimes/claude-code/messaging/classifier-context
 */
import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { CapabilityTier } from '@dorkos/shared/capabilities';

import { recordClassifierAssertion } from '../../../observability/auto-mode-stops.js';
import { MCP_TOOL_TIERS, type McpToolTier } from '../../../core/mcp-tool-tiers.js';
import { IN_SESSION_TOOL_PREFIX } from '../mcp-tools/tool-exposure.js';

/**
 * Every sentence DorkOS is able to say to the classifier, written out once.
 *
 * This object IS the audit surface. Reading it is how anyone — Priya first —
 * answers "what can DorkOS tell the classifier", and the answer has to be
 * readable in one screen with no code execution. Nothing else in this module
 * produces text.
 *
 * Each tier sentence states two facts and stops: that the tool is DorkOS's own
 * and passed DorkOS's own permission check, and what DorkOS's tier table says
 * about it. Neither says whether the call succeeded, because the gate does not
 * know that and this module must not guess.
 */
export const CLASSIFIER_SENTENCES = {
  /** `observe` — reads only, so DorkOS's gate allows it before anything else runs. */
  observe:
    "This is a DorkOS tool and it passed DorkOS's own permission check before it ran. " +
    'DorkOS classes it as read-only, and DorkOS does not require a person to approve calls at that level.',
  /** `act` — changes something a person can put back. */
  act:
    "This is a DorkOS tool and it passed DorkOS's own permission check before it ran. " +
    'DorkOS classes it as a change a person can undo, and DorkOS does not require a person to approve calls at that level.',
  /** `destructive` — DorkOS refuses it outright until somebody approves it. */
  destructive:
    "This is a DorkOS tool and it passed DorkOS's own permission check before it ran. " +
    'DorkOS classes it as something that cannot be undone, and DorkOS refuses calls at that level until a person approves them.',
} as const satisfies Record<CapabilityTier, string>;

/**
 * The `matcher` the `PostToolUse` registration is given, and the reason it is
 * shaped like a pattern rather than like a prefix.
 *
 * **A hook matcher made only of word characters is not a pattern at all.** The
 * CLI reads a matcher of `[a-zA-Z0-9_|, -]` and nothing else as a LIST OF EXACT
 * TOOL NAMES, splits it on `|` and `,`, and asks whether the call's tool name is
 * one of them. Only a matcher carrying some other character — `^`, `.`, `*` —
 * falls through to being compiled as a regular expression and tested against the
 * name. The first cut of this registration passed the bare prefix
 * `mcp__dorkos__`, which is all word characters, so the CLI looked for a tool
 * LITERALLY CALLED `mcp__dorkos__`, never found one, and the hook never ran for
 * any call. Nothing failed: no error, no log line, no note, and the assertion
 * counter in `GET /api/debug/auto-mode-stops` simply stayed at zero — the exact
 * silent-matcher failure the comment beside the registration warned about while
 * being an instance of it.
 *
 * The anchor is what buys the regex reading, and the prefix is what the regex
 * says. Correctness never rests on it: {@link classifierContextFor} re-checks the
 * prefix and the gate's own tier table, so a matcher that is too WIDE costs an
 * extra no-op hook call and nothing else. Too NARROW is the failure that has no
 * symptom, which is why the matcher is pinned by
 * `__tests__/classifier-context.test.ts` against the CLI's own rule rather than
 * only against its own spelling.
 */
export const CLASSIFIER_CONTEXT_MATCHER = `^${IN_SESSION_TOOL_PREFIX}` as const;

/**
 * Whether the host-context note is switched on.
 *
 * One global switch, default on, no config field and nothing per-agent: this is
 * a kill switch for a mechanism that either belongs in the product or does not,
 * and it is the second half of the measurement — turning it off is how the
 * before-and-after numbers in `GET /api/debug/auto-mode-stops` get an "after".
 *
 * Off spellings follow the `donottrack.sh` convention already used by
 * `DORKOS_TELEMETRY_DISABLED`, in reverse: `0`, `false`, `no` and `off` (any
 * case, trimmed) turn it off, and everything else — including unset — leaves it
 * on. A kill switch that killed the server because somebody typed the wrong
 * spelling of "off" would be a worse kill switch.
 *
 * @param raw - The raw `DORKOS_CLASSIFIER_CONTEXT` value, or `undefined`.
 * @returns `true` while DorkOS should attach notes.
 */
export function isClassifierContextEnabled(raw: string | undefined): boolean {
  if (raw == null) return true;
  const normalized = raw.trim().toLowerCase();
  return !(
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off'
  );
}

/**
 * The bare DorkOS tool name behind a name the model called, or `undefined`.
 *
 * The guard, and the only one. A name must carry the in-session server's prefix
 * AND resolve to a tool the gate's own table declares, so anything else — a
 * model tool, another MCP server's tool, a DorkOS tool the Capability Registry
 * projects rather than the tier table declaring it — comes back `undefined` and
 * gets no note.
 *
 * Both halves are load-bearing, and the prefix half is easy to believe is not.
 * Most foreign names fail the TABLE lookup anyway once the prefix test is gone,
 * because slicing a fixed 13 characters off them leaves garbage. The exception
 * is a foreign server whose name happens to be six characters long, like
 * `mcp__github__` or `mcp__notion__`: those slice to a real DorkOS tool name and
 * would collect a note claiming DorkOS gated a call DorkOS never saw. Those are
 * the cases `__tests__/classifier-context.test.ts` mutation-checks the prefix
 * half with — an earlier version of that test used only foreign names that
 * sliced to garbage, and deleting the prefix line left it entirely green.
 *
 * @param toolName - The qualified name the model called.
 * @returns The registered tool name, or `undefined` when this is not a gated
 *   DorkOS tool.
 */
function dorkosToolFor(toolName: string): { bare: string; declared: McpToolTier } | undefined {
  if (!toolName.startsWith(IN_SESSION_TOOL_PREFIX)) return undefined;
  const bare = toolName.slice(IN_SESSION_TOOL_PREFIX.length);
  const declared = (MCP_TOOL_TIERS as Record<string, McpToolTier | undefined>)[bare];
  return declared ? { bare, declared } : undefined;
}

/** What {@link classifierContextFor} concluded about one finished tool call. */
export interface ClassifierContextNote {
  /** The registered tool name, for the debug line. Never part of {@link text}. */
  tool: string;
  /** The tier the note asserts, for the debug line. Never part of {@link text}. */
  tier: CapabilityTier;
  /** The note itself: exactly one sentence from {@link CLASSIFIER_SENTENCES}. */
  text: string;
}

/**
 * The note for one finished tool call, or `undefined` when DorkOS has nothing
 * true to say about it.
 *
 * Cheap by construction, which matters because this runs after every matching
 * tool call: one prefix test and one table lookup. No I/O, no allocation beyond
 * the record, and the arguments are not read at all.
 *
 * Not reading them is the point rather than an optimization. The note is
 * assembled from constants, and a builder that never receives the arguments
 * cannot leak one into a note by accident later.
 *
 * @param toolName - The qualified name the model called.
 * @returns The note, or `undefined` for any tool DorkOS does not own.
 */
export function classifierContextFor(toolName: string): ClassifierContextNote | undefined {
  const resolved = dorkosToolFor(toolName);
  if (!resolved) return undefined;
  const tier = resolved.declared.tier;
  return { tool: resolved.bare, tier, text: CLASSIFIER_SENTENCES[tier] };
}

/** What one session's hook needs to know before it can write a note. */
export interface ClassifierContextHookOptions {
  /** The DorkOS session, for the per-assertion debug line. Never part of a note. */
  sessionId: string;
  /**
   * Whether notes are switched on for this process.
   *
   * Passed in rather than read here so the switch is resolved once, where the
   * launch is resolved, and so a test can drive both sides of it without
   * touching the environment.
   */
  enabled: boolean;
}

/** Nothing to say: let the call through untouched. */
const SILENT: HookJSONOutput = { continue: true };

/**
 * The `PostToolUse` hook that tells auto mode's classifier what DorkOS's own
 * gate already decided.
 *
 * Returns a SYNCHRONOUS hook result — it resolves with the note rather than
 * `{ async: true }`. An async hook's late answer arrives after the result
 * message is frozen and the `classifierContext` in it is silently dropped, so
 * there is no useful "later" on this field.
 *
 * Every path that has nothing to assert returns {@link SILENT}: a non-DorkOS
 * tool, a DorkOS name the gate's table does not declare, any other hook event,
 * and the whole thing switched off. The hook never blocks, never denies and
 * never rewrites the tool's output.
 *
 * @param options - The session, and whether notes are on.
 * @returns The hook callback to register under `PostToolUse`.
 */
export function createClassifierContextHook(options: ClassifierContextHookOptions): HookCallback {
  const { sessionId, enabled } = options;
  return (hookInput) => {
    if (!enabled || hookInput.hook_event_name !== 'PostToolUse') return Promise.resolve(SILENT);
    const note = classifierContextFor(hookInput.tool_name);
    if (!note) return Promise.resolve(SILENT);
    recordClassifierAssertion({ sessionId, tool: note.tool, tier: note.tier });
    return Promise.resolve({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        classifierContext: note.text,
      },
    });
  };
}
