/**
 * How loud a whole room is — one number and one sentence for the roster.
 *
 * Every other loudness statement in the cockpit is about ONE agent, and the two
 * questions people actually open this panel with are about the room: *this room
 * is too loud*, and *nobody answered me*. Today both have to be reconstructed by
 * reading N identical grey sentences and comparing them yourself, which is work
 * the roster is holding all the information to do.
 *
 * Three rules keep the answer honest:
 *
 * - **Only agents count.** A person is never triggered — nothing in
 *   `services/rooms/addressing.ts` reads a human membership — so counting one
 *   would inflate every room by exactly the reader.
 * - **The room kind is an input, not a detail.** Two of the five stored values
 *   change behaviour by room kind, so `direct-only` is `Everything` in a direct
 *   message and `@only` in a channel. An aggregate computed without the kind
 *   would report the wrong number for any roster holding one of them — see
 *   `response-mode.ts` for the table.
 * - **{@link previewLoudness} is {@link roomLoudness} with one substitution.**
 *   Not a second implementation of the same idea: a preview that drifts from the
 *   real answer is a UI promising one consequence and delivering another, which
 *   is worse than showing no preview at all.
 *
 * @module entities/room/lib/loudness
 */
import type { RoomKind, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { modeForRung, rungOf, type ResponseRung } from './response-mode';

/**
 * How many of the meter's four bars are lit.
 *
 * `0` is its own answer and not "quiet": it means there is no agent in here at
 * all, so there is no scale to be at one end of. Every other level is the
 * position of the LOUDEST agent present, which is the one that decides what the
 * room feels like — a room with one `Everything` agent in it is a loud room
 * however many silent ones sit beside it.
 */
export type LoudnessLevel = 0 | 1 | 2 | 3 | 4;

/** What the whole room does, in a form a person can read at a glance. */
export interface RoomLoudness {
  /** Bars lit on the four-bar meter, `0` when the room holds no agents. */
  level: LoudnessLevel;
  /** The headline. Always true of this exact roster; never ends in a full stop. */
  sentence: string;
  /**
   * The one member the sentence does not cover, named — or `null`.
   *
   * Named only when there is exactly ONE. Two exceptions are a list, and a list
   * of exceptions is the wall of peer sentences this whole aggregate exists to
   * replace.
   */
  detail: string | null;
}

/** A rung's position on the four-bar meter. Quietest still lights one bar. */
const LEVEL_OF_RUNG: Record<ResponseRung, Exclude<LoudnessLevel, 0>> = {
  silent: 1,
  mention: 2,
  engaged: 3,
  everything: 4,
};

/**
 * Where one agent sits on the same four-bar meter the room does.
 *
 * The quietest rung still lights a bar: it is a POSITION on a scale, not an
 * absence, and an unlit meter beside the word `Silent` would read as a control
 * that had failed to load. An unlit meter is the room's answer alone — see
 * {@link LoudnessLevel}.
 *
 * @param rung - The rung to place.
 */
export function levelOfRung(rung: ResponseRung): Exclude<LoudnessLevel, 0> {
  return LEVEL_OF_RUNG[rung];
}

/**
 * Counts read as words up to nine, then as digits.
 *
 * Index `0` is unreachable — a room with nobody answering says so in its own
 * sentence rather than counting to zero — and is filled with the word that
 * would be right anyway rather than a hole.
 */
const COUNT_WORDS = [
  'No',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
] as const;

/** `Two agents` / `One agent` / `12 agents`, ready to start a sentence. */
function countAgents(count: number): string {
  const word = count < COUNT_WORDS.length ? COUNT_WORDS[count] : String(count);
  return `${word} ${count === 1 ? 'agent' : 'agents'}`;
}

/** One agent's contribution to the room: what to call it, and how loud it is. */
interface Voice {
  name: string;
  rung: ResponseRung;
}

/** What a lone exception does, in the same voice as the headline. */
function nameException(voice: Voice): string | null {
  switch (voice.rung) {
    case 'mention':
      return `${voice.name} only when @mentioned`;
    case 'silent':
      return `${voice.name} never speaks here`;
    // An agent inside the answering group is not an exception to it, so a
    // caller that reaches here has already made a mistake about which group it
    // is describing. Saying nothing is the safe half of that.
    case 'engaged':
    case 'everything':
      return null;
  }
}

/** The exception, when there is exactly one and it has something to say. */
function detailFor(outside: readonly Voice[]): string | null {
  return outside.length === 1 ? nameException(outside[0]!) : null;
}

/**
 * The whole computation, over rungs rather than over memberships.
 *
 * Both public functions land here with a list they built the same way, which is
 * what makes the preview and the real answer the same answer.
 */
function loudnessOf(voices: readonly Voice[]): RoomLoudness {
  if (voices.length === 0) {
    return { level: 0, sentence: 'There is nobody here to answer you', detail: null };
  }

  const level = voices.reduce<Exclude<LoudnessLevel, 0>>(
    (loudest, voice) => (LEVEL_OF_RUNG[voice.rung] > loudest ? LEVEL_OF_RUNG[voice.rung] : loudest),
    1
  );

  if (level === 1) {
    // Every agent is Silent, so there is no exception to name — they are all
    // the same, and a room where they are all the same has nothing to add.
    return { level, sentence: 'Nobody here will answer you', detail: null };
  }

  if (level === 2) {
    return {
      level,
      sentence: 'Only @mentions get an answer here',
      detail: detailFor(voices.filter((voice) => voice.rung === 'silent')),
    };
  }

  // Loud enough that somebody keeps talking after being addressed once. THAT is
  // the group the headline counts — an `@only` agent answers too, but only ever
  // the message that named it, which is the difference a person feels.
  const answering = voices.filter(
    (voice) => voice.rung === 'engaged' || voice.rung === 'everything'
  );
  const everyAnswerIsEverything = answering.every((voice) => voice.rung === 'everything');
  // `will answer` is the same word at any count; `answer` is not, so the one
  // branch with a present-tense verb in it has to agree with its own subject.
  const verb = answering.length === 1 ? 'answers' : 'answer';
  return {
    level,
    sentence: everyAnswerIsEverything
      ? `${countAgents(answering.length)} ${verb} every message here`
      : `${countAgents(answering.length)} will answer you here`,
    detail: detailFor(voices.filter((voice) => !answering.includes(voice))),
  };
}

/** One member imagined somewhere other than where they are. */
interface RungOverride {
  authorId: string;
  rung: ResponseRung;
}

/**
 * The agents on a roster, each already placed on this room's scale.
 *
 * The override is taken HERE rather than applied to the result, so the real
 * answer and the preview differ by one array element and by nothing else. There
 * is no second path for the preview to drift down.
 */
function voicesOf(
  members: readonly RoomRosterEntry[],
  roomKind: RoomKind,
  override?: RungOverride
): Voice[] {
  return members
    .filter((member) => member.author.kind === 'agent')
    .map((member) => ({
      name: member.author.displayName,
      rung:
        override && member.authorId === override.authorId
          ? override.rung
          : rungOf(member.responseMode, roomKind),
    }));
}

/**
 * What this room will do, as it stands.
 *
 * @param members - The room's roster. People and the room's own voice are
 *   filtered out here rather than by the caller, so every surface asking this
 *   question gets the same answer.
 * @param roomKind - The room the roster lives in; two of the five stored values
 *   mean different things in each kind.
 */
export function roomLoudness(
  members: readonly RoomRosterEntry[],
  roomKind: RoomKind
): RoomLoudness {
  return loudnessOf(voicesOf(members, roomKind));
}

/**
 * What this room WOULD do if one member were moved to a different rung.
 *
 * The same computation as {@link roomLoudness} over a roster with one value
 * swapped — deliberately not a second reading of the same idea, because a
 * preview that disagrees with the outcome teaches the wrong model and only
 * proves itself wrong after the write has landed.
 *
 * The hypothetical rung is put through the same round trip a real write takes
 * ({@link modeForRung} then {@link rungOf}), so asking a direct message about
 * `engaged` previews what it would actually become — `@only`, because the
 * engaged window cannot open there — rather than a rung the room has no
 * behaviour for.
 *
 * @param members - The room's roster as it is now.
 * @param roomKind - The room the roster lives in.
 * @param authorId - The member being imagined at a different rung. An id that
 *   is not on the roster, or belongs to a person, changes nothing — which is
 *   the honest answer, since neither has a rung to move.
 * @param rung - The rung to imagine them on.
 */
export function previewLoudness(
  members: readonly RoomRosterEntry[],
  roomKind: RoomKind,
  authorId: string,
  rung: ResponseRung
): RoomLoudness {
  const asStored = rungOf(modeForRung(rung, roomKind), roomKind);
  return loudnessOf(voicesOf(members, roomKind, { authorId, rung: asStored }));
}
