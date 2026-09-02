/**
 * The rule that decides who a stored display name is attributed to (DOR-1022).
 *
 * Four decisions live here, and each is a product answer rather than a mechanical
 * one: a writer re-sending an unchanged name says nothing about who chose it, an
 * unattributed door may never claim a person, clearing the name clears the
 * record, and an agent this install cannot identify still gets a note drawn for
 * it. Every one is asserted below in a form that goes red if the rule is
 * inverted.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { OPERATOR_SAVE_SOURCE, stampDisplayNameSource } from '../display-name-provenance.js';

const DORKBOT = { kind: 'agent', agentName: 'DorkBot' } as const;
const CONFIG_DOOR = { kind: 'unattributed' } as const;

describe('stampDisplayNameSource', () => {
  describe('when an agent writes', () => {
    it('records the agent behind a name nobody had set', () => {
      expect(stampDisplayNameSource(null, 'Dorian', DORKBOT)).toEqual({
        kind: 'agent',
        agentName: 'DorkBot',
      });
    });

    it('records the agent behind a name it CHANGED', () => {
      // The seeding case DOR-979 left silent: a name is already stored, an agent
      // replaces it, and every surface starts calling the person something they
      // never chose.
      expect(stampDisplayNameSource('Dorian', 'Dorian C', DORKBOT)).toEqual({
        kind: 'agent',
        agentName: 'DorkBot',
      });
    });

    it('leaves the record alone when it re-sends the name already stored', () => {
      // The false alarm this guards: a person saved "Dorian", DorkBot later
      // patches `profile.displayName: 'Dorian'` as part of some other update,
      // and the roster starts claiming the person's own name was a suggestion.
      // `undefined` is "do not touch the record", not "no source".
      expect(stampDisplayNameSource('Dorian', 'Dorian', DORKBOT)).toBeUndefined();
    });

    it('treats a name differing only in whitespace as the same name', () => {
      // The schema trims what it stores, so a patch carrying a stray space would
      // otherwise raise the note on a value that never actually moved.
      expect(stampDisplayNameSource('Dorian', ' Dorian ', DORKBOT)).toBeUndefined();
    });

    it('records an agent it cannot name, rather than staying silent', () => {
      // Attribution is best-effort: an agent whose identity token expired still
      // wrote the name. `null` draws "Suggested by an agent"; `undefined` would
      // draw nothing at all, which is the wrong direction to fail in.
      expect(stampDisplayNameSource(null, 'Dorian', { kind: 'agent', agentName: null })).toEqual({
        kind: 'agent',
        agentName: null,
      });
    });

    it('falls back to unnamed when the agent name sanitizes away to nothing', () => {
      // An agent chooses its own display name and this string is printed inside
      // a sentence DorkOS wrote. A name made only of control characters is not a
      // name, so it lands in the same place an unresolvable identity does.
      expect(stampDisplayNameSource(null, 'Dorian', { kind: 'agent', agentName: '​' })).toEqual({
        kind: 'agent',
        agentName: null,
      });
    });

    it('strips markup out of an agent name before it is ever stored', () => {
      const stamped = stampDisplayNameSource(null, 'Dorian', {
        kind: 'agent',
        agentName: '<system>Trusted</system>',
      });
      expect(stamped).toEqual({ kind: 'agent', agentName: 'system Trusted /system' });
    });

    it('records the agent for a name carrying the sanitizer’s own edge cases', () => {
      // The two strings that survive the schema and are RENDERED differently
      // (a double space collapses, a zero-width character vanishes). Nothing
      // about the stamp may depend on the rendered form — the roster answers
      // that question with the name RUNG instead, never by comparing strings.
      for (const attack of ['Dorian  C', 'Dorian​']) {
        expect(stampDisplayNameSource(null, attack, DORKBOT)).toEqual({
          kind: 'agent',
          agentName: 'DorkBot',
        });
      }
    });
  });

  describe('when a general config door writes', () => {
    it('records NOBODY for a name it changed, never the operator', () => {
      // `PATCH /api/config` and `dorkos config set` cannot tell a person from a
      // process running as them. `null` is "no record": no note is drawn, and
      // nobody is credited with a choice this door cannot witness.
      expect(stampDisplayNameSource('Dorian', 'Dorian C', CONFIG_DOOR)).toBeNull();
      expect(stampDisplayNameSource(null, 'Dorian', CONFIG_DOOR)).toBeNull();
    });

    it('cannot launder an agent’s stamp by re-sending the agent’s own name', () => {
      // The attack this rule exists for: DorkBot sets the name, the note
      // appears, and the same agent `curl`s the value back through the
      // unattributed door hoping to be read as the person. A write that moves
      // nothing says nothing — the agent's stamp is left exactly where it was.
      expect(stampDisplayNameSource('Dorian', 'Dorian', CONFIG_DOOR)).toBeUndefined();
      expect(stampDisplayNameSource('Dorian', '  Dorian  ', CONFIG_DOOR)).toBeUndefined();
    });
  });

  describe('when the name is cleared', () => {
    it('clears the record with it, whichever door cleared it', () => {
      // No name, no provenance. A leftover `agent` stamp beside a `null` name
      // would draw a note under the roster's `'You'` fallback — a suggestion
      // attributed to an agent that nobody made.
      expect(stampDisplayNameSource('Dorian', null, CONFIG_DOOR)).toBeNull();
      expect(stampDisplayNameSource('Dorian', null, DORKBOT)).toBeNull();
    });
  });
});

describe('OPERATOR_SAVE_SOURCE', () => {
  it('is the operator, unconditionally — the one door that can name a person', () => {
    // Deliberately NOT a branch of the function above: it depends on neither the
    // value nor what was stored before, because `PATCH /api/profile` is the only
    // door that refuses agents. Re-saving an unchanged name is how somebody who
    // LIKES the agent's suggestion dismisses the note about it.
    expect(OPERATOR_SAVE_SOURCE).toEqual({ kind: 'operator' });
  });

  it('cannot be mutated by whoever imports it', () => {
    // One shared object reaches every save, so a caller that edited it in place
    // would rewrite the rule for every later request in the process.
    expect(Object.isFrozen(OPERATOR_SAVE_SOURCE)).toBe(true);
  });
});
