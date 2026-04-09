---
name: adding-config-fields
description: Patterns for adding, renaming, removing, or retyping fields in DorkOS user config. Use when editing UserConfigSchema, MarketplacesFileSchema, or any conf-backed store — walks the Zod field → defaults → conf migration → docs → test lifecycle end-to-end.
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
---

# Adding Config Fields in DorkOS

## Overview

This skill guides the full lifecycle of changing `~/.dork/config.json` (or, post-refactor, `~/.dork/marketplaces.json`) schema: Zod field → import-time defaults → `conf` migration → docs update → tests → CLI flag wiring if applicable. Use it whenever you touch `UserConfigSchema` so you don't ship a partial change.

DorkOS uses the [`conf`](https://github.com/sindresorhus/conf) library (v15.1.0) for persistent user configuration, wrapped at `apps/server/src/services/core/config-manager.ts`. Zod is the authoritative schema and is bridged to conf's Ajv validation via `z.toJSONSchema(UserConfigSchema)`. You do not hand-write JSON Schema; you edit Zod and let the bridge regenerate it.

## When to use

- You're about to edit `packages/shared/src/config-schema.ts` (adding, renaming, removing, or retyping a field in `UserConfigSchema`).
- You're about to edit `apps/server/src/services/core/config-manager.ts` for any reason related to the `migrations` block or `projectVersion`.
- (Future) You're about to edit `MarketplacesFileSchema` once `apps/server/src/services/marketplace/marketplace-source-manager.ts` is refactored onto `conf`.
- A user asks "how do I add a setting to DorkOS?" or "how do config migrations work here?"
- `/system:release` Phase 2 flags a config schema drift and you need to write the migration.

## Key concepts

### The authoritative files

| File                                                             | Role                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/shared/src/config-schema.ts`                           | **Authoritative.** Zod schema + defaults constant. Change this first.          |
| `apps/server/src/services/core/config-manager.ts`                | The `conf` wrapper. Holds `projectVersion` + `migrations`. Change this second. |
| `contributing/configuration.md`                                  | User-facing settings reference. Update the table + narrative.                  |
| `docs/getting-started/configuration.mdx`                         | External Fumadocs mirror of the same reference. Keep in sync.                  |
| `apps/server/src/services/core/__tests__/config-manager.test.ts` | Migration + upgrade-path tests.                                                |
| `packages/cli/src/cli.ts`                                        | CLI flag wiring (only if the field needs a flag).                              |

### `conf`'s migration model

`conf` tracks migration state **inside the config file itself**, in an internal key at `__internal__.migrations.version`. On every `new Conf(...)` instantiation:

1. `conf` reads the stored `__internal__.migrations.version`.
2. Compares it against the `projectVersion` you passed to the constructor.
3. Runs every migration whose semver key is **greater than** the stored version **and less than or equal to** `projectVersion`, in semver order.
4. After all applicable migrations run, writes `projectVersion` back to `__internal__.migrations.version`.
5. Each migration runs **at most once per user**.

`projectVersion` is the **app version**, not a schema version. Migration keys are the app versions at or after which each migration should fire. A migration keyed `'0.35.0'` runs on the first launch of DorkOS 0.35.0 (or any later version, if the user skipped 0.35.0 entirely).

### Things to know before you start

1. **`projectVersion` is sourced from `SERVER_VERSION`**, not hardcoded. `config-manager.ts` imports `SERVER_VERSION` from `../../lib/version.js` and hands it to Conf. That resolver honors `DORKOS_VERSION_OVERRIDE` → esbuild-injected `__CLI_VERSION__` → `package.json` dev fallback, in that order. Do not reintroduce a hardcoded `projectVersion` string — migration keys must match real release boundaries.
2. **Migrations live in the module-level `CONFIG_MIGRATIONS` constant.** Append new entries there, not inside the constructor. The constructor reuses the same `confOptions` object for both the primary and corrupt-recovery Conf instantiations, so every migration runs equally in both paths.
3. **`USER_CONFIG_DEFAULTS` at `config-schema.ts:191-193`** is computed from `UserConfigSchema.parse({ version: 1 })` **at import time**. Adding a required field without a default will crash the server on startup for every new install. Always use `.default(...)` unless the field is genuinely optional.

## Step-by-step approach

### 1. Add the field to the Zod schema

Edit `packages/shared/src/config-schema.ts`. Add the field to the appropriate nested object in `UserConfigSchema` with a `.default(...)`.

```typescript
// Before
server: z.object({
  port: z.number().int().min(1024).max(65535).default(4242),
  // ...
}).default(() => ({ port: 4242, /* ... */ })),

// After — adding server.timeout
server: z.object({
  port: z.number().int().min(1024).max(65535).default(4242),
  timeout: z.number().int().min(1000).max(300000).default(30000),
  // ...
}).default(() => ({ port: 4242, timeout: 30000, /* ... */ })),
```

**Rule:** if the enclosing object has a `.default(() => ({...}))` factory, you must include the new field's default there too. Otherwise fresh installs get `undefined` at import time and crash.

### 2. Verify `USER_CONFIG_DEFAULTS` still parses

At the bottom of `config-schema.ts`, `USER_CONFIG_DEFAULTS = UserConfigSchema.parse({ version: 1 })` runs at import time. After your edit, typecheck the package:

```bash
pnpm --filter=@dorkos/shared typecheck
```

If this fails, your field is required without a default. Fix before proceeding.

### 3. Append a migration to `CONFIG_MIGRATIONS`

Edit `apps/server/src/services/core/config-manager.ts`. You do **not** need to bump `projectVersion` — it's sourced from `SERVER_VERSION` via `lib/version.ts`, which updates automatically every release. Your only job is to append a new entry to the module-level `CONFIG_MIGRATIONS` constant, keyed to the app version that will ship your change.

The shape to match:

```typescript
const CONFIG_MIGRATIONS = {
  '1.0.0': (store) => {
    if (!store.has('version')) {
      store.set('version', 1);
    }
  },
  '0.35.0': (store) => {
    // Added server.timeout in v0.35.0. conf's defaults-merge will populate
    // the key on first instantiation, so this migration is a no-op for
    // added-with-default cases. Kept here to anchor the version boundary
    // and provide a place to extend if we later need cleanup.
    if (!store.has('server.timeout')) {
      store.set('server.timeout', 30000);
    }
  },
} as const;
```

The target release version is the version of DorkOS that will first ship this change — ask the user, read `VERSION`, or let `/system:release`'s Phase 2 Check 6 detect and scaffold it for you.

For **added fields with defaults**: the migration body is often empty (or a guard as above) — `conf`'s defaults-merge handles the new-key case automatically.

For **removed fields**:

```typescript
'0.35.0': (store) => {
  if (store.has('mesh.legacyMode')) {
    store.delete('mesh.legacyMode');
  }
},
```

For **renamed fields**:

```typescript
'0.35.0': (store) => {
  if (store.has('server.cwd') && !store.has('server.workingDirectory')) {
    store.set('server.workingDirectory', store.get('server.cwd'));
    store.delete('server.cwd');
  }
},
```

For **type changes** (e.g., `number` → `string`):

```typescript
'0.35.0': (store) => {
  const current = store.get('server.timeout');
  if (typeof current === 'number') {
    store.set('server.timeout', String(current));
  }
},
```

**Every migration must be idempotent.** Guard every `store.set/delete` with `store.has()` or a type check so re-running the same migration (e.g., after corrupt-recovery) is safe.

### 4. Document the field in `contributing/configuration.md`

Add a row to the Settings Reference table at the top of the file:

```markdown
| `server.timeout` | integer (1000--300000) | `30000` | Request timeout in milliseconds before aborting a long-running agent call |
```

If the field warrants per-setting narrative (like `server.port` does), add a `### server.timeout` section with a `dorkos config set` example and any precedence notes.

### 5. Mirror the doc to `docs/getting-started/configuration.mdx`

The `check-docs-changed.sh` hook will remind you at session-stop via the `configuration.md:config-manager|config-schema|packages/cli/` mapping. Do it inline. Find the same settings table in the MDX file and add the matching row.

### 6. Add or update tests

Edit `apps/server/src/services/core/__tests__/config-manager.test.ts`. Add an **upgrade-path test** that exercises the migration against a realistic stale-config blob:

```typescript
it('migrates pre-0.35.0 configs to include server.timeout', async () => {
  const dorkHome = await mkdtemp(join(tmpdir(), 'cfg-mig-'));
  const configPath = join(dorkHome, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      server: { port: 4242, cwd: null, boundary: null, open: true },
      // ... other required sections ...
      __internal__: { migrations: { version: '1.0.0' } },
    })
  );

  initConfigManager(dorkHome);
  expect(configManager.getDot('server.timeout')).toBe(30000);
});
```

Test both cases:

- Stale config missing the field → migration runs, field is populated.
- Fresh config → defaults handle it, no migration needed.

### 7. Wire a CLI flag if applicable

If the new field needs to be controllable from the `dorkos` CLI, edit `packages/cli/src/cli.ts`. Follow the precedence rule documented in `contributing/configuration.md`: **CLI flag > env var > config > default**.

Also add the flag to the `dorkos config set` shell-completion list if one exists for the namespace.

## Best practices

- **Append-only migrations.** Never edit a shipped migration body. If you need to fix a broken migration, append a new one at the next version that reverses the damage and applies the correct change. Editing in place leaves users in divergent states.
- **Semver keys matching real release versions.** If a migration ships in v0.35.0, key it `'0.35.0'`, not `'0.35'` or `'35'`. This makes the release-notes → migration mapping straightforward and lets `/system:release`'s drift check validate the pairing.
- **Idempotent migrations.** Always guard mutations. Corrupt-recovery or manual `__internal__.migrations.version` edits can cause a migration to re-run; non-idempotent bodies corrupt data.
- **Flag data-loss changes loudly.** Any migration that deletes a user's data should have a comment explaining why and pointing at the ADR or spec that authorized it.
- **Test the upgrade path, not just the new shape.** A test that only validates the post-migration schema misses the half of the test surface that's about "the migration actually ran."
- **Coordinate with the release command.** `/system:release` Phase 2 detects drift between `config-schema.ts`/`config-manager.ts` and the existing migrations. When triggered, it offers to scaffold inline — accepting its draft is fine, but always review before applying.

## Common pitfalls

- **Editing `'1.0.0'` migration body** (or any shipped migration) after it's been released. Users who already ran the old body won't re-run it; you'll have split-brain state.
- **Hardcoding `projectVersion` in the constructor.** It's sourced from `SERVER_VERSION` — never pass a string literal. If the resolver ever breaks (e.g., `DORKOS_VERSION_OVERRIDE` unset, esbuild banner missing, package.json missing), fix `lib/version.ts`, not `config-manager.ts`.
- **Adding a required field without a default.** Crashes at import time because `USER_CONFIG_DEFAULTS = UserConfigSchema.parse({ version: 1 })` can't satisfy the required field without a value.
- **Writing non-idempotent migrations** (e.g., `store.set('counter', store.get('counter') + 1)`) — re-running doubles the value. Always check state before mutating.
- **Relying on field presence inside a migration body.** Use `store.has()` before every read; don't assume the old shape matches your mental model.
- **Forgetting to update the `.default(() => ({...}))` factory** on a nested object. Zod validates a parsed object against the inner `.default(...)` at the field level, but the factory-level default is what runs when the whole section is missing. If you add a field inside `server: z.object({...}).default(() => ({ port: 4242 }))` without including `timeout` in the factory, fresh installs get an incomplete `server` section.
- **Updating the Zod schema without updating `contributing/configuration.md` or `docs/getting-started/configuration.mdx`.** Users read docs to discover settings; stale docs are worse than missing docs.
- **Testing only with a fresh config.** A passing fresh-install test tells you nothing about the upgrade path — you need a stale-config fixture.

## Interaction with `/system:release`

When you run `/system:release`, its Phase 2 pre-flight runs a **config schema migration drift check**:

1. Git-diffs `packages/shared/src/config-schema.ts` and `apps/server/src/services/core/config-manager.ts` against the last tag.
2. If changes exist, analyzes them inline (no subagent) to classify: added-with-default (usually fine) vs removed/renamed/retyped (migration needed).
3. Checks whether the existing `migrations` block already has an entry keyed to the target release version.
4. If drift is detected without a matching migration, the release command offers four options:
   - **Scaffold inline** — drafts the migration, presents it for your review, applies it on approval, stages the file into the release commit.
   - **Let me write it manually** — exits cleanly; you edit `config-manager.ts` using this skill, commit, re-run `/system:release`.
   - **No migration needed** — for type-only/TSDoc changes. You take responsibility, release continues.
   - **Cancel release** — exits.

See `.claude/commands/system/release.md` Phase 2 for the full flow. The scaffolder produces a best-guess draft; review it against this skill's guidance before accepting.

## Marketplace follow-up note

`~/.dork/marketplaces.json` is currently owned by a hand-rolled `MarketplaceSourceManager` at `apps/server/src/services/marketplace/marketplace-source-manager.ts`. It has a one-off URL-rewrite map (`LEGACY_SOURCE_MIGRATIONS`) that is **orthogonal** to `conf`'s semver-keyed schema migrations. The rewrite map fixes a known-bad default URL; it is not a schema migration system.

A pending refactor will move `marketplaces.json` onto `conf` with the same wrapper pattern as `ConfigManager`. When that lands, this skill extends to cover `MarketplacesFileSchema` too — same process, same step list. Until then, changes to `marketplace-source-manager.ts` are out of scope for this skill.

## References

- `apps/server/src/services/core/config-manager.ts` — the canonical `conf` wrapper.
- `packages/shared/src/config-schema.ts` — the Zod schema and defaults constant.
- `contributing/configuration.md` — Schema Migrations section + Settings Reference table.
- `docs/getting-started/configuration.mdx` — external Fumadocs mirror.
- `.claude/commands/system/release.md` — Phase 2 drift detection and scaffolding offer.
- `.claude/rules/agent-storage.md` — adjacent file-first write-through pattern (same philosophy, different domain).
- [`conf` README](https://github.com/sindresorhus/conf) — library-level documentation.
