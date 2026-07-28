/**
 * Every setting a built-in adapter declares is reachable in the setup wizard.
 *
 * A manifest declares its settings twice: once in `configFields` (what the
 * adapter reads) and once across `setupSteps[].fields` (what each wizard screen
 * names). When the two disagreed, the wizard dropped the difference and the
 * setting became unreachable — that is how Slack shipped a DM policy and both
 * adapters shipped an approver list nobody could see or change (DOR-640).
 *
 * `setupStepFields` now puts unnamed fields on the last step, so the disagreement
 * is no longer fatal.
 *
 * ## What each test can actually catch
 *
 * They do not all guard the same thing, and it matters which is which:
 *
 * - **`shows every declared config field on some step` guards the
 *   implementation, not the manifests.** Because `setupStepFields` appends
 *   unclaimed fields by construction, adding a brand-new orphan field to a
 *   manifest leaves it green — verified by seeding exactly that. It reddens when
 *   the rule stops covering every field, which is the regression that would
 *   bring the defect back.
 * - **`shows no field on two different steps` and `names no field that does not
 *   exist` guard the manifests.** Seeding a duplicate key and a nonexistent step
 *   key reddens them. A dangling key is the live hazard: it renders nothing at
 *   all, silently.
 *
 * The rendering half — that a field the rule selects actually reaches the screen
 * — is covered in the client's wizard tests and in a real browser in
 * `apps/e2e/tests/relay/adapter-wizard-fields.spec.ts`.
 *
 * @module relay/adapters/wizard-field-coverage
 */
import { describe, it, expect } from 'vitest';
import { setupStepFields } from '@dorkos/shared/relay-schemas';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { TELEGRAM_MANIFEST } from '../telegram/telegram-adapter.js';
import { SLACK_MANIFEST } from '../slack/slack-manifest.js';
import { WEBHOOK_MANIFEST } from '../webhook/webhook-adapter.js';
import { CLAUDE_CODE_MANIFEST } from '../claude-code/claude-code-adapter.js';
import { TEST_MODE_MANIFEST } from '../test-mode/test-mode-relay-adapter.js';

const BUILT_IN_MANIFESTS: Array<[string, AdapterManifest]> = [
  ['telegram', TELEGRAM_MANIFEST],
  ['slack', SLACK_MANIFEST],
  ['webhook', WEBHOOK_MANIFEST],
  ['claude-code', CLAUDE_CODE_MANIFEST],
  ['test-mode', TEST_MODE_MANIFEST],
];

/** Field keys the wizard renders, in order, across every one of a manifest's steps. */
function keysShownAcrossSteps(manifest: AdapterManifest): string[] {
  const stepCount = manifest.setupSteps?.length ?? 0;
  if (stepCount === 0) return setupStepFields(manifest, 0).map((field) => field.key);
  return Array.from({ length: stepCount }, (_, index) => index).flatMap((index) =>
    setupStepFields(manifest, index).map((field) => field.key)
  );
}

describe.each(BUILT_IN_MANIFESTS)('%s adapter manifest', (_name, manifest) => {
  it('shows every declared config field on some step', () => {
    const shown = new Set(keysShownAcrossSteps(manifest));
    const unreachable = manifest.configFields
      .map((field) => field.key)
      .filter((key) => !shown.has(key));

    expect(unreachable).toEqual([]);
  });

  it('shows no field on two different steps', () => {
    const shown = keysShownAcrossSteps(manifest);
    const duplicated = shown.filter((key, index) => shown.indexOf(key) !== index);

    expect(duplicated).toEqual([]);
  });

  it('names no field that does not exist', () => {
    const declared = new Set(manifest.configFields.map((field) => field.key));
    const dangling = (manifest.setupSteps ?? [])
      .flatMap((step) => step.fields)
      .filter((key) => !declared.has(key));

    expect(dangling).toEqual([]);
  });
});
