/**
 * The rule that decides who a stored display name is attributed to (DOR-1022).
 *
 * Four decisions live here, and each of them is a product answer rather than a
 * mechanical one: a person re-saving an unchanged name still counts as claiming
 * it, an agent re-sending an unchanged name does NOT count as suggesting it,
 * clearing the name clears the record, and an agent this install cannot identify
 * still gets a hint drawn for it. Every one of them is asserted below in a form
 * that goes red if the rule is inverted.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { stampDisplayNameSource } from '../display-name-provenance.js';

const DORKBOT = { kind: 'agent', agentName: 'DorkBot' } as const;
const PERSON = { kind: 'operator' } as const;

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
      // otherwise raise the hint on a value that never actually moved.
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
      expect(stampDisplayNameSource(null, 'Dorian', { kind: 'agent', agentName: '​' })).toEqual({
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
  });

  describe('when a person writes', () => {
    it('records the operator', () => {
      expect(stampDisplayNameSource(null, 'Dorian', PERSON)).toEqual({ kind: 'operator' });
    });

    it('records the operator even when the name does not change', () => {
      // This is the ONLY way a "Suggested by DorkBot" hint is dismissed: the
      // person opens Settings › Profile, sees the name they are happy with, and
      // presses Save. Gate the stamp on a value change and the hint is
      // permanent for anybody who likes what the agent picked.
      expect(stampDisplayNameSource('Dorian', 'Dorian', PERSON)).toEqual({ kind: 'operator' });
    });
  });

  describe('when the name is cleared', () => {
    it('clears the record with it, whoever cleared it', () => {
      // No name, no provenance. A leftover `agent` stamp beside a `null` name
      // would draw a hint under the roster's `'You'` fallback — a suggestion
      // attributed to an agent that nobody made.
      expect(stampDisplayNameSource('Dorian', null, PERSON)).toBeNull();
      expect(stampDisplayNameSource('Dorian', null, DORKBOT)).toBeNull();
    });
  });
});
