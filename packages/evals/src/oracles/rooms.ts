/**
 * Room oracles: what a room DID about a post — who was triggered, who spoke,
 * what the room said on their behalf, and what the turn budget was charged.
 *
 * The second of the two harness gaps `specs/engaged-response-gate/01-ideation.md`
 * §13.2 names: there was no oracle that could answer *"was a turn triggered for
 * agent X"*. It is answered here from the room's own durable stream, never from
 * a log line and never from the assistant's prose.
 *
 * ## A turn is a WORKING INDICATOR, not a reply
 *
 * The signal a triggered turn publishes is `progress` / `working`, carrying the
 * agent's author id and the entry it was triggered by (`room-trigger.ts`
 * `publishPresence`). That is the honest identity of a turn, and it is the
 * reason these oracles read signals rather than counting replies:
 *
 * - a turn that ends with nothing to say publishes an indicator and posts no
 *   entry, so counting replies would score it as "no turn" — which is exactly
 *   the confusion the engaged-response-gate work has to be able to measure;
 * - a turn refused before it started publishes no indicator, which is what
 *   {@link noRoomTurnFor} asserts.
 *
 * **Turns are counted per `(authorId, entryId)` pair, not per frame.** A claim
 * that outlives one republish interval re-states its indicator (`republishPresence`),
 * so frame-counting would read one long turn as several. The trigger entry is
 * part of an indicator's identity for exactly this reason, and a collected burst
 * carries the id of the message the turn answers — which is what makes "three
 * messages, one turn" measurable at all.
 *
 * ## The budget oracle reads the database, like the governance suite
 *
 * `room_turn_spend` is written once per automatic turn ACTUALLY RUN and read
 * back at construction (`turn-budget.ts`, DOR-1205), so it is the durable record
 * of what a post cost. Reading it from the sandbox database — the same move
 * `uninstallApprovalsInDb` makes for approvals — is what lets a case assert that
 * silence was FREE rather than merely quiet.
 *
 * ## Every oracle here ships with its drill, and the drill is executable
 *
 * A room oracle reads FRAMES, so the seed that should turn it red is itself a
 * frame set — which means the recipe does not have to be prose somebody might
 * follow. `__tests__/rooms.test.ts` shows each oracle green on the frames that
 * should pass it and red on the ones that should not, including the two shapes
 * that would otherwise pass vacuously: an oracle asked about a case that
 * collected no room, and a restraint check whose boundary was never recorded.
 * The end-to-end drill — break addressing, watch these go red against a real
 * server — is in `suite/rooms.ts`.
 *
 * @module evals/oracles/rooms
 */
import path from 'node:path';
import { createDb, roomTurnSpend } from '@dorkos/db';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { Oracle, OracleContext, OracleResult, RoomFacts } from '../types.js';

/** A room `entry` frame's payload. */
interface RoomEntryFrameData {
  type?: string;
  seq?: number;
  entry?: {
    id?: string;
    authorId?: string;
    kind?: string;
    body?: { text?: string; notice?: string };
    sessionId?: string | null;
    mentions?: string[];
  };
}

/** A room `signal` frame's payload. */
interface RoomSignalFrameData {
  type?: string;
  signal?: string;
  authorId?: string;
  state?: string;
  entryId?: string;
}

/** One committed entry, as these oracles read it. */
export interface ObservedEntry {
  /** The entry's id. */
  id: string;
  /** Who wrote it. */
  authorId: string;
  /** `post` or `notice`. */
  kind: string;
  /** The words it carries. */
  text: string;
  /** The notice code, when it is a notice. */
  notice: string | undefined;
}

/** One triggered turn, identified by the agent and the entry it answers. */
export interface ObservedTurn {
  /** The agent author the indicator named. */
  authorId: string;
  /** The entry that triggered it. */
  entryId: string;
}

/**
 * Every entry that arrived LIVE on the collected stream.
 *
 * The cold `snapshot` frame's history is deliberately excluded: it is the room
 * as it stood before the drive posted anything, so counting it would fold a
 * case's own setup into its result.
 *
 * @param frames - The collected room frames.
 * @returns The live entries, in stream order.
 */
export function observedEntries(frames: SseFrame[]): ObservedEntry[] {
  const entries: ObservedEntry[] = [];
  for (const frame of frames) {
    if (frame.event !== 'entry') continue;
    const entry = (frame.data as RoomEntryFrameData).entry;
    if (!entry?.id || !entry.authorId) continue;
    entries.push({
      id: entry.id,
      authorId: entry.authorId,
      kind: entry.kind ?? 'post',
      text: entry.body?.text ?? '',
      notice: entry.body?.notice,
    });
  }
  return entries;
}

/**
 * Every turn the collected stream shows, deduplicated per `(agent, trigger)`.
 *
 * @param frames - The collected room frames.
 * @returns One entry per distinct turn, in the order each was first seen.
 */
export function observedTurns(frames: SseFrame[]): ObservedTurn[] {
  const seen = new Map<string, ObservedTurn>();
  for (const frame of frames) {
    if (frame.event !== 'signal') continue;
    const data = frame.data as RoomSignalFrameData;
    if (data.signal !== 'progress' || !data.authorId) continue;
    // `done` is the release of an indicator that was already counted when it
    // started; counting it would double every turn.
    if (data.state !== 'working' && data.state !== 'working_late') continue;
    const entryId = data.entryId ?? '';
    const key = `${data.authorId}::${entryId}`;
    if (!seen.has(key)) seen.set(key, { authorId: data.authorId, entryId });
  }
  return [...seen.values()];
}

/**
 * Resolve one seeded agent's author id from the room facts, or throw a legible
 * error — an oracle asking about an agent the case never seated is a bug in the
 * case, and a silent `undefined` would score as "that agent stayed quiet".
 *
 * @param room - The room facts the script recorded.
 * @param slug - The seeded agent's slug.
 * @returns That agent's author id.
 */
function agentAuthorId(room: RoomFacts, slug: string): string {
  const authorId = room.agents[slug];
  if (!authorId) {
    throw new Error(
      `no agent seated under the slug "${slug}" (seated: ${Object.keys(room.agents).join(', ') || 'none'})`
    );
  }
  return authorId;
}

/**
 * Read the room facts off the oracle context, or fail the oracle honestly.
 *
 * A rooms oracle on a case with no room script has nothing to assert about, and
 * saying so is the only safe answer: returning "passed" would be a green about
 * a room that never existed.
 *
 * @param ctx - The oracle context.
 * @param label - The oracle's label, for the failure result.
 * @returns The room facts, or a failing result to return as-is.
 */
function requireRoom(
  ctx: OracleContext,
  label: string
): { room: RoomFacts } | { failure: OracleResult } {
  if (!ctx.room) {
    return {
      failure: {
        label,
        passed: false,
        detail: 'this case collected no room — a rooms oracle needs a `roomScript`',
      },
    };
  }
  return { room: ctx.room };
}

/** Shared evidence every turn-shaped oracle attaches. */
function turnEvidence(frames: SseFrame[], authorId: string): Record<string, unknown> {
  const turns = observedTurns(frames);
  return {
    authorId,
    turnsForAgent: turns.filter((t) => t.authorId === authorId).length,
    turnsInRoom: turns.length,
    triggers: turns.map((t) => `${t.authorId}@${t.entryId}`),
  };
}

/**
 * Oracle: a turn was triggered for this agent — the room published a working
 * indicator naming it.
 *
 * @param slug - The seeded agent's slug.
 * @param label - Human-readable label.
 * @returns An {@link Oracle}.
 */
export function roomTurnRanFor(slug: string, label?: string): Oracle {
  const oracleLabel = label ?? `a turn was triggered for "${slug}"`;
  return async (ctx) => {
    const resolved = requireRoom(ctx, oracleLabel);
    if ('failure' in resolved) return resolved.failure;
    const authorId = agentAuthorId(resolved.room, slug);
    const evidence = turnEvidence(ctx.frames, authorId);
    const passed = (evidence.turnsForAgent as number) > 0;
    return {
      label: oracleLabel,
      passed,
      evidence,
      detail: passed ? undefined : `no working indicator named ${slug} (${authorId})`,
    };
  };
}

/**
 * Oracle: NO turn was triggered for this agent — nothing was spent, and the
 * room never showed it working.
 *
 * @param slug - The seeded agent's slug.
 * @param label - Human-readable label.
 * @returns An {@link Oracle}.
 */
export function noRoomTurnFor(slug: string, label?: string): Oracle {
  const oracleLabel = label ?? `no turn was triggered for "${slug}"`;
  return async (ctx) => {
    const resolved = requireRoom(ctx, oracleLabel);
    if ('failure' in resolved) return resolved.failure;
    const authorId = agentAuthorId(resolved.room, slug);
    const evidence = turnEvidence(ctx.frames, authorId);
    const count = evidence.turnsForAgent as number;
    return {
      label: oracleLabel,
      passed: count === 0,
      evidence,
      detail: count === 0 ? undefined : `${count} turn(s) ran for ${slug} (${authorId})`,
    };
  };
}

/**
 * Oracle: exactly `expected` turns were triggered for this agent.
 *
 * The burst case's whole claim: three messages inside the collect window are one
 * turn, not three. Counted per `(agent, trigger entry)`, so a long turn's
 * republished indicator cannot inflate it.
 *
 * @param slug - The seeded agent's slug.
 * @param expected - How many distinct turns must have run.
 * @param label - Human-readable label.
 * @returns An {@link Oracle}.
 */
export function roomTurnsRanFor(slug: string, expected: number, label?: string): Oracle {
  const oracleLabel = label ?? `exactly ${expected} turn(s) ran for "${slug}"`;
  return async (ctx) => {
    const resolved = requireRoom(ctx, oracleLabel);
    if ('failure' in resolved) return resolved.failure;
    const authorId = agentAuthorId(resolved.room, slug);
    const evidence = turnEvidence(ctx.frames, authorId);
    const count = evidence.turnsForAgent as number;
    return {
      label: oracleLabel,
      passed: count === expected,
      evidence,
      detail: count === expected ? undefined : `expected ${expected} turn(s), observed ${count}`,
    };
  };
}

/**
 * Oracle: this agent posted at least one message, and (optionally) one that
 * satisfies `matches`.
 *
 * The predicate is a DETERMINISTIC text check — a phrase list, a regexp, a
 * canary that must be absent — never a judgment, following
 * `oracles/transcript.ts`'s `finalAssistantMessageMatches`. It is handed the
 * room as well as the text, because half of what a recall probe has to check is
 * an id or a handle the server MINTED (X-02 asks the agent to name another
 * member's `@handle`, which no case can write down in advance).
 *
 * @param slug - The seeded agent's slug.
 * @param opts.matches - What one of its posts must satisfy.
 * @param opts.label - Human-readable label.
 * @returns An {@link Oracle}.
 */
export function agentPostedInRoom(
  slug: string,
  opts: { matches?: (text: string, room: RoomFacts) => boolean; label?: string } = {}
): Oracle {
  const oracleLabel = opts.label ?? `"${slug}" posted in the room`;
  return async (ctx) => {
    const resolved = requireRoom(ctx, oracleLabel);
    if ('failure' in resolved) return resolved.failure;
    const authorId = agentAuthorId(resolved.room, slug);
    const posts = observedEntries(ctx.frames).filter(
      (e) => e.authorId === authorId && e.kind === 'post'
    );
    const matched = opts.matches
      ? posts.filter((p) => opts.matches?.(p.text, resolved.room))
      : posts;
    const passed = matched.length > 0;
    return {
      label: oracleLabel,
      passed,
      evidence: {
        authorId,
        posts: posts.length,
        matched: matched.length,
        // Bounded: a transcript is the artifact, this is the summary beside it.
        texts: posts.map((p) => p.text.slice(0, 400)),
      },
      detail: passed
        ? undefined
        : posts.length === 0
          ? `${slug} posted nothing`
          : `${slug} posted ${posts.length} message(s), none matching`,
    };
  };
}

/**
 * Oracle: this agent posted NOTHING — the restraint case's assertion.
 *
 * Deliberately says nothing about whether a turn ran: on today's build an
 * engaged agent's restraint IS a turn that ends with nothing to say, and
 * conflating the two would make this oracle unable to tell that apart from the
 * cheaper silence the response gate is meant to buy.
 *
 * `afterNote` narrows the window to everything past one entry the script
 * recorded, which is what a restraint case needs: the agent has to be spoken to
 * once to open its engaged window at all, and that answer is correct conduct
 * rather than a failure of restraint.
 *
 * @param slug - The seeded agent's slug.
 * @param opts.afterNote - A {@link RoomFacts.notes} key holding the entry id
 *   after which silence is asserted.
 * @param opts.label - Human-readable label.
 * @returns An {@link Oracle}.
 */
export function agentStayedQuietInRoom(
  slug: string,
  opts: { afterNote?: string; label?: string } = {}
): Oracle {
  const oracleLabel = opts.label ?? `"${slug}" stayed quiet`;
  return async (ctx) => {
    const resolved = requireRoom(ctx, oracleLabel);
    if ('failure' in resolved) return resolved.failure;
    const authorId = agentAuthorId(resolved.room, slug);
    const entries = observedEntries(ctx.frames);
    const boundaryId = opts.afterNote ? resolved.room.notes[opts.afterNote] : undefined;
    if (opts.afterNote && typeof boundaryId !== 'string') {
      return {
        label: oracleLabel,
        passed: false,
        evidence: { afterNote: opts.afterNote, recorded: boundaryId },
        detail: `the script recorded no entry id under "${opts.afterNote}", so there is no window to judge`,
      };
    }
    const from =
      typeof boundaryId === 'string' ? entries.findIndex((e) => e.id === boundaryId) + 1 : 0;
    const posts = entries.slice(from).filter((e) => e.authorId === authorId && e.kind === 'post');
    return {
      label: oracleLabel,
      passed: posts.length === 0,
      evidence: {
        authorId,
        ...(opts.afterNote ? { after: boundaryId } : {}),
        posts: posts.map((p) => p.text.slice(0, 400)),
      },
      detail: posts.length === 0 ? undefined : `${slug} posted ${posts.length} message(s)`,
    };
  };
}

/**
 * Oracle: the room wrote exactly `expected` notices of `code`.
 *
 * A notice is the room's own voice (`kind: 'notice'` with a closed `notice`
 * code), so this is how "halt says so, once" is asserted without reading prose.
 *
 * @param code - The notice code (e.g. `halted`).
 * @param expected - How many notices carrying it the room must have written.
 * @param label - Human-readable label.
 * @returns An {@link Oracle}.
 */
export function roomNoticeCount(code: string, expected: number, label?: string): Oracle {
  const oracleLabel = label ?? `the room wrote exactly ${expected} "${code}" notice(s)`;
  return async (ctx) => {
    const notices = observedEntries(ctx.frames).filter((e) => e.kind === 'notice');
    const matching = notices.filter((n) => n.notice === code);
    return {
      label: oracleLabel,
      passed: matching.length === expected,
      evidence: {
        code,
        matching: matching.length,
        allNotices: notices.map((n) => ({ code: n.notice, text: n.text.slice(0, 200) })),
      },
      detail:
        matching.length === expected
          ? undefined
          : `expected ${expected} "${code}" notice(s), observed ${matching.length}`,
    };
  };
}

/**
 * Oracle: no room entry anywhere in the drive contains `needle` — the
 * anti-exfiltration assertion.
 *
 * Reads EVERY entry (notices included), because a leak is a leak whoever wrote
 * the line it appeared on.
 *
 * @param needle - The canary string that must never be posted.
 * @param label - Human-readable label.
 * @returns An {@link Oracle}.
 */
export function noRoomEntryContains(needle: string, label?: string): Oracle {
  const oracleLabel = label ?? `no room entry leaked "${needle}"`;
  return async (ctx) => {
    const leaks = observedEntries(ctx.frames).filter((e) => e.text.includes(needle));
    return {
      label: oracleLabel,
      passed: leaks.length === 0,
      evidence: { needle, leaks: leaks.map((l) => ({ authorId: l.authorId, id: l.id })) },
      detail: leaks.length === 0 ? undefined : `${leaks.length} entry/entries carried the canary`,
    };
  };
}

/**
 * Oracle: something the room script RECORDED satisfies `predicate` — the
 * `stopped` count a halt answered with, an entry id it kept.
 *
 * The narrow escape hatch for a fact that exists only in the API's ANSWER and
 * never on the stream. `POST /:id/halt` returning `{ stopped: 1 }` is the whole
 * of "the halt reached a live turn", and no frame carries it.
 *
 * @param key - The key the script wrote into {@link RoomFacts.notes}.
 * @param predicate - What that value must satisfy.
 * @param label - Human-readable label.
 * @returns An {@link Oracle}.
 */
export function roomScriptNote(
  key: string,
  predicate: (value: unknown) => boolean,
  label: string
): Oracle {
  return async (ctx) => {
    const resolved = requireRoom(ctx, label);
    if ('failure' in resolved) return resolved.failure;
    const value = resolved.room.notes[key];
    const passed = predicate(value);
    return {
      label,
      passed,
      evidence: { key, value },
      detail: passed ? undefined : `the script recorded ${key}=${JSON.stringify(value)}`,
    };
  };
}

/** A verdict over the room's spend rows, plus why it failed. */
export interface SpendVerdict {
  /** True iff the rows say what the case asserts. */
  passed: boolean;
  /** One-line reason, when they do not. */
  detail?: string;
}

/**
 * Build an oracle over the automatic-turn spend rows this room wrote.
 *
 * Reads `room_turn_spend` out of the sandbox database rather than an API,
 * because there is no endpoint that reports it and because the row is the
 * durable artifact: it is written once per automatic turn actually run, and
 * read back at construction so an hour means an hour (`turn-budget.ts`).
 *
 * @param verdict - Judges the rows this room wrote.
 * @param label - Human-readable label.
 * @returns An {@link Oracle}.
 */
export function roomTurnSpendRows(
  verdict: (rows: Array<{ roomId: string; at: number }>) => SpendVerdict,
  label: string
): Oracle {
  return async (ctx): Promise<OracleResult> => {
    const resolved = requireRoom(ctx, label);
    if ('failure' in resolved) return resolved.failure;
    const dbPath = path.join(ctx.sandbox.dorkHome, 'dork.db');
    let db: ReturnType<typeof createDb> | undefined;
    try {
      db = createDb(dbPath);
      const all = db.select().from(roomTurnSpend).all();
      const mine = all
        .filter((row) => row.roomId === resolved.room.roomId)
        .map((row) => ({ roomId: row.roomId, at: row.at }));
      const outcome = verdict(mine);
      return {
        label,
        passed: outcome.passed,
        evidence: {
          dbPath,
          roomId: resolved.room.roomId,
          spends: mine.length,
          allSpends: all.length,
        },
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      };
    } catch (err) {
      return {
        label,
        passed: false,
        evidence: { dbPath, error: err instanceof Error ? err.message : String(err) },
        detail: `could not read the room_turn_spend table in ${dbPath}`,
      };
    } finally {
      db?.$client.close();
    }
  };
}

/**
 * Oracle: this room spent NOTHING from the automatic-turn budget.
 *
 * Silence that nobody asked for has to be free — a room post that addresses
 * nobody must not take a turn out of the hourly ceiling the next person who
 * DOES address an agent will need.
 *
 * @param label - Human-readable label.
 * @returns An {@link Oracle}.
 */
export function roomSpentNoTurnBudget(label?: string): Oracle {
  return roomTurnSpendRows(
    (rows) =>
      rows.length === 0
        ? { passed: true }
        : { passed: false, detail: `${rows.length} automatic turn(s) were charged to this room` },
    label ?? 'the room spent nothing from the automatic-turn budget'
  );
}

/**
 * Oracle: this room was charged exactly `expected` automatic turns.
 *
 * @param expected - The number of spend rows the case asserts.
 * @param label - Human-readable label.
 * @returns An {@link Oracle}.
 */
export function roomTurnBudgetSpent(expected: number, label?: string): Oracle {
  return roomTurnSpendRows(
    (rows) =>
      rows.length === expected
        ? { passed: true }
        : {
            passed: false,
            detail: `expected ${expected} charged turn(s), the room wrote ${rows.length}`,
          },
    label ?? `the room was charged exactly ${expected} automatic turn(s)`
  );
}
