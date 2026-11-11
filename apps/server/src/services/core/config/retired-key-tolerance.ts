/**
 * Retired-key tolerances for the JSON Schema conf validates the config against.
 *
 * Each one DECLARES a key an older build wrote, with its real type, so a file
 * still carrying it loads and the first write that goes through Zod drops it.
 * They live beside `config-manager.ts` rather than in it. Unsupported sidebar
 * encodings are refused before Conf opens and need no schema tolerance here.
 *
 * @module services/core/config/retired-key-tolerance
 */
import { ClaudeCodeAccountSchema, ClaudeCodeSettingsSchema } from '@dorkos/shared/config-schema';

/**
 * Widen the generated JSON Schema so conf's Ajv ACCEPTS a Claude account
 * registry written before ids existed, instead of condemning the whole config
 * file (spec `billing-account-ladder`, ADR 260821-205324).
 *
 * The unknown-key tolerance already in place does not cover required fields.
 * `tolerateUnknownKeys` REOPENS objects, so a key this build does not
 * know is survivable. Nothing reopens a `required` list. `accounts[].id` is
 * required and did not exist before 0.65.0, so EVERY config file that has ever
 * been written is schema-invalid the moment the `'0.65.0'` migration is skipped
 * — and the constructor's recovery path then backs the file up and replaces it
 * with defaults. Not the accounts. The whole file: `mesh.scanRoots`,
 * `approvals`, `runtimes`, `cloud`, `onboarding`.
 *
 * And it is skipped routinely: a dev tree resolves `SERVER_VERSION` to `0.0.0`
 * and runs no migrations at all, and cutting a release below `0.65.0` skips it
 * for everyone on that release. Correctness must not hang on the migration
 * running — which is the whole lesson of DOR-579, restated one rename later.
 *
 * The property stays DECLARED, so an id of the wrong TYPE is still refused; only
 * its presence is optional. What fills it in is
 * `backfillMissingAccountIds` inside `ClaudeCodeAccountsSchema`
 * (`packages/shared/src/config-schema.ts`), which heals a missing id on every
 * Zod parse by the migration's own rule. Ajv has to be widened separately
 * because `z.toJSONSchema` emits a pipe's OUTPUT schema and so never sees that
 * preprocess step — verified by the generated node still listing `id` as
 * required.
 *
 * ## Removing it
 *
 * The `activeAccount` declaration is back-compat for one release, exactly like
 * its sibling: delete it once the `'0.65.0'` migration has shipped in a tagged
 * release that every supported install has passed through. The tests in `'a
 * Claude account registry written before ids'` fail if it is removed early.
 *
 * The row tolerance is NOT back-compat and stays (spec `claude-account-fleet`
 * D1): the registry is a contract flow writes too, and its read rules skip a
 * bad row rather than refuse the file, so Ajv accepts any value as an account
 * row.
 *
 * @param ctx - The `z.toJSONSchema` override context for one schema node.
 */
export function tolerateLegacyClaudeAccountEncoding(ctx: {
  zodSchema: unknown;
  jsonSchema: Record<string, unknown>;
}): void {
  // The retired `activeAccount` spelling, DECLARED — with its real type, not as
  // an open catchall, on the same rule the sidebar's retired keys follow.
  //
  // Declaring it is not about letting it past Ajv; `tolerateUnknownKeys` already
  // does that. It is about `preserveUnknownKeys` (`config/version-skew.ts`),
  // which carries every key the schema does NOT declare from the stored value
  // onto the value replacing it — so that an older build saving a theme cannot
  // delete a newer build's settings. Left undeclared, `activeAccount` was
  // re-attached to the file after EVERY write, including the write that had just
  // cleared the account. The next read healed it straight back, and "go back to
  // inheriting" became "pin to the old account, permanently". Declared, this
  // build owns the key: a write whose parse output drops it genuinely removes it.
  if (ctx.zodSchema === ClaudeCodeSettingsSchema) {
    const properties = ctx.jsonSchema.properties as
      Record<string, Record<string, unknown>> | undefined;
    if (!properties) return;
    // Deliberately no `default`: conf builds Ajv with `useDefaults`, so a
    // declared default would WRITE this retired key into every config on earth.
    properties.activeAccount = { anyOf: [{ type: 'string' }, { type: 'null' }] };
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
