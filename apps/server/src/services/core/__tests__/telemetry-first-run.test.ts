/**
 * Tests for the Tier 1 first-run boot decision + notice (ADR 260713-143958).
 *
 * The load-bearing guarantee (Homebrew ordering): the boot that first shows the
 * notice sends nothing, and a subsequent boot sends. We prove it at the decision
 * layer — `decideTier1Boot` captures the send gate from the PRE-notice snapshot,
 * then reports that the notice must be shown and `lastPromptedVersion` advanced;
 * applying that write yields a second snapshot whose gate is open.
 */
import { describe, it, expect } from 'vitest';
import {
  decideTier1Boot,
  formatFirstRunTelemetryNotice,
  TELEMETRY_PAYLOAD_DOC_URL,
} from '../telemetry-first-run.js';

const VERSION = '0.47.0';

describe('decideTier1Boot — ordering', () => {
  it('first-notice boot: gate closed (nothing sends), notice shown, version recorded', () => {
    const firstBoot = { userHasDecided: false, lastPromptedVersion: null };

    const decision = decideTier1Boot(firstBoot, VERSION);

    // Nothing may send on the boot that first shows the notice.
    expect(decision.sendGate).toBe(false);
    expect(decision.showNotice).toBe(true);
    expect(decision.lastPromptedVersionToWrite).toBe(VERSION);
  });

  it('subsequent boot (after the notice recorded lastPromptedVersion): gate open, no notice', () => {
    // Simulate applying the first boot's write to the persisted config.
    const secondBoot = { userHasDecided: false, lastPromptedVersion: VERSION };

    const decision = decideTier1Boot(secondBoot, VERSION);

    // Now sends are allowed and the notice does not reappear.
    expect(decision.sendGate).toBe(true);
    expect(decision.showNotice).toBe(false);
    expect(decision.lastPromptedVersionToWrite).toBeNull();
  });

  it('end-to-end two-boot sequence: first sends nothing, second sends', () => {
    let telemetry: { userHasDecided: boolean; lastPromptedVersion: string | null } = {
      userHasDecided: false,
      lastPromptedVersion: null,
    };

    // Boot 1: capture the gate, then apply the notice write.
    const boot1 = decideTier1Boot(telemetry, VERSION);
    expect(boot1.sendGate).toBe(false);
    if (boot1.showNotice) {
      telemetry = { ...telemetry, lastPromptedVersion: boot1.lastPromptedVersionToWrite };
    }

    // Boot 2: the persisted write from boot 1 opens the gate.
    const boot2 = decideTier1Boot(telemetry, VERSION);
    expect(boot2.sendGate).toBe(true);
    expect(boot2.showNotice).toBe(false);
  });

  it('an explicit prior choice opens the gate immediately, with no notice', () => {
    const decided = { userHasDecided: true, lastPromptedVersion: null };

    const decision = decideTier1Boot(decided, VERSION);

    expect(decision.sendGate).toBe(true);
    expect(decision.showNotice).toBe(false);
  });

  it('treats a missing telemetry snapshot as a first-notice boot', () => {
    const decision = decideTier1Boot(undefined, VERSION);
    expect(decision.sendGate).toBe(false);
    expect(decision.showNotice).toBe(true);
  });
});

describe('formatFirstRunTelemetryNotice', () => {
  it('states what is shared and every opt-out mechanism', () => {
    const notice = formatFirstRunTelemetryNotice();

    expect(notice).toContain('daily anonymous heartbeat');
    expect(notice).toContain('marketplace install counts');
    expect(notice).toContain('feature-usage events');
    expect(notice).toContain(TELEMETRY_PAYLOAD_DOC_URL);
    // All three documented opt-outs.
    expect(notice).toContain('dorkos telemetry disable');
    expect(notice).toContain('DO_NOT_TRACK=1');
    expect(notice).toContain('Privacy & Data');
    // Honest about the ordering: nothing sends on this first run.
    expect(notice).toMatch(/nothing is sent on this first run/i);
  });

  it('never uses an em dash (writing-for-humans)', () => {
    expect(formatFirstRunTelemetryNotice()).not.toContain('—');
  });
});
