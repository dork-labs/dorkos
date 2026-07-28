/**
 * Which config fields the adapter setup wizard puts on each of its steps.
 *
 * An adapter manifest declares two lists that can disagree: `configFields` (every
 * setting the adapter reads) and `setupSteps[].fields` (the settings each screen
 * of the wizard names). A field present in the first and missing from the second
 * used to be dropped, which made it unreachable from the UI even though the
 * adapter still read it — including access controls whose defaults nobody could
 * review (DOR-640). These helpers are the single rule both the wizard and the
 * manifest tests agree on: across all steps, every declared field is shown.
 *
 * @module shared/relay-adapter-fields
 */
import type { AdapterManifest, ConfigField } from './relay-adapter-schemas.js';

/**
 * Config fields that no setup step names.
 *
 * Empty when the manifest has no setup steps, because the wizard already shows
 * every field at once in that case — "unclaimed" only means something when there
 * are steps that could have claimed the field.
 *
 * @param manifest - Adapter manifest to inspect.
 * @returns The declared fields no step names, in declaration order.
 */
export function unclaimedConfigFields(manifest: AdapterManifest): ConfigField[] {
  const steps = manifest.setupSteps;
  if (!steps || steps.length === 0) return [];
  const claimed = new Set(steps.flatMap((step) => step.fields));
  return manifest.configFields.filter((field) => !claimed.has(field.key));
}

/**
 * Render a value as it sits on disk into the text a `textarea` edits.
 *
 * A field whose `valueShape` says it persists as something other than text
 * stores an array or an object, and handing that straight to a textarea
 * stringifies it into nonsense — an array comma-joins onto one line, an object
 * becomes `[object Object]`. Editing that text and saving it writes the nonsense
 * back, which for `approverAllowlist` silently revokes everyone who could
 * approve (DOR-640 review). Values arriving already as text pass through, which
 * is what a half-typed edit and a config that predates the field both look like.
 *
 * @param field - The field descriptor, read for its `valueShape`.
 * @param value - The value as stored on disk.
 * @returns Text the textarea can edit and the server can turn back into `value`.
 */
export function storedValueToFormText(field: ConfigField, value: unknown): unknown {
  if (typeof value === 'string' || value === undefined || value === null) return value;
  if (field.valueShape === 'id-list') {
    return Array.isArray(value) ? value.join('\n') : value;
  }
  if (field.valueShape === 'json-object') {
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : value;
  }
  return value;
}

/**
 * Config fields the wizard shows on setup step `stepIndex`.
 *
 * With no setup steps, every field shows at once. With them, a step shows the
 * fields it names, and the **last** step additionally shows every unclaimed
 * field, so the union across all steps is exactly `configFields` with no
 * duplicates. An out-of-range index falls back to every field.
 *
 * @param manifest - Adapter manifest to read the steps and fields from.
 * @param stepIndex - Zero-based index of the setup step being shown.
 * @returns The fields to render on that step, in declaration order.
 */
export function setupStepFields(manifest: AdapterManifest, stepIndex: number): ConfigField[] {
  const steps = manifest.setupSteps;
  if (!steps || steps.length === 0) return manifest.configFields;
  const step = steps[stepIndex];
  if (!step) return manifest.configFields;
  const named = manifest.configFields.filter((field) => step.fields.includes(field.key));
  if (stepIndex !== steps.length - 1) return named;
  return [...named, ...unclaimedConfigFields(manifest)];
}
