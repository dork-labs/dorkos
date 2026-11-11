/**
 * Tolerate current account edits without replacing unrelated config sections.
 *
 * Account rows follow the shared Flow read rules: malformed rows are skipped
 * and preserved by writes. Colors and project rules also tolerate bad hand edits.
 * Retired account aliases are refused before Conf opens.
 *
 * @module services/core/config/account-edit-tolerance
 */
import { ClaudeCodeAccountSchema, ClaudeCodeSettingsSchema } from '@dorkos/shared/config-schema';

/**
 * Match the schema's current tolerant account readers in Conf's Ajv validation.
 * @param ctx - The JSON-schema override context for one schema node.
 */
export function tolerateClaudeAccountEdits(ctx: {
  zodSchema: unknown;
  jsonSchema: Record<string, unknown>;
}): void {
  if (ctx.zodSchema === ClaudeCodeSettingsSchema) {
    const properties = ctx.jsonSchema.properties as
      Record<string, Record<string, unknown>> | undefined;
    if (!properties) return;
    // The standalone default's color (DOR-2492) follows a row's `color`: a bad
    // hand edit reads as "no choice" (`.catch(null)` in the Zod schema, and
    // `isAccountColor` in every reader) rather than condemning the file, so Ajv
    // takes any string here. Its `default` stays, as the generated node had it.
    properties.defaultAccountColor = {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
    };
    // The account rules (spec `flow-multiproject` §8.1) are hand-editable too,
    // and every reader reads a wrong shape as "no rule" (`readProjectRootList`,
    // `readEligibilityRules`, and the tolerant Zod schemas). Ajv refusing one
    // would move the whole config aside for a fresh file, losing every other
    // setting over one bad edit, so both accept any value here. Their defaults
    // stay, as the generated nodes had them.
    properties.defaultAccountOnlyProjects = { default: null };
    properties.projectAccounts = { default: {} };
    return;
  }
  if (ctx.zodSchema !== ClaudeCodeAccountSchema) return;
  // The registry is shared with flow and hand-editable (marketplace
  // `specs/flow-cli-core` §1.1a), and its readers SKIP a bad row with a warning
  // rather than fail: a row that is not an object, has no absolute path, an
  // empty or non-string id, a non-string label, or a color that is not
  // lowercase `#rrggbb`. Ajv refusing any of those would condemn the whole file
  // instead, so an account row accepts ANY value here: no type, no required
  // list, no per-field shape. `readClaudeAccountSettings` applies the read
  // rules; the write path (`applyConfigPatch`) carries such a row across
  // untouched. Emptied in place because the override is handed the node to
  // edit. No `default` survives either: conf builds Ajv with `useDefaults`,
  // so a declared default would write `color: null` into every row it
  // validates, including rows this build never listed.
  for (const key of Object.keys(ctx.jsonSchema)) delete ctx.jsonSchema[key];
}
