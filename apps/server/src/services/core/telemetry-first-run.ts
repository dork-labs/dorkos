/**
 * First-run Tier 1 telemetry notice + boot ordering (ADR 260713-143958, Phase 2).
 *
 * The Tier 1 channels (heartbeat + install) are anonymous and opt-out by
 * default, but they may only start sending **after** a first-run notice has been
 * shown — the Homebrew ordering rule. This module owns two pure pieces so the
 * boot sequence in `index.ts` stays thin and the ordering is unit-testable:
 *
 * 1. {@link decideTier1Boot} — given the telemetry consent snapshot read at
 *    startup, decides whether Tier 1 senders may fire on THIS boot (the
 *    snapshotted gate) and whether to print the notice + advance
 *    `lastPromptedVersion`. The gate is captured from the pre-notice snapshot,
 *    so the boot that first shows the notice sends nothing; Tier 1 sends begin
 *    on the next boot at the earliest.
 * 2. {@link formatFirstRunTelemetryNotice} — the plain-language notice text
 *    (what we share, the payload doc link, and every opt-out).
 *
 * @module services/core/telemetry-first-run
 */

import { hasTier1SendGate, type Tier1GateConfig } from '@dorkos/shared/telemetry-consent';

/** The public payload documentation URL shown in the first-run notice. */
export const TELEMETRY_PAYLOAD_DOC_URL = 'https://dorkos.ai/telemetry';

/** The outcome of evaluating the Tier 1 first-run gate at server boot. */
export interface Tier1BootDecision {
  /**
   * Whether the Tier 1 senders (heartbeat + install) may fire on THIS boot.
   * Captured from the pre-notice consent snapshot, so it is `false` on the boot
   * that first shows the notice and only becomes `true` once the user has
   * decided or the notice has already been recorded.
   */
  sendGate: boolean;
  /** Whether to print the first-run notice on this boot. */
  showNotice: boolean;
  /**
   * The value to persist to `telemetry.lastPromptedVersion` after the notice is
   * shown, or `null` to leave it unchanged (notice not shown this boot).
   */
  lastPromptedVersionToWrite: string | null;
}

/**
 * Decide the Tier 1 boot behavior from the telemetry consent snapshot.
 *
 * `sendGate` is `hasTier1SendGate(telemetry)` evaluated on the pre-notice
 * snapshot — the load-bearing ordering guarantee. `showNotice` fires exactly
 * when the gate is closed (never answered AND never prompted), which is the one
 * case where a notice must be shown before anything can send. When the notice
 * fires, `lastPromptedVersionToWrite` is the current version so the NEXT boot's
 * gate is open.
 *
 * @param telemetry - The `config.telemetry` snapshot read once at startup.
 * @param currentVersion - The running DorkOS version to record when prompting.
 */
export function decideTier1Boot(
  telemetry: Tier1GateConfig | undefined | null,
  currentVersion: string
): Tier1BootDecision {
  const sendGate = hasTier1SendGate(telemetry);
  const showNotice = !sendGate;
  return {
    sendGate,
    showNotice,
    lastPromptedVersionToWrite: showNotice ? currentVersion : null,
  };
}

/**
 * The plain-language first-run telemetry notice, printed to the server log the
 * first time DorkOS starts without a recorded choice. It states exactly what the
 * Tier 1 channels share, links the full payload, and lists every way to turn it
 * off. Kept honest and calm — no dark patterns, opting out is as easy as reading
 * this.
 */
export function formatFirstRunTelemetryNotice(): string {
  return [
    'DorkOS shares a little anonymous data by default so we can see how many people',
    'are running it. Two things leave your machine:',
    '',
    '  - a daily anonymous heartbeat (a random install id, the version, your OS and',
    '    chip type, which runtimes you have on, and rough counts)',
    '  - anonymous marketplace install counts',
    '',
    'That is all. No prompts, no code, no file paths, no session content, ever.',
    `See the exact payload, word for word: ${TELEMETRY_PAYLOAD_DOC_URL}`,
    '',
    'Turn it off any time, three ways:',
    '  - run: dorkos telemetry disable',
    '  - set the environment variable DO_NOT_TRACK=1',
    '  - open Settings and use the Privacy & Data tab',
    '',
    'Nothing is sent on this first run. If you do nothing, sharing begins next launch.',
  ].join('\n');
}
