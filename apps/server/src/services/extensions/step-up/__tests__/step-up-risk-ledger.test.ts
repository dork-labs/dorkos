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
});
