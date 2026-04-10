# Implementation Summary: ESLint Per-Package Config Refactor

**Created:** 2026-03-06
**Last Updated:** 2026-03-06
**Spec:** specs/eslint-per-package-config/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 9 / 9

## Tasks Completed

### Session 1 - 2026-03-06

- Task #1: Create @dorkos/eslint-config shared package with base, react, node, and test presets
- Task #2: Move sdk-utils.ts into runtimes/claude-code/ and update import paths
- Task #3: Create apps/client/eslint.config.js with FSD boundary enforcement rules
- Task #4: Create apps/server/eslint.config.js with SDK confinement and os.homedir ban
- Task #5: Create eslint.config.js for obsidian-plugin, e2e, and CLI packages
- Task #6: Create eslint.config.js for simple packages: shared, relay, mesh, db, test-utils, icons
- Task #7: Update turbo.json, thin root eslint.config.js, and clean up root package.json
- Task #8: Verify behavioral equivalence, SDK confinement, FSD rules, and Turbo cache
- Task #9: Update AGENTS.md and contributing/architecture.md documentation

## Files Modified/Created

**Source files:**

- `packages/eslint-config/package.json` - New shared config package manifest
- `packages/eslint-config/base.js` - Base preset (JS/TS/TSDoc/process.env/prettier)
- `packages/eslint-config/react.js` - React preset (extends base + react/hooks/a11y)
- `packages/eslint-config/node.js` - Node preset (extends base)
- `packages/eslint-config/test.js` - Test overlay (relaxed rules)
- `apps/server/src/services/runtimes/claude-code/sdk-utils.ts` - Moved from lib/
- `apps/server/src/routes/config.ts` - Updated import path
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` - Updated import path
- `apps/client/eslint.config.js` - Client config with FSD boundary enforcement
- `apps/client/package.json` - Added @dorkos/eslint-config devDep
- `apps/server/eslint.config.js` - Server config with SDK confinement + os.homedir ban
- `apps/server/package.json` - Added @dorkos/eslint-config devDep
- `apps/obsidian-plugin/eslint.config.js` - React preset, ignores build-plugins/
- `apps/obsidian-plugin/package.json` - Added @dorkos/eslint-config devDep
- `apps/e2e/eslint.config.js` - Base only, ignores test-results/playwright-report/
- `apps/e2e/package.json` - Added @dorkos/eslint-config devDep + lint script
- `packages/cli/eslint.config.js` - Node preset with process.env carve-outs
- `packages/cli/package.json` - Added @dorkos/eslint-config devDep + lint script
- `packages/shared/eslint.config.js` - Base + test overlay
- `packages/shared/package.json` - Added @dorkos/eslint-config devDep
- `packages/relay/eslint.config.js` - Base + test overlay
- `packages/relay/package.json` - Added @dorkos/eslint-config devDep
- `packages/mesh/eslint.config.js` - Base + test overlay
- `packages/mesh/package.json` - Added @dorkos/eslint-config devDep
- `packages/db/eslint.config.js` - Base + test overlay, ignores drizzle/\*\*
- `packages/db/package.json` - Added @dorkos/eslint-config devDep + lint script
- `packages/test-utils/eslint.config.js` - Base + test overlay
- `packages/test-utils/package.json` - Added @dorkos/eslint-config devDep + lint script
- `packages/icons/eslint.config.js` - Base only (no tests)
- `packages/icons/package.json` - Added @dorkos/eslint-config devDep + lint script
- `turbo.json` - Changed lint dependsOn from ["^build"] to ["^lint"]
- `eslint.config.js` (root) - Thinned from 276 lines to ~15 lines (root-level files only)
- `package.json` (root) - Removed 7 ESLint plugin devDeps, added @dorkos/eslint-config

**Documentation files:**

- `AGENTS.md` - Updated monorepo structure, sdk-utils path, Code Quality section
- `contributing/architecture.md` - Updated SDK confinement notes, module layout, sdk-utils references
- `contributing/obsidian-plugin-development.md` - Updated sdk-utils path references

**Test files:**

- `apps/server/src/routes/__tests__/config.test.ts` - Updated mock path for sdk-utils

## Known Issues

_(None)_

## Verification Results

| Check                                       | Status |
| ------------------------------------------- | ------ |
| Full lint (0 errors, 12 packages)           | PASS   |
| SDK confinement (blocked outside runtimes/) | PASS   |
| SDK confinement (allowed inside runtimes/)  | PASS   |
| FSD boundary enforcement                    | PASS   |
| os.homedir() ban enforcement                | PASS   |
| Turbo cache granularity (per-package)       | PASS   |
| TypeCheck (0 errors, 13 packages)           | PASS   |
| Server tests (1168/1168)                    | PASS   |
| Client tests (pre-existing failures only)   | PASS   |

## Implementation Notes

### Session 1

Executed in 5 batches with parallel agents:

- Batch 1 (2 parallel): Foundation — shared config package + sdk-utils move
- Batch 2 (4 parallel): Per-package configs for all 11 packages
- Batch 3 (1 sequential): Root config thinning + turbo.json + dep cleanup
- Batch 4 (1 sequential): Full verification suite
- Batch 5 (1 sequential): Documentation updates
