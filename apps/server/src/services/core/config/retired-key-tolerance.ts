/**
 * Retired-key tolerances for the JSON Schema conf validates the config against.
 *
 * Each one DECLARES a key an older build wrote, with its real type, so a file
 * still carrying it loads and the first write that goes through Zod drops it.
 * They live beside `config-manager.ts` rather than in it; the sidebar's sibling
 * stays there because it reads constants the migration bodies share.
 *
 * @module services/core/config/retired-key-tolerance
 */
import { ClaudeCodeAccountSchema, ClaudeCodeSettingsSchema } from '@dorkos/shared/config-schema';

/**
 * Widen the generated JSON Schema so conf's Ajv ACCEPTS a Claude account
 * registry written before ids existed, instead of condemning the whole config
 * file (spec `billing-account-ladder`, ADR 260821-205324).
 *
 * The second rename in this file's history, and the same hazard
 * `tolerateRetiredSidebarKeys` (in `config-manager.ts`) exists for — with one difference worth
 * naming, because it is why the unknown-key tolerance already in place does not
 * cover it. `tolerateUnknownKeys` REOPENS objects, so a key this build does not
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

/**
 * Declare the retired `runtimes.dorkosTools` key, so that **a write whose parse
 * output drops it genuinely removes it** rather than having it carried straight
 * back from disk.
 *
 * The same mechanism `tolerateRetiredSidebarKeys` (in `config-manager.ts`) explains at length, and
 * the same two halves: `'0.80.0'` moves what the key MEANT (nothing — the
 * experiment graduated and every runtime carries the tools now), and this is
 * what makes the husk go away on an install that key never reaches. A dev tree
 * resolves `SERVER_VERSION` to `0.0.0` and runs no migration at all, so without
 * this the leaf could never leave: `ConfigManager.write` carries keys the schema
 * does not declare across from disk on purpose, so an older build saving a theme
 * cannot delete a newer build's settings. Naming it here puts it back inside
 * "what this build knows about", so `preserveUnknownKeys` stops re-attaching it.
 *
 * ## What that does and does not promise
 *
 * Not "the first write", which is what this said before it was measured. This
 * removes the FLOOR under the key; it does not reach a write that re-supplies it
 * by hand. `ConfigManager.write` writes the value its caller passed, so:
 *
 * - A write whose value came through Zod drops it — `PATCH /api/config` and the
 *   `config_patch` operator tool both go through `applyConfigPatch`, which
 *   re-parses the whole config, and Zod strips what it does not declare. Tested.
 * - A write that spreads the STORED object back over itself keeps it, because
 *   the caller put it in `next` itself and nothing here overrules a caller.
 *   `persist-provider-credential.ts` is the live example — `config.set(
 *   'runtimes', { ...config.get('runtimes'), opencode })`, where `get` hands
 *   back conf's stored object rather than a parse. Also tested, so the limit is
 *   pinned rather than discovered again.
 * - `setDot('ui.theme')` does not touch `runtimes` at all, so of course it keeps
 *   it.
 *
 * That is the honest shape, and it is enough: `'0.80.0'` is what covers every
 * install a release at or past `'0.80.0'` reaches, and this covers the ones it
 * does not.
 *
 * It is written by PATH rather than by schema identity, which is the one way it
 * differs from its sidebar sibling: `runtimes` is an inline object inside
 * `UserConfigSchema` with no exported symbol to compare against, and inventing
 * one to be able to match it would be a larger change than the thing it enables.
 *
 * Deliberately no `default`: conf builds Ajv with `useDefaults`, so a declared
 * default would WRITE this retired key into every config on earth — the trap
 * {@link tolerateLegacyClaudeAccountEncoding} names for `activeAccount`.
 *
 * Declared with its real type rather than as an open catchall: "let yesterday's
 * key through" must not quietly become "validate nothing".
 *
 * @param schema - The generated JSON Schema for the whole config, mutated in place.
 */
export function tolerateRetiredRuntimeKeys(schema: { properties?: Record<string, unknown> }): void {
  const runtimes = schema.properties?.['runtimes'];
  if (runtimes == null || typeof runtimes !== 'object') return;
  const properties = (runtimes as { properties?: Record<string, unknown> }).properties;
  if (properties == null || typeof properties !== 'object') return;
  properties['dorkosTools'] = { type: 'boolean' };
}

/**
 * Declare the retired `rooms.toolOnlyReplies` key, for the same reason and with
 * the same limits as {@link tolerateRetiredRuntimeKeys} next door.
 *
 * Its own pair of halves: `'0.81.0'` moves what the key MEANT (nothing — the
 * experiment graduated, and a room turn speaks by calling the tool or not at
 * all), and this is what makes the husk go away on an install that key never
 * reaches. A dev tree resolves `SERVER_VERSION` to `0.0.0` and runs no migration
 * at all, so without this the leaf could never leave: `ConfigManager.write`
 * carries keys the schema does not declare across from disk on purpose, so an
 * older build saving a theme cannot delete a newer build's settings.
 *
 * A SIBLING rather than an argument to the one next door, because the two name
 * different sections and a single function taking a path table would be a bigger
 * change than the thing it enables — the same call the sidebar and runtime
 * tolerances already make twice.
 *
 * Everything its sibling says about what this does and does not promise applies
 * here unchanged: it removes the floor under the key, it does not reach a write
 * that re-supplies it by hand, and it carries no `default` because conf builds
 * Ajv with `useDefaults` and a declared default would write the retired key into
 * every config on earth.
 *
 * @param schema - The generated JSON Schema for the whole config, mutated in place.
 */
export function tolerateRetiredRoomKeys(schema: { properties?: Record<string, unknown> }): void {
  const rooms = schema.properties?.['rooms'];
  if (rooms == null || typeof rooms !== 'object') return;
  const properties = (rooms as { properties?: Record<string, unknown> }).properties;
  if (properties == null || typeof properties !== 'object') return;
  properties['toolOnlyReplies'] = { type: 'boolean' };
}
