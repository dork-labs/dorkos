/**
 * Proof that the conformance suite's presence gate can FAIL.
 *
 * The suite only ever runs against runtimes that are supposed to pass, so a
 * green conformance run is no evidence the presence assertions fired at all.
 * These tests drive the same predicate the suite calls
 * ({@link validatePresenceReport}) with deliberately-fabricated readings — an
 * idle session that claims to be working, a turn claimed with nothing to show,
 * a session that borrows a directory it is not bound to — and assert each one
 * is rejected.
 *
 * The honest-absence cases are here too, and they matter just as much: a
 * runtime that cannot observe its own running state must be able to say so and
 * pass, or the suite would push adapters into inventing a value.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PresenceObservation } from '../runtime-conformance.js';
import { validatePresenceReport } from '../runtime-conformance.js';

/** A truthful reading, as the honest runtimes report it, for one-field overrides. */
function reading(overrides: Partial<PresenceObservation> = {}): PresenceObservation {
  return {
    phase: 'never-run',
    lifecycle: 'idle',
    inProgressTurn: null,
    boundTo: '/projects/conformance',
    reportedBinding: '/projects/conformance',
    ...overrides,
  };
}

describe('validatePresenceReport', () => {
  describe('accepts the truthful readings', () => {
    it('an untouched session: idle, no turn, the binding it was given', () => {
      expect(validatePresenceReport(reading())).toEqual([]);
    });

    it('a live turn reported as running, with the turn to show for it', () => {
      expect(
        validatePresenceReport(
          reading({ phase: 'mid-turn', lifecycle: 'streaming', inProgressTurn: [{ seq: 0 }] })
        )
      ).toEqual([]);
    });

    it('a turn that stopped to ask, still holding its live turn', () => {
      // `blocked` mid-turn with a NON-NULL turn is what the projector actually
      // produces the moment an approval opens: the turn is still open, nobody
      // is working. Requiring a null turn from anything that is not
      // `streaming` would false-red an honest runtime.
      expect(
        validatePresenceReport(
          reading({ phase: 'mid-turn', lifecycle: 'blocked', inProgressTurn: [{ seq: 2 }] })
        )
      ).toEqual([]);
    });

    it('a live turn a runtime cannot observe — absence, not invention', () => {
      // The honest degradation path: a runtime whose turns are projected
      // elsewhere reports `idle` with no turn mid-flight and passes.
      expect(
        validatePresenceReport(
          reading({ phase: 'mid-turn', lifecycle: 'idle', inProgressTurn: null })
        )
      ).toEqual([]);
    });

    it('a session whose binding the runtime cannot say', () => {
      expect(validatePresenceReport(reading({ reportedBinding: undefined }))).toEqual([]);
    });

    it('a session the runtime does not report at all', () => {
      expect(validatePresenceReport(reading({ reportedBinding: null }))).toEqual([]);
    });

    it('a settled turn: blocked on a person, or ended in error', () => {
      for (const lifecycle of ['blocked', 'error', 'interrupted']) {
        expect(validatePresenceReport(reading({ phase: 'after-turn', lifecycle }))).toEqual([]);
      }
    });

    it('an idle session still holding events (a sign-in card outliving its turn)', () => {
      // The reverse implication deliberately does NOT hold: events with no turn
      // running is a real, honest state (DOR-1004).
      expect(
        validatePresenceReport(
          reading({ phase: 'after-turn', lifecycle: 'idle', inProgressTurn: [{ seq: 4 }] })
        )
      ).toEqual([]);
    });
  });

  describe('rejects the fabrications', () => {
    it('an untouched session reported as working', () => {
      const failures = validatePresenceReport(
        reading({ lifecycle: 'streaming', inProgressTurn: [{ seq: 0 }] })
      );
      // Two lies in one reading: the state, and the turn it shows for it.
      expect(failures).toHaveLength(2);
      expect(failures[0]).toContain("must report 'idle'");
    });

    it('an untouched session already showing a turn', () => {
      const failures = validatePresenceReport(reading({ inProgressTurn: [{ seq: 0 }] }));
      expect(failures).toEqual([
        'a session that has never run a turn must show no in-progress turn',
      ]);
    });

    it('a working claim with no turn to show', () => {
      const failures = validatePresenceReport(
        reading({ phase: 'mid-turn', lifecycle: 'streaming', inProgressTurn: null })
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('no in-progress turn to show');
    });

    it('a working claim backed by an EMPTY turn — absence in the shape of presence', () => {
      // The boundary `Array.isArray` alone would wave through. The real
      // projector cannot produce it: `turn_start` opens the turn with its own
      // event and `turn_end` nulls it, so `[]` is a hand-built claim with
      // nothing in it.
      const failures = validatePresenceReport(
        reading({ phase: 'mid-turn', lifecycle: 'streaming', inProgressTurn: [] })
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('no in-progress turn to show');
    });

    it('an untouched session showing an empty turn rather than none', () => {
      const failures = validatePresenceReport(reading({ inProgressTurn: [] }));
      expect(failures).toEqual([
        'a session that has never run a turn must show no in-progress turn',
      ]);
    });

    it('a session still reported as working after its turn terminated', () => {
      const failures = validatePresenceReport(
        reading({ phase: 'after-turn', lifecycle: 'streaming', inProgressTurn: [{ seq: 1 }] })
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('still reports');
    });

    it('a lifecycle nothing downstream can read', () => {
      const failures = validatePresenceReport(reading({ phase: 'mid-turn', lifecycle: 'busy' }));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('not a SessionLifecycle');
    });

    it('an in-progress turn that is neither events nor absence', () => {
      const failures = validatePresenceReport(
        reading({ phase: 'mid-turn', inProgressTurn: undefined })
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('must be an array of events or null');
    });

    it('a session reported under a directory it is not bound to', () => {
      const failures = validatePresenceReport(reading({ reportedBinding: '/projects/elsewhere' }));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("bound to '/projects/conformance'");
    });

    it('a session bound to nothing that borrows a binding', () => {
      const failures = validatePresenceReport(
        reading({ boundTo: undefined, reportedBinding: '/projects/conformance' })
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('created bound to nothing');
    });

    it('a binding that is not a directory at all', () => {
      const failures = validatePresenceReport(reading({ reportedBinding: 42 }));
      expect(failures).toEqual([
        "the reported binding must be a directory string or absent, not '42'",
      ]);
    });

    it('reports every violation in one reading, not just the first', () => {
      const failures = validatePresenceReport(
        reading({
          phase: 'after-turn',
          lifecycle: 'streaming',
          inProgressTurn: null,
          reportedBinding: '/projects/elsewhere',
        })
      );
      expect(failures).toHaveLength(3);
    });
  });

  describe('the same directory reached by two paths', () => {
    // The regression that stopped the live OpenCode arm (2026-09-11): a real
    // sidecar reports the cwd it resolved, and on macOS that is
    // `/private/var/folders/...` for a session created under `/var/folders/...`.
    // Nothing was fabricated — the two strings name one directory — so the
    // comparison has to collapse both sides before it decides.
    let root: string;
    let target: string;
    let link: string;
    let sibling: string;

    beforeAll(() => {
      root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-presence-')));
      target = path.join(root, 'target');
      link = path.join(root, 'link');
      sibling = path.join(root, 'sibling');
      fs.mkdirSync(target);
      fs.mkdirSync(sibling);
      fs.symlinkSync(target, link);
    });

    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('accepts a binding reported through a symlink to the directory it was bound to', () => {
      expect(validatePresenceReport(reading({ boundTo: link, reportedBinding: target }))).toEqual(
        []
      );
      // And the other direction: bound through the real path, reported through
      // the link.
      expect(validatePresenceReport(reading({ boundTo: target, reportedBinding: link }))).toEqual(
        []
      );
    });

    it("accepts the unresolved/resolved tmpdir pair the suite's own live arm produces", () => {
      // On macOS these two strings differ (`/var/...` vs `/private/var/...`);
      // on Linux they are already equal. Either way the honest answer is the
      // same, which is the point.
      const unresolved = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-presence-live-'));
      try {
        const resolved = fs.realpathSync.native(unresolved);
        expect(
          validatePresenceReport(reading({ boundTo: unresolved, reportedBinding: resolved }))
        ).toEqual([]);
      } finally {
        fs.rmSync(unresolved, { recursive: true, force: true });
      }
    });

    it('still rejects a real directory that is genuinely not the one it was bound to', () => {
      // Both paths exist and both resolve, so this is the case the normalization
      // could have quietly waved through. It must not.
      const failures = validatePresenceReport(
        reading({ boundTo: target, reportedBinding: sibling })
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain(`bound to '${target}'`);
    });

    it('still rejects two paths that exist nowhere and name different places', () => {
      // The fallback path: neither resolves, so each collapses to itself and the
      // comparison is the raw one it always was. Every other case in this file
      // relies on that.
      const failures = validatePresenceReport(
        reading({ boundTo: '/nowhere/one', reportedBinding: '/nowhere/two' })
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("bound to '/nowhere/one'");
    });
  });
});
