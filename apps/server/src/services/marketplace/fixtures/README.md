# Marketplace install fixtures

These fixture trees back the install-flow tests for `apps/server/src/services/marketplace/`. Each directory is a self-contained marketplace package on disk that can be passed directly to `validatePackage` from `@dorkos/marketplace/package-validator`.

The fixture trees are intentionally minimal — just enough files to satisfy (or break) the validator. Keep them small. Tests that need richer state should build temp directories at runtime instead of growing these fixtures.

## Valid fixtures

Each of the four valid fixtures exercises one `PackageType` from the discriminated union in `@dorkos/marketplace/manifest-schema`. They all parse cleanly and `validatePackage` returns `ok: true`.

| Fixture            | Type         | Notes                                                                                                                              |
| ------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `valid-plugin`     | `plugin`     | Has `.claude-plugin/plugin.json`, an extension stub under `.dork/extensions/sample-ext/`, and a bundled task under `.dork/tasks/`. |
| `valid-agent`      | `agent`      | Pure DorkOS package — no `.claude-plugin/plugin.json` (per `requiresClaudePlugin`). Includes `agentDefaults`.                      |
| `valid-skill-pack` | `skill-pack` | Three SKILL.md files under `skills/` (`analyzer`, `summarizer`, `translator`).                                                     |
| `valid-adapter`    | `adapter`    | Declares `adapterType: slack`. Adapter implementation stub under `.dork/adapters/slack/`.                                          |

## Broken fixtures

The three broken fixtures live under `broken/` and each fails `validatePackage` for a different reason. The fixture name describes the install-flow scenario; the validator failure code is the actual mechanism the test asserts on.

| Fixture                         | Validator failure         | Why                                                                                                                                         |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `broken/invalid-manifest`       | `MANIFEST_SCHEMA_INVALID` | Manifest violates the Zod schema in multiple ways: bad name, non-semver version, empty description, `tags` is a string instead of an array. |
| `broken/missing-extension-code` | `CLAUDE_PLUGIN_MISSING`   | Plugin manifest is valid, but the package omits the required `.claude-plugin/plugin.json` that all non-agent types must ship.               |
| `broken/conflicting-skill`      | `SKILL_INVALID`           | Bundled `skills/analyzer/SKILL.md` declares `name: different-name` in frontmatter, which the SKILL.md parser rejects on directory mismatch. |

The `conflicting-skill` directory is also named `analyzer` to mirror a real install-time conflict against `valid-skill-pack/skills/analyzer/`. The validator does not check cross-package conflicts — that check belongs to the install planner. The `SKILL_INVALID` failure is what the validator sanity test asserts on.

## Sanity test

`apps/server/src/services/marketplace/__tests__/fixtures.test.ts` walks every fixture in this directory and asserts that:

- Each `valid-*` fixture yields `validatePackage(...).ok === true`.
- Each `broken/*` fixture yields `validatePackage(...).ok === false`.

If you change a fixture, run that test to confirm the validator still classifies it the way the README claims.
