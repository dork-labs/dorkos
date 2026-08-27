---
slug: upgrade-electron-vite
number: 213
created: 2026-04-01
status: specified
---

# Upgrade electron-vite v3→v5 and Electron 33→39

**Status:** Specified
**Authors:** Claude Code, 2026-04-01
**Ideation:** `specs/upgrade-electron-vite/01-ideation.md`
**Research:** `research/20260401_electron_vite_upgrade_v3_to_v5.md`

---

## Overview

Upgrade `apps/desktop/` from electron-vite 3.1.0 to 5.0.0 and from Electron 33.4.11 to Electron 39.8.5 (the latest line fully validated by electron-vite v5). The change spans two major electron-vite versions but requires only 3 version bumps in `package.json` and a ~3-line removal from `electron.vite.config.ts`. No source files in `apps/desktop/src/` change.

---

## Background / Problem Statement

The desktop app was built in March 2025 on electron-vite 3.1.0 (bundling Vite 6) and Electron 33. By December 2025, electron-vite v5.0.0 shipped with Vite 7, official Electron 39 support, and a simplified dependency externalization model (the `externalizeDepsPlugin` is now built-in behavior, on by default). Staying on v3 means:

- Running Vite 6 (superseded; no security updates)
- Missing Electron 39's graduated ASAR integrity and security improvements
- Carrying dead import (`externalizeDepsPlugin`) that will emit deprecation warnings in newer tooling

The migration cost is exceptionally low for this codebase — the existing config already uses static objects (no function-based config), does not use `bytecodePlugin`, and has ESM imports throughout.

---

## Goals

- Bump `electron-vite` from `^3.1.0` to `^5.0.0`
- Bump `electron` from `^33.4.11` to `^39.8.5`
- Bump `@tailwindcss/vite` from `^4.1.18` to `^4.2.2` (minor; same PR)
- Remove the deprecated `externalizeDepsPlugin` from `electron.vite.config.ts`
- All builds and dev mode pass cleanly after the upgrade
- Single PR; no intermediate upgrade steps

---

## Non-Goals

- Upgrading to Electron 40/41 (ships Node.js 24; electron-vite v5 has no build target for it — follow-up once electron-vite adds support)
- Upgrading `@vitejs/plugin-react` beyond `^5.x` (`@vitejs/plugin-react` v6 requires Vite 8; electron-vite v5 bundles Vite 7)
- Upgrading `@electron/rebuild` to v4 (breaking API changes; electron-builder uses it programmatically; verify compatibility before bumping)
- Adding new electron-vite v5 features (`build.isolatedEntries`, enhanced bytecode protection)
- Code signing or notarization (already deferred in ADR-0198)
- Windows or Linux support
- Upgrading anything outside `apps/desktop/`

---

## Technical Dependencies

| Package             | From       | To        | Notes                                                            |
| ------------------- | ---------- | --------- | ---------------------------------------------------------------- |
| `electron-vite`     | `^3.1.0`   | `^5.0.0`  | Core upgrade; now bundles Vite 7                                 |
| `electron`          | `^33.4.11` | `^39.8.5` | Last line with Node.js 22.x; fully validated by electron-vite v5 |
| `@tailwindcss/vite` | `^4.1.18`  | `^4.2.2`  | Minor/patch bump; Vite 7-compatible                              |

**Packages staying unchanged:**

| Package                | Version   | Why unchanged                                                                        |
| ---------------------- | --------- | ------------------------------------------------------------------------------------ |
| `electron-builder`     | `^26.8.1` | Already latest; no newer release                                                     |
| `electron-updater`     | `^6.8.3`  | Already latest                                                                       |
| `electron-log`         | `^5.4.3`  | Already latest                                                                       |
| `@vitejs/plugin-react` | `5.1.4`   | v6 requires Vite 8 — not compatible with electron-vite v5 (Vite 7)                   |
| `@electron/rebuild`    | `^3.7.2`  | v4 has breaking API changes that may conflict with electron-builder's internal usage |

**Reference:**

- [electron-vite v4→v5 migration guide](https://electron-vite.org/guide/migration)
- [electron-vite CHANGELOG](https://github.com/alex8088/electron-vite/blob/master/CHANGELOG.md)
- [Electron 39 release blog](https://www.electronjs.org/blog/electron-39-0)

---

## Detailed Design

### Breaking Changes Cleared (no action needed)

**v3→v4:**

| Change                             | Status                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| Node.js ≥20.19 or ≥22.12 required  | ✅ Local: 22.17.1; CI: `node-version: 22` (latest 22.x ≥22.12)                                      |
| Vite v7 adopted (from v6)          | ✅ Bundled internally; `@vitejs/plugin-react@5.x` and `@tailwindcss/vite@4.x` are Vite 7-compatible |
| CJS build of electron-vite removed | ✅ `electron.vite.config.ts` uses ESM `import` syntax throughout                                    |

**v4→v5:**

| Change                                         | Status                                |
| ---------------------------------------------- | ------------------------------------- |
| `bytecodePlugin` deprecated → `build.bytecode` | ✅ Not used in this project           |
| Function-based nested config removed           | ✅ Project uses static config objects |
| Electron 18–21 support dropped                 | ✅ Upgrading to Electron 39           |

### Action Required: Remove `externalizeDepsPlugin`

`externalizeDepsPlugin` is deprecated in v5. Its behavior (treat all `node_modules` as external for main/preload) is now the default via `build.externalizeDeps: true`, which is enabled by default.

**File:** `apps/desktop/electron.vite.config.ts`

**Before:**

```typescript
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
// ...
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()], // ← remove
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()], // ← remove
    build: {
      outDir: 'dist/preload',
    },
  },
  renderer: {/* unchanged */},
});
```

**After:**

```typescript
import { defineConfig } from 'electron-vite'; // ← externalizeDepsPlugin removed from import
// ...
export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        // These Rollup-level externals are independent of externalizeDepsPlugin — keep them
        external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
    },
  },
  renderer: {/* unchanged */},
});
```

> **Why keep `rollupOptions.external`?** These entries force `better-sqlite3` and `@anthropic-ai/claude-agent-sdk` to be excluded from the Rollup bundle entirely. This is a Rollup-level directive, separate from `externalizeDepsPlugin`'s behavior of auto-externalizing all `node_modules`. Both serve different purposes and can coexist; with v5, only the `rollupOptions.external` entries remain necessary for these specific packages.

### Files Changing

| File                                   | Change                                                             |
| -------------------------------------- | ------------------------------------------------------------------ |
| `apps/desktop/package.json`            | 3 version bumps (`electron-vite`, `electron`, `@tailwindcss/vite`) |
| `apps/desktop/electron.vite.config.ts` | Remove `externalizeDepsPlugin` import and 2 `plugins` usages       |
| `pnpm-lock.yaml`                       | Auto-regenerated by `pnpm install`                                 |

### Files NOT Changing

- All source files in `apps/desktop/src/`
- `apps/desktop/tsconfig.json` — already on `moduleResolution: bundler`
- `apps/desktop/electron-builder.yml` — not tied to electron-vite version
- `.github/workflows/desktop-release.yml` — `node-version: 22` already satisfies ≥22.12
- Anything outside `apps/desktop/`

### Architecture / Data Flow Impact

None. The upgrade touches the build toolchain only. Runtime behavior is identical:

- Main process: still compiled to `dist/main/`, loaded by Electron
- Preload: still compiled to `dist/preload/`, loaded as contextIsolated preload script
- Renderer: still compiled to `dist/renderer/`, loaded from `ELECTRON_RENDERER_URL` (dev) or file (prod)
- `better-sqlite3` and `@anthropic-ai/claude-agent-sdk` still externalized via `rollupOptions.external`
- `@dorkos/shared/*` subpath aliases still resolved via `sharedSubpathAliases()` helper

---

## User Experience

No user-visible change. The upgrade is purely internal build toolchain.

---

## Implementation Phases

### Phase 1: Dependency Bumps and Config Edit (entire scope)

1. In `apps/desktop/package.json`, update:
   - `"electron-vite"`: `"^3.1.0"` → `"^5.0.0"`
   - `"electron"`: `"^33.4.11"` → `"^39.8.5"`
   - `"@tailwindcss/vite"`: `"^4.1.18"` → `"^4.2.2"`

2. In `apps/desktop/electron.vite.config.ts`:
   - Change `import { defineConfig, externalizeDepsPlugin } from 'electron-vite'` to `import { defineConfig } from 'electron-vite'`
   - Remove `plugins: [externalizeDepsPlugin()]` from `main` config
   - Remove `plugins: [externalizeDepsPlugin()]` from `preload` config

3. From repo root, run `pnpm install` to regenerate lockfile

4. Verify build: `pnpm --filter @dorkos/desktop build`

5. Verify dev mode: `pnpm --filter @dorkos/desktop dev` (Electron window opens, HMR works)

6. Verify pack: `pnpm --filter @dorkos/desktop pack` (produces unsigned `.app` in `release/`)

7. Run `pnpm typecheck` and `pnpm lint` across all packages

---

## Testing Strategy

No unit or integration tests exist for `apps/desktop/` (the desktop app has no test suite currently). Verification is manual:

| Check            | Command                                              | Pass condition                                         |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Build succeeds   | `pnpm --filter @dorkos/desktop build`                | Exit 0, `dist/` populated                              |
| TypeScript clean | `pnpm typecheck`                                     | Zero errors                                            |
| Lint clean       | `pnpm lint`                                          | Zero errors                                            |
| Dev mode         | `pnpm --filter @dorkos/desktop dev`                  | Electron window opens, React app loads, HMR functional |
| Pack (unsigned)  | `pnpm --filter @dorkos/desktop pack`                 | `.app` produced in `release/mac-arm64/`                |
| native rebuild   | verify `better-sqlite3` loaded correctly in dev mode | No `NODE_MODULE_VERSION` mismatch error in console     |

**Native module rebuild note:** After bumping Electron from 33 to 39, the `better-sqlite3` native binary must be rebuilt for the new Electron ABI. electron-builder handles this automatically via `npmRebuild: true` in `electron-builder.yml`. For dev mode, `@electron/rebuild` must rebuild it manually on first run. If a `NODE_MODULE_VERSION` mismatch error appears in dev console, run:

```bash
cd apps/desktop && npx @electron/rebuild --version 39.8.5
```

---

## Performance Considerations

- Vite 7 (bundled in electron-vite v5) has improved HMR performance over Vite 6 — dev mode will be faster
- Electron 39 has no known performance regressions relevant to this app
- Build output size is unchanged (same config, same externalized deps)

---

## Security Considerations

- **Electron 39 graduates ASAR integrity to stable.** The desktop app uses `asar: true` in `electron-builder.yml`. ASAR integrity validation can now be enabled for production builds to detect tampering. This is a follow-up enhancement, not required for this upgrade.
- No new attack surface introduced by the version bumps
- `contextIsolation` and `nodeIntegration: false` remain unchanged in `BrowserWindow` options

---

## Documentation

No documentation changes needed. The upgrade is internal toolchain only.

---

## Open Questions

None — all decisions resolved in ideation.

**Resolved decisions:**

| Decision                    | Choice          | Rationale                                                                                |
| --------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| Electron target version     | Electron 39.8.5 | Last line with Node.js 22.x; electron-vite v5 has explicit build targets for Electron 39 |
| Upgrade Electron 40/41?     | No              | Electron 40+ ships Node.js 24; electron-vite v5 has no build target for it               |
| `@vitejs/plugin-react` v6?  | No              | Requires Vite 8; electron-vite v5 bundles Vite 7                                         |
| `@electron/rebuild` v4?     | No              | Breaking API changes may conflict with electron-builder's internal usage                 |
| Single-step vs incremental? | Single-step     | Diff is 3 version bumps + 3 config lines; no risk reduction from staging                 |

---

## Related ADRs

- [`decisions/0198-electron-vite-build-tooling.md`](../../decisions/0198-electron-vite-build-tooling.md) — Documents the original choice of electron-vite over Electron Forge

---

## References

- Ideation: `specs/upgrade-electron-vite/01-ideation.md`
- Research report: `research/20260401_electron_vite_upgrade_v3_to_v5.md`
- [electron-vite v4→v5 migration guide](https://electron-vite.org/guide/migration)
- [electron-vite CHANGELOG v3–v5](https://github.com/alex8088/electron-vite/blob/master/CHANGELOG.md)
- [Electron 39.0.0 release blog](https://www.electronjs.org/blog/electron-39-0) — ASAR integrity graduation, Node.js 22.20.0
- [Electron 40.0.0 release blog](https://www.electronjs.org/blog/electron-40-0) — Node.js 24 (why we skip this version)
