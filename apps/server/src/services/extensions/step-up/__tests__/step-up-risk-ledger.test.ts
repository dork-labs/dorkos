/** The ledger that keeps a browser refused once a risky mini app ran in it (M1 on #3401). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StepUpRiskLedger } from '../step-up-risk-ledger.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-ledger-'));
  file = path.join(dir, 'step-up', 'risk-ledger.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('StepUpRiskLedger', () => {
  it('blocks nobody until a risk was ever seen', () => {
    const ledger = new StepUpRiskLedger();
    ledger.note(0, 1_000);
    expect(ledger.mayHoldRiskyCode(500)).toBe(false);
    expect(ledger.mayHoldRiskyCode(null)).toBe(false);
  });

  it('blocks every browser while a risk is present', () => {
    const ledger = new StepUpRiskLedger();
    ledger.note(1, 1_000);
    expect(ledger.mayHoldRiskyCode(5_000)).toBe(true);
  });

  it('after a risk clears, blocks a browser signed in before then, and lets a later one through', () => {
    const ledger = new StepUpRiskLedger();
    ledger.note(1, 1_000);
    ledger.note(0, 2_000);
    expect(ledger.mayHoldRiskyCode(1_500)).toBe(true);
    expect(ledger.mayHoldRiskyCode(2_000)).toBe(true);
    expect(ledger.mayHoldRiskyCode(null)).toBe(true);
    expect(ledger.mayHoldRiskyCode(2_001)).toBe(false);
  });

  it('a second clear moves the line forward; a clean reading never moves it back', () => {
    const ledger = new StepUpRiskLedger();
    ledger.note(1, 1_000);
    ledger.note(0, 2_000);
    ledger.note(0, 3_000);
    expect(ledger.mayHoldRiskyCode(2_500)).toBe(false);
    ledger.note(2, 4_000);
    ledger.note(0, 5_000);
    expect(ledger.mayHoldRiskyCode(2_500)).toBe(true);
    expect(ledger.mayHoldRiskyCode(5_001)).toBe(false);
  });

  it('remembers a cleared risk across a restart', () => {
    const before = new StepUpRiskLedger(file);
    before.note(1, 1_000);
    before.note(0, 2_000);
    const after = new StepUpRiskLedger(file);
    expect(after.mayHoldRiskyCode(1_500)).toBe(true);
    expect(after.mayHoldRiskyCode(2_500)).toBe(false);
  });

  it('remembers a risk still present across a restart', () => {
    new StepUpRiskLedger(file).note(1, 1_000);
    expect(new StepUpRiskLedger(file).mayHoldRiskyCode(9_000)).toBe(true);
  });

  it('fails closed on a ledger it cannot read, until a clean reading', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const ledger = new StepUpRiskLedger(file);
    expect(ledger.mayHoldRiskyCode(9_000)).toBe(true);
    ledger.note(0, 10_000);
    expect(ledger.mayHoldRiskyCode(9_000)).toBe(true);
    expect(ledger.mayHoldRiskyCode(10_001)).toBe(false);
  });

  describe('readings taken before a bundle is served (DOR-4906)', () => {
    it('keeps a serve-time risk across a restart, so a tab from before it still re-signs in', () => {
      // A risky bundle was served at 1_000 and later held, then DorkOS restarted.
      const before = new StepUpRiskLedger(file, 500);
      expect(before.note(1, 1_000)).toBe(true);
      expect(before.note(0, 2_000)).toBe(true);
      const after = new StepUpRiskLedger(file, 3_000);
      expect(after.mayHoldRiskyCode(1_500)).toBe(true);
      expect(after.mayHoldRiskyCode(2_500)).toBe(false);
    });

    it('treats a ledger from before serve-time readings as cleared when it opens', () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ present: false, clearedAt: null }));
      const ledger = new StepUpRiskLedger(file, 7_000);
      // A tab opened before this version may hold code no reading saw.
      expect(ledger.mayHoldRiskyCode(6_000)).toBe(true);
      expect(ledger.mayHoldRiskyCode(null)).toBe(true);
      expect(ledger.mayHoldRiskyCode(7_001)).toBe(false);
      // Marked once: the next opening does not move the line.
      expect(new StepUpRiskLedger(file, 9_000).mayHoldRiskyCode(8_000)).toBe(false);
    });

    it('keeps a risk still present in an old ledger present', () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ present: true, clearedAt: null }));
      expect(new StepUpRiskLedger(file, 7_000).mayHoldRiskyCode(9_000)).toBe(true);
    });

    it('says a reading was not kept when the disk refuses it, and still fails closed', () => {
      const ledger = new StepUpRiskLedger(file, 500);
      // The folder the ledger lives in becomes a file: every write now fails.
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.writeFileSync(path.dirname(file), 'not a folder');
      expect(ledger.note(1, 1_000)).toBe(false);
      expect(ledger.mayHoldRiskyCode(5_000)).toBe(true);
    });

    it('needs no write for a reading that changes nothing', () => {
      const ledger = new StepUpRiskLedger(file, 500);
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.writeFileSync(path.dirname(file), 'not a folder');
      expect(ledger.note(0, 1_000)).toBe(true);
    });
  });
});
