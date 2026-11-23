/**
 * Where a to-do's words came from, and the one check every to-do tool runs before it hands rows
 * back (DOR-4666, Security's rulings of 2026-11-23).
 *
 * - Every write that puts words on a to-do records their marks with it ({@link withWordMarks}):
 *   a note or a delivered link on an agent's own promise included, whatever its state does, while
 *   the promise's power stays as it was. A person's words count as outside only when nobody proved
 *   they are the person.
 * - Every to-do tool marks its caller's turn when a row it hands back carries outside words
 *   ({@link markTurnIfOutside}): the six of them (`todos.*` and `todo_promises.*`) share this one
 *   function, so no two can drift apart, and a census test fails if one is classed otherwise.
 *
 * @module services/todos/todo-word-marks
 */
import { markCallerTurnOutsider } from '../core/capabilities/mark-caller-turn.js';
import type { CapabilityHandlerContext } from '../core/capabilities/index.js';
import { mergeMarks, NO_MARKS, type TurnMarks } from '../core/turn-power/turn-marks.js';
import { agentWordsMarks, readAuthorityMarks, writeAuthorityMarks } from './todo-authority.js';
import { speaksAsPerson, type TodoPromiseActor } from './todo-promise-types.js';

/** The outsider mark alone: words DorkOS cannot vouch for. */
const OUTSIDER: TurnMarks = Object.freeze({ outsider: true });

/**
 * The marks an actor's words carry: an agent's turn marks (and the outsider mark when its level is
 * not known), or, for a person, the outsider mark unless they proved who they are.
 *
 * @param actor - Who is writing.
 */
export function wordMarksOf(actor: TodoPromiseActor): TurnMarks {
  if (actor.kind === 'agent') return agentWordsMarks(actor.level, actor.marks ?? NO_MARKS);
  return speaksAsPerson(actor) ? NO_MARKS : OUTSIDER;
}

/**
 * A stored `authority_marks` value with an actor's word marks merged in. Only ever adds.
 *
 * @param stored - The row's `authority_marks` column.
 * @param actor - Who wrote the words.
 */
export function withWordMarks(stored: string, actor: TodoPromiseActor): string {
  return writeAuthorityMarks(mergeMarks(readAuthorityMarks(stored), wordMarksOf(actor)));
}

/**
 * Mark the caller's turn, before the rows reach it, when any to-do it gets back carries outside
 * words. With no way to tell, it marks.
 *
 * @param context - The verified call.
 * @param ids - The to-dos the tool hands back.
 * @param carriesOutsideWords - Whether one to-do's words came from outside the team.
 */
export function markTurnIfOutside(
  context: CapabilityHandlerContext,
  ids: readonly string[],
  carriesOutsideWords: ((id: string) => boolean) | undefined
): void {
  if (ids.length === 0) return;
  if (!carriesOutsideWords || ids.some((id) => carriesOutsideWords(id))) {
    markCallerTurnOutsider(context, { kind: 'dorkos-tool' });
  }
}
