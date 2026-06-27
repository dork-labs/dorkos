import { describe, it, expect } from 'vitest';
import { CalibrationSchema } from '../config-schema.js';
import {
  resolveInvolvement,
  CalibrationRow,
  type Calibration,
  type DecisionDescriptor,
  type DecisionStage,
  type Reversibility,
  type Confidence,
  type FloorTrigger,
  type InvolvementBehavior,
} from '../calibration.js';

/** The §9 resolved default calibration config — the oracle the spec ships. */
const DEFAULT_CALIBRATION: Calibration = CalibrationSchema.parse({});

const STAGES: readonly DecisionStage[] = ['intake', 'execution'];
const REVERSIBILITIES: readonly Reversibility[] = ['reversible', 'sticky'];
const CONFIDENCES: readonly Confidence[] = ['confident', 'not-confident'];
const ALL_FLOOR_TRIGGERS: readonly FloorTrigger[] = [
  'irreversible-or-destructive',
  'outward-facing',
  'secrets-or-spend',
  'scope-change',
];

interface Expectation {
  behavior: InvolvementBehavior;
  blocks: boolean;
  row: CalibrationRow;
}

/**
 * The full non-floor matrix as the §5 ladder pins it. Keyed by
 * `${reversibility}|${confidence}|${stage}` so every one of the
 * 2 × 2 × 2 = 8 combinations is asserted explicitly.
 */
const NON_FLOOR_MATRIX: Record<string, Expectation> = {
  // Row 1 — reversible + confident → proceed silently (stage-independent).
  'reversible|confident|intake': {
    behavior: 'proceed-silently',
    blocks: false,
    row: CalibrationRow.ReversibleConfident,
  },
  'reversible|confident|execution': {
    behavior: 'proceed-silently',
    blocks: false,
    row: CalibrationRow.ReversibleConfident,
  },
  // Row 4 — sticky + confident → proceed with trail (stage-independent).
  'sticky|confident|intake': {
    behavior: 'proceed-with-trail',
    blocks: false,
    row: CalibrationRow.StickyConfident,
  },
  'sticky|confident|execution': {
    behavior: 'proceed-with-trail',
    blocks: false,
    row: CalibrationRow.StickyConfident,
  },
  // Row 2 — sticky + not-confident → stop & ask (stage-independent).
  'sticky|not-confident|intake': {
    behavior: 'stop-and-ask',
    blocks: true,
    row: CalibrationRow.StickyNotConfident,
  },
  'sticky|not-confident|execution': {
    behavior: 'stop-and-ask',
    blocks: true,
    row: CalibrationRow.StickyNotConfident,
  },
  // Row 3 — reversible + not-confident → routed by stage bias.
  'reversible|not-confident|intake': {
    behavior: 'stop-and-ask',
    blocks: true,
    row: CalibrationRow.AmbiguousMiddle,
  },
  'reversible|not-confident|execution': {
    behavior: 'proceed-with-trail',
    blocks: false,
    row: CalibrationRow.AmbiguousMiddle,
  },
};

function descriptor(
  reversibility: Reversibility,
  confidence: Confidence,
  stage: DecisionStage,
  floorTriggers: readonly FloorTrigger[] = []
): DecisionDescriptor {
  return { reversibility, confidence, stage, floorTriggers };
}

describe('resolveInvolvement — the calibration ladder (§5)', () => {
  describe('full non-floor matrix: {reversible|sticky} × {confident|not} × {intake|execution}', () => {
    for (const reversibility of REVERSIBILITIES) {
      for (const confidence of CONFIDENCES) {
        for (const stage of STAGES) {
          const key = `${reversibility}|${confidence}|${stage}`;
          const expected = NON_FLOOR_MATRIX[key];

          it(`${key} → ${expected.behavior} (row ${expected.row}, blocks=${expected.blocks})`, () => {
            const result = resolveInvolvement(
              descriptor(reversibility, confidence, stage),
              DEFAULT_CALIBRATION
            );
            expect(result.behavior).toBe(expected.behavior);
            expect(result.blocks).toBe(expected.blocks);
            expect(result.row).toBe(expected.row);
          });
        }
      }
    }
  });

  describe('row 0 — floor overrides everything (even full confidence + reversible)', () => {
    for (const trigger of ALL_FLOOR_TRIGGERS) {
      for (const reversibility of REVERSIBILITIES) {
        for (const confidence of CONFIDENCES) {
          for (const stage of STAGES) {
            it(`floor[${trigger}] + ${reversibility} + ${confidence} + ${stage} → stop-and-ask (row 0, blocks)`, () => {
              const result = resolveInvolvement(
                descriptor(reversibility, confidence, stage, [trigger]),
                DEFAULT_CALIBRATION
              );
              expect(result.behavior).toBe('stop-and-ask');
              expect(result.blocks).toBe(true);
              expect(result.row).toBe(CalibrationRow.Floor);
              expect(result.logAssumption).toBe(false);
            });
          }
        }
      }
    }

    it('floor + confident + reversible + execution still stops (the strongest non-floor "proceed" path)', () => {
      const result = resolveInvolvement(
        descriptor('reversible', 'confident', 'execution', ['secrets-or-spend']),
        DEFAULT_CALIBRATION
      );
      expect(result.behavior).toBe('stop-and-ask');
      expect(result.blocks).toBe(true);
      expect(result.row).toBe(CalibrationRow.Floor);
    });

    it('multiple floor triggers at once still resolve to the floor row', () => {
      const result = resolveInvolvement(
        descriptor('reversible', 'confident', 'intake', [
          'outward-facing',
          'irreversible-or-destructive',
        ]),
        DEFAULT_CALIBRATION
      );
      expect(result.row).toBe(CalibrationRow.Floor);
      expect(result.blocks).toBe(true);
    });

    it('an empty floorTriggers array does NOT trip the floor', () => {
      const result = resolveInvolvement(
        descriptor('reversible', 'confident', 'execution', []),
        DEFAULT_CALIBRATION
      );
      expect(result.row).toBe(CalibrationRow.ReversibleConfident);
    });

    it('omitting floorTriggers entirely is treated as no floor trigger', () => {
      const result = resolveInvolvement(
        { reversibility: 'reversible', confidence: 'confident', stage: 'execution' },
        DEFAULT_CALIBRATION
      );
      expect(result.row).toBe(CalibrationRow.ReversibleConfident);
      expect(result.behavior).toBe('proceed-silently');
    });
  });

  describe('assumption trail — proceed-with-trail rows log, others do not', () => {
    it('row 4 (sticky + confident) logs an assumption when artifact is enabled', () => {
      const result = resolveInvolvement(
        descriptor('sticky', 'confident', 'execution'),
        DEFAULT_CALIBRATION
      );
      expect(result.behavior).toBe('proceed-with-trail');
      expect(result.logAssumption).toBe(true);
    });

    it('row 3-proceed (reversible + not-confident, execution) logs an assumption', () => {
      const result = resolveInvolvement(
        descriptor('reversible', 'not-confident', 'execution'),
        DEFAULT_CALIBRATION
      );
      expect(result.behavior).toBe('proceed-with-trail');
      expect(result.logAssumption).toBe(true);
    });

    it('row 1 (proceed-silently) never logs an assumption', () => {
      const result = resolveInvolvement(
        descriptor('reversible', 'confident', 'execution'),
        DEFAULT_CALIBRATION
      );
      expect(result.logAssumption).toBe(false);
    });

    it('stop-and-ask rows never log an assumption (they block instead)', () => {
      const result = resolveInvolvement(
        descriptor('sticky', 'not-confident', 'intake'),
        DEFAULT_CALIBRATION
      );
      expect(result.logAssumption).toBe(false);
    });

    it('respects assumptionLog.artifact=false — proceed-with-trail still proceeds but does not log', () => {
      const noArtifact: Calibration = CalibrationSchema.parse({
        assumptionLog: { artifact: false },
      });
      const result = resolveInvolvement(descriptor('sticky', 'confident', 'execution'), noArtifact);
      expect(result.behavior).toBe('proceed-with-trail');
      expect(result.blocks).toBe(false);
      expect(result.logAssumption).toBe(false);
    });
  });

  describe('config drives behavior — re-tuning never touches code', () => {
    it('narrowing alwaysAsk removes a floor trigger', () => {
      // Floor only fires for scope-change; outward-facing no longer trips it.
      const narrowed: Calibration = CalibrationSchema.parse({
        alwaysAsk: ['scope-change'],
      });
      const stillFloors = resolveInvolvement(
        descriptor('reversible', 'confident', 'execution', ['scope-change']),
        narrowed
      );
      expect(stillFloors.row).toBe(CalibrationRow.Floor);

      const noLongerFloors = resolveInvolvement(
        descriptor('reversible', 'confident', 'execution', ['outward-facing']),
        narrowed
      );
      // Falls through to row 1 because outward-facing is not in the narrowed list.
      expect(noLongerFloors.row).toBe(CalibrationRow.ReversibleConfident);
      expect(noLongerFloors.behavior).toBe('proceed-silently');
    });

    it('flipping stageBias.execution to "ask" makes row 3 stop in execution too', () => {
      const askEverywhere: Calibration = CalibrationSchema.parse({
        stageBias: { intake: 'ask', execution: 'ask' },
      });
      const result = resolveInvolvement(
        descriptor('reversible', 'not-confident', 'execution'),
        askEverywhere
      );
      expect(result.behavior).toBe('stop-and-ask');
      expect(result.blocks).toBe(true);
      expect(result.row).toBe(CalibrationRow.AmbiguousMiddle);
    });

    it('flipping stageBias.intake to "proceed-and-log" makes row 3 proceed in intake too', () => {
      const proceedEverywhere: Calibration = CalibrationSchema.parse({
        stageBias: { intake: 'proceed-and-log', execution: 'proceed-and-log' },
      });
      const result = resolveInvolvement(
        descriptor('reversible', 'not-confident', 'intake'),
        proceedEverywhere
      );
      expect(result.behavior).toBe('proceed-with-trail');
      expect(result.blocks).toBe(false);
      expect(result.row).toBe(CalibrationRow.AmbiguousMiddle);
    });

    it('emptying proceedSilentlyWhen disqualifies row 1 — reversible+confident proceeds with trail (row 4 fallthrough)', () => {
      // With neither tag allowed, row 1 cannot match. A reversible+confident
      // decision then falls through rows 2 and 3 (neither matches) to row 4.
      const neverSilent: Calibration = CalibrationSchema.parse({
        proceedSilentlyWhen: [],
      });
      const result = resolveInvolvement(
        descriptor('reversible', 'confident', 'execution'),
        neverSilent
      );
      expect(result.behavior).toBe('proceed-with-trail');
      expect(result.row).toBe(CalibrationRow.StickyConfident);
    });
  });
});
