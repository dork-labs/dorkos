import { describe, it, expect } from 'vitest';
import { EvidenceSchema } from '../config-schema.js';
import {
  selectEvidence,
  type EvidenceConfig,
  type EvidenceKind,
  type EvidenceTrigger,
} from '../evidence.js';

/** The §9 resolved default evidence config — the oracle the spec ships. */
const DEFAULT_EVIDENCE: EvidenceConfig = EvidenceSchema.parse({});

/** Build a trigger with an overridable live-session flag (default interactive). */
function trigger(liveSession = true): EvidenceTrigger {
  return { liveSession };
}

describe('selectEvidence — UI class format resolution (§13)', () => {
  it('ui:"auto" + interactive (live session) → annotated GIF via gif_creator', () => {
    const plan = selectEvidence('ui', trigger(true), DEFAULT_EVIDENCE);
    expect(plan.capture).toBe('annotated-gif');
    expect(plan.tool).toBe('gif_creator');
  });

  it('ui:"auto" + unattended (no live session, e.g. Pulse tick) → WebM via recordVideo', () => {
    const plan = selectEvidence('ui', trigger(false), DEFAULT_EVIDENCE);
    expect(plan.capture).toBe('webm');
    expect(plan.tool).toBe('recordVideo');
  });

  it('ui:"screenshot" pins a still regardless of trigger', () => {
    const cfg: EvidenceConfig = { ...DEFAULT_EVIDENCE, ui: 'screenshot' };
    for (const live of [true, false]) {
      const plan = selectEvidence('ui', trigger(live), cfg);
      expect(plan.capture).toBe('screenshot');
      expect(plan.tool).toBe('screenshot');
    }
  });

  it('ui:"off" captures nothing and attaches nothing', () => {
    const cfg: EvidenceConfig = { ...DEFAULT_EVIDENCE, ui: 'off' };
    const plan = selectEvidence('ui', trigger(true), cfg);
    expect(plan.capture).toBe('none');
    expect(plan.tool).toBe('none');
    expect(plan.attachTo).toEqual([]);
  });
});

describe('selectEvidence — temporal class (§13): motion regardless of trigger', () => {
  it('temporal:"video" (default) → WebM via recordVideo even in an interactive run', () => {
    const plan = selectEvidence('temporal', trigger(true), DEFAULT_EVIDENCE);
    expect(plan.capture).toBe('webm');
    expect(plan.tool).toBe('recordVideo');
  });

  it('temporal does NOT key off the trigger — unattended still yields WebM', () => {
    const plan = selectEvidence('temporal', trigger(false), DEFAULT_EVIDENCE);
    expect(plan.capture).toBe('webm');
  });

  it('temporal:"gif" forces the annotated gif_creator capture', () => {
    const cfg: EvidenceConfig = { ...DEFAULT_EVIDENCE, temporal: 'gif' };
    const plan = selectEvidence('temporal', trigger(false), cfg);
    expect(plan.capture).toBe('annotated-gif');
    expect(plan.tool).toBe('gif_creator');
  });

  it('temporal:"off" captures nothing', () => {
    const cfg: EvidenceConfig = { ...DEFAULT_EVIDENCE, temporal: 'off' };
    const plan = selectEvidence('temporal', trigger(true), cfg);
    expect(plan.capture).toBe('none');
    expect(plan.attachTo).toEqual([]);
  });
});

describe('selectEvidence — logic class (§13): the verification-gate summary', () => {
  it('logic:"test-summary" (default) → the test-pass summary, no browser', () => {
    const plan = selectEvidence('logic', trigger(true), DEFAULT_EVIDENCE);
    expect(plan.capture).toBe('test-summary');
    expect(plan.tool).toBe('verification-gate');
  });

  it('logic:"full-output" attaches the raw verification output', () => {
    const cfg: EvidenceConfig = { ...DEFAULT_EVIDENCE, logic: 'full-output' };
    const plan = selectEvidence('logic', trigger(false), cfg);
    expect(plan.capture).toBe('full-output');
    expect(plan.tool).toBe('verification-gate');
  });

  it('logic:"off" captures nothing', () => {
    const cfg: EvidenceConfig = { ...DEFAULT_EVIDENCE, logic: 'off' };
    const plan = selectEvidence('logic', trigger(true), cfg);
    expect(plan.capture).toBe('none');
    expect(plan.attachTo).toEqual([]);
  });
});

describe('selectEvidence — attach targets echo evidence.attachTo (§13)', () => {
  it('default attachTo is ["pr","tracker"] for a real capture', () => {
    const plan = selectEvidence('ui', trigger(false), DEFAULT_EVIDENCE);
    expect(plan.attachTo).toEqual(['pr', 'tracker']);
  });

  it('attachTo:["pr"] only → bundle goes to the PR comment alone', () => {
    const cfg: EvidenceConfig = { ...DEFAULT_EVIDENCE, attachTo: ['pr'] };
    const plan = selectEvidence('ui', trigger(false), cfg);
    expect(plan.attachTo).toEqual(['pr']);
  });

  it('attachTo:["tracker"] only → bundle goes to the tracker externalUrls alone', () => {
    const cfg: EvidenceConfig = { ...DEFAULT_EVIDENCE, attachTo: ['tracker'] };
    const plan = selectEvidence('logic', trigger(true), cfg);
    expect(plan.attachTo).toEqual(['tracker']);
  });

  it('a "none" capture clears attachTo even when targets are configured', () => {
    const cfg: EvidenceConfig = { ...DEFAULT_EVIDENCE, ui: 'off', attachTo: ['pr', 'tracker'] };
    const plan = selectEvidence('ui', trigger(false), cfg);
    expect(plan.capture).toBe('none');
    expect(plan.attachTo).toEqual([]);
  });

  it('returns a fresh attachTo array — never aliases the config array', () => {
    const plan = selectEvidence('ui', trigger(false), DEFAULT_EVIDENCE);
    expect(plan.attachTo).not.toBe(DEFAULT_EVIDENCE.attachTo);
    plan.attachTo.push('pr');
    expect(DEFAULT_EVIDENCE.attachTo).toEqual(['pr', 'tracker']);
  });
});

describe('selectEvidence — the kind × trigger matrix (§13)', () => {
  const cases: Array<{
    kind: EvidenceKind;
    liveSession: boolean;
    capture: string;
    tool: string;
  }> = [
    { kind: 'ui', liveSession: true, capture: 'annotated-gif', tool: 'gif_creator' },
    { kind: 'ui', liveSession: false, capture: 'webm', tool: 'recordVideo' },
    { kind: 'temporal', liveSession: true, capture: 'webm', tool: 'recordVideo' },
    { kind: 'temporal', liveSession: false, capture: 'webm', tool: 'recordVideo' },
    { kind: 'logic', liveSession: true, capture: 'test-summary', tool: 'verification-gate' },
    { kind: 'logic', liveSession: false, capture: 'test-summary', tool: 'verification-gate' },
  ];

  it.each(cases)(
    '$kind + liveSession=$liveSession → $capture ($tool)',
    ({ kind, liveSession, capture, tool }) => {
      const plan = selectEvidence(kind, trigger(liveSession), DEFAULT_EVIDENCE);
      expect(plan.kind).toBe(kind);
      expect(plan.capture).toBe(capture);
      expect(plan.tool).toBe(tool);
    }
  );
});
