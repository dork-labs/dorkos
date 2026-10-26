/**
 * What a background run could NOT do, so its result can say so.
 *
 * A scheduled run has nobody to answer a permission prompt, so the runtime's
 * approval callbacks refuse on the spot instead of arming a ten-minute wait for
 * an answer that cannot arrive (spec `unattended-session-permission-prompts`).
 * That is a straight improvement only if the person reading the run in the
 * morning is told which tools the agent never got to use. A silent instant
 * denial is the same failure as a silent slow one, in less time.
 *
 * ## What counts, and why the sentence can name the missing person
 *
 * A `permission_denied` StreamEvent whose `reasonType` says nobody was asked
 * ({@link NOBODY_ASKED_REASON_TYPES}):
 *
 * - {@link NO_APPROVAL_SURFACE}, which only DorkOS's own unattended refusal
 *   writes (`runtimes/claude-code/messaging/interactive-handlers.ts`);
 * - `mode`, a call the session's "Never ask" mode refused without asking —
 *   written by the CLI itself, and by DorkOS's gate when one reaches it
 *   (DOR-3132: these were never recorded, so a Never-ask schedule that lost
 *   Bash on every tick showed `refusedTools: []`);
 * - `asyncAgent`, a backgrounded subagent's call the CLI refused because a
 *   detached child has nobody to ask (DOR-795).
 *
 * The other `permission_denied` frames — auto mode's safety classifier, a deny
 * rule the operator wrote — would have been refused with somebody sitting
 * right there, so calling one of those "nobody was there to approve it" would
 * be false, and a deny rule is the operator's own deliberate choice rather
 * than something to fix. Filtering on the discriminator rather than folding
 * every frame in is what makes the sentence true by construction — and a
 * Never ask refusal gets a sentence of its own ({@link describeNeverAskRefusals}),
 * because there the schedule chose not to ask rather than nobody being there.
 *
 * Pure and environment-agnostic, and it lives here for the same reason
 * `run-outcome` does: both dispatch paths need it and they share no other code —
 * the direct one in `apps/server`, the relay's in `packages/relay`, which cannot
 * import from an app at all.
 *
 * @module run-refusals
 */
import type { StreamEvent } from './schemas.js';

/**
 * The `permission_denied` `reasonType` DorkOS stamps on an ask it refused
 * because the session had nobody to answer it.
 *
 * A DorkOS value, deliberately not one of the SDK's own discriminators
 * (`classifier`, `rule`, `mode`, `asyncAgent`): those name decisions that would
 * have happened anyway, and this one names the absence of a person.
 */
export const NO_APPROVAL_SURFACE = 'no_approval_surface';

/**
 * The `reasonType` a refusal by the session's own "Never ask" mode carries —
 * the SDK's discriminator for it, which DorkOS's gate stamps too so the two
 * refusers of one mode leave one record (DOR-3132).
 */
export const NEVER_ASK_REASON_TYPE = 'mode';

/** The SDK's ask-the-person tool: refusing it loses a question, not a tool. */
const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * The refusals that happened because nobody was asked. See the module doc for
 * why these three and not the classifier or a deny rule.
 *
 * Only {@link NO_APPROVAL_SURFACE} carries an `askKind`; the other two are the
 * CLI refusing a TOOL call by definition, so they read as `tool`.
 */
const NOBODY_ASKED_REASON_TYPES: ReadonlySet<string> = new Set([
  NO_APPROVAL_SURFACE,
  NEVER_ASK_REASON_TYPE,
  'asyncAgent',
]);

/**
 * How many tools a run's summary line names before it starts counting.
 *
 * The line leads a 500-character summary field, so an agent that reached for
 * thirty things it could not have must not push the agent's own words out of
 * the row entirely.
 */
const MAX_NAMED_TOOLS = 5;

/**
 * What a tool is called in a sentence a person reads.
 *
 * The `dorkos` server's own prefix is dropped, because it names DorkOS's
 * plumbing and the reader is not deciding anything about it
 * (`mcp__dorkos__post_to_room` → `post_to_room`). Any OTHER server keeps its
 * name, as `server: tool`, because two servers can expose the same tool name and
 * a row that said only `search` would not say whose. A plain tool name is left
 * alone.
 *
 * @param toolName - The tool name exactly as the runtime reported it.
 */
export function readableToolName(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const parts = toolName.split('__');
  // `mcp__<server>__<tool>`; anything shorter is not a shape we can improve on.
  if (parts.length < 3) return toolName;
  const tool = parts.slice(2).join('__');
  const server = parts[1];
  return server === 'dorkos' ? tool : `${server}: ${tool}`;
}

/**
 * What kind of ask DorkOS refused for want of a person.
 *
 * Only `tool` is a run losing the ability to ACT. A `question` or an
 * `elicitation` is the run trying to talk to somebody, which a run that did
 * all its work can still end up doing — see `run-outcome`'s `needs_attention` rule,
 * the one reader that cares about the difference (DOR-2101).
 */
export type RefusedAskKind = 'tool' | 'question' | 'elicitation';

/** One ask a run's runtime refused because the session had nobody to answer it. */
export interface RefusedAsk {
  /** The tool, or the MCP server that asked, as the runtime named it. */
  toolName: string;
  /** Why it was refused, in words, when the record says. */
  reason?: string;
  /**
   * What was being asked, when the record says.
   *
   * Absent only on a frame written before this field existed. Readers that
   * need it must say what an unknown kind means for them rather than guessing
   * — see {@link isRefusedTool}.
   */
  askKind?: RefusedAskKind;
  /**
   * Whether the session's own "Never ask" mode refused it, rather than a
   * prompt nobody was there to answer. The words differ: nobody was asked
   * because the schedule is set not to ask, which a person reading "nobody was
   * there to approve it" would take for an absence (DOR-3132 review).
   */
  neverAsk?: true;
}

/**
 * Just the TOOLS, by name, out of a run's refusals — what a run row keeps.
 *
 * The row's own line says "could not use …", so a question nobody could answer
 * has no business in it (DOR-2101 review). The summary sentence and the
 * activity feed still fold all three kinds: they are about what went
 * unanswered, which is the wider question.
 *
 * @param asks - Every refusal the run's log collected, in order.
 */
export function refusedToolNames(asks: readonly RefusedAsk[]): string[] {
  return asks.filter(isRefusedTool).map((ask) => ask.toolName);
}

/**
 * Whether this refusal is a TOOL the run was not allowed to use.
 *
 * Unknown is NOT a tool, deliberately. The stamp is written in the same
 * statement as the reason it rides beside, by the single function that writes
 * either, so a refusal with no kind cannot come from a DorkOS that has this
 * field — and calling an unclassified ask a tool is how a run that merely
 * asked a question would be reported as one that could not use its tools,
 * under copy that says exactly that.
 *
 * @param ask - The refusal, as the runtime recorded it.
 */
export function isRefusedTool(ask: RefusedAsk): boolean {
  return ask.askKind === 'tool';
}

/** Folds a run's event stream into the list of asks nobody could answer. */
export interface RefusedAskLog {
  /**
   * Fold one event from the run's stream. Safe to call for every event.
   *
   * @param event - The event that just arrived.
   * @returns The refusal, when this event was the FIRST one for its tool — the
   *   moment worth writing down somewhere. `undefined` for an event that was not
   *   a refusal at all, and for a repeat of one already recorded.
   */
  observe(event: StreamEvent): RefusedAsk | undefined;
  /**
   * Every refusal, once per tool, in the order they were first refused.
   *
   * **Deduplicated by tool name, and that is load-bearing.** An agent that keeps
   * reaching for the same blocked tool produces one refusal per attempt, and a
   * retry loop can produce dozens inside one run; a feed with thirty identical
   * rows in it reports the same fact thirty times and buries everything else.
   */
  all(): RefusedAsk[];
  /**
   * The line to put at the top of the run's summary, or `null` when nothing was
   * refused.
   */
  summaryLine(): string | null;
}

/**
 * The sentence a person reads about the asks nobody was there to answer.
 *
 * Deliberately one line: it is the FIRST line of the run's summary, which is
 * what the run-history row, the completion notification and the chat message all
 * quote (`firstLine` in `emitters/run-completed.ts`). Past
 * {@link MAX_NAMED_TOOLS} it counts the rest rather than growing without bound.
 *
 * @param toolNames - The tools that were refused, already readable, in order.
 * @returns The sentence, or `null` for an empty list.
 */
export function describeRefusedAsks(toolNames: readonly string[]): string | null {
  const named = listRefusedTools(toolNames);
  if (named === null) return null;
  return `Skipped ${named.list} — nobody was there to approve ${named.them} on a scheduled run.`;
}

/**
 * The sentence for the tools a schedule's "Never ask" mode refused (DOR-3132).
 *
 * @param toolNames - The tools that were refused, already readable, in order.
 * @returns The sentence, or `null` for an empty list.
 */
export function describeNeverAskRefusals(toolNames: readonly string[]): string | null {
  const named = listRefusedTools(toolNames);
  if (named === null) return null;
  return `Skipped ${named.list} — this schedule is set to Never ask.`;
}

/**
 * The tools, as a phrase a sentence can be built around, plus the pronoun that
 * agrees with it.
 *
 * Extracted from {@link describeRefusedAsks} (DOR-2101) because the run-history
 * row names the same tools in a different sentence, and had its own `join(', ')`
 * with no cap: a run refused thirty things printed all thirty into a row that
 * truncates, while the summary line above it said "and 25 more". Two spellings
 * of one list is a bug a reader has to notice for themselves.
 *
 * @param toolNames - The tools that were refused, already readable, in order.
 * @returns The list and its pronoun, or `null` for an empty list.
 */
export function listRefusedTools(
  toolNames: readonly string[]
): { list: string; them: 'it' | 'them' } | null {
  const unique = [...new Set(toolNames)];
  if (unique.length === 0) return null;
  const shown = unique.slice(0, MAX_NAMED_TOOLS);
  const rest = unique.length - shown.length;
  const listed =
    shown.length === 1
      ? shown[0]
      : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return {
    list: rest > 0 ? `${listed} and ${rest} more` : listed,
    them: unique.length === 1 ? 'it' : 'them',
  };
}

/**
 * Put the refusals above the agent's own words, so the run's result names what
 * it could not do before it says what it did.
 *
 * Ordering is the whole point: every reader of a run summary quotes its FIRST
 * line, so a refusal placed underneath would be invisible in exactly the places
 * a person actually looks — the run-history row and the finished-run message.
 *
 * @param line - The refusal sentence, or `null` when nothing was refused.
 * @param summary - The agent's own output summary, already truncated.
 */
export function withRefusedAsks(line: string | null, summary: string): string {
  if (line === null) return summary;
  return summary.length > 0 ? `${line}\n${summary}` : line;
}

/**
 * The unattended refusal this event describes, or `undefined` when it describes
 * none.
 *
 * The one place the "what counts" rule in this module's doc is implemented, and
 * it is exported because two folds ask it now: {@link createRefusedAskLog},
 * which collects the names, and the run-outcome tracker
 * (`@dorkos/shared/run-outcome`), which only needs to know THAT a run was
 * refused for want of a person. Two copies of this predicate would be two
 * answers to "was anybody there?", and the run row would be written from the
 * wrong one half the time.
 *
 * @param event - The event to read.
 */
export function readRefusedAsk(event: StreamEvent): RefusedAsk | undefined {
  if (event.type !== 'permission_denied') return undefined;
  const data = event.data as {
    toolName?: unknown;
    reasonType?: unknown;
    reason?: unknown;
    askKind?: unknown;
  };
  if (typeof data.reasonType !== 'string' || !NOBODY_ASKED_REASON_TYPES.has(data.reasonType)) {
    return undefined;
  }
  if (typeof data.toolName !== 'string' || data.toolName.length === 0) return undefined;
  // DorkOS's own stamp says which of three asks it refused. The CLI's `mode`
  // and `asyncAgent` frames say nothing, and are a tool call — unless the
  // call was the SDK's own ask-the-person tool, which is the run wanting to
  // talk to somebody rather than act.
  const askKind =
    data.reasonType === NO_APPROVAL_SURFACE
      ? isRefusedAskKind(data.askKind)
        ? data.askKind
        : undefined
      : data.toolName === ASK_USER_QUESTION_TOOL
        ? 'question'
        : 'tool';
  return {
    toolName: data.toolName,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(askKind !== undefined ? { askKind } : {}),
    ...(data.reasonType === NEVER_ASK_REASON_TYPE ? { neverAsk: true as const } : {}),
  };
}

/**
 * Whether a wire value is one of the three kinds of ask.
 *
 * Exported so the session normalizer can carry `askKind` through onto the
 * durable stream without inventing a second copy of the enum — a replayed
 * denial that lost the field would make this module's claim that the record
 * reaches the transcript false (DOR-2101 review).
 *
 * @param value - The raw field, as it arrived on the wire.
 */
export function isRefusedAskKind(value: unknown): value is RefusedAskKind {
  return value === 'tool' || value === 'question' || value === 'elicitation';
}

/**
 * Track which asks a run could not get answered, so the run row can name them.
 *
 * Feed it every event the run's stream yields. See the module doc for what
 * counts and why only DorkOS's own stamp does.
 */
export function createRefusedAskLog(): RefusedAskLog {
  const refused = new Map<string, RefusedAsk>();

  return {
    observe(event: StreamEvent): RefusedAsk | undefined {
      const ask = readRefusedAsk(event);
      if (ask === undefined || refused.has(ask.toolName)) return undefined;
      refused.set(ask.toolName, ask);
      return ask;
    },
    all(): RefusedAsk[] {
      return [...refused.values()];
    },
    summaryLine(): string | null {
      // One line, because every reader quotes only the first: the asks nobody
      // was there to answer, then the ones the Never ask mode refused.
      const names = (neverAsk: boolean) =>
        [...refused.values()]
          .filter((ask) => (ask.neverAsk === true) === neverAsk)
          .map((ask) => readableToolName(ask.toolName));
      const parts = [describeRefusedAsks(names(false)), describeNeverAskRefusals(names(true))];
      const line = parts.filter((part): part is string => part !== null).join(' ');
      return line.length > 0 ? line : null;
    },
  };
}
