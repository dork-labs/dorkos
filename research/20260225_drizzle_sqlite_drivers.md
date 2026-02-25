# Drizzle ORM SQLite Driver Options — Research Report

**Date:** 2026-02-25
**Research Mode:** Deep Research
**Searches Performed:** 14
**Primary Sources:** Drizzle ORM official docs, npm registries, GitHub issues, Turso engineering blog

---

## Research Summary

Drizzle ORM supports six distinct SQLite driver families as of early 2026. Two are relevant to a Node.js/Electron context: `better-sqlite3` (native C++ binding) and `@libsql/client` (native Rust/N-API binding). A third, `sql.js`, provides a pure-WASM zero-native-dependency option but has no official first-party Drizzle documentation page, only a legacy demo repo. `drizzle-orm` itself has zero native dependencies — all native code lives exclusively in the chosen driver package.

---

## Key Findings

### 1. Drizzle ORM Itself Has No Native Dependencies

`drizzle-orm` is pure TypeScript/JavaScript. It has no C++, Rust, or WASM code of its own. All native code resides in the driver package passed to `drizzle()`. This means the ORM layer is safe to install in any environment without rebuild concerns.

### 2. Supported SQLite Drivers (Full Inventory)

| Driver | Import Path | Execution Model | Native Code | Target Environment |
|--------|------------|----------------|-------------|-------------------|
| `better-sqlite3` | `drizzle-orm/better-sqlite3` | Synchronous | C++ via node-gyp | Node.js / Electron |
| `@libsql/client` | `drizzle-orm/libsql` | Asynchronous | Rust via N-API `.node` binaries | Node.js / Electron / Edge |
| `@libsql/client-wasm` | `drizzle-orm/libsql` | Asynchronous | WASM (experimental) | Browser / Worker |
| `bun:sqlite` | `drizzle-orm/bun-sqlite` | Synchronous | Native (Bun runtime) | Bun only |
| `expo-sqlite` | `drizzle-orm/expo-sqlite` | Asynchronous | Native (JSI) | React Native (Expo) |
| `@op-engineering/op-sqlite` | `drizzle-orm/op-sqlite` | Asynchronous | Native (JSI) | React Native |
| Cloudflare D1 | `drizzle-orm/d1` | Asynchronous | None (remote) | Cloudflare Workers |
| SQLite Cloud | `drizzle-orm/sqlite-proxy` | Asynchronous | None (remote) | Any |
| `sql.js` | (legacy, see below) | Synchronous | WASM | Browser / Node.js |

### 3. better-sqlite3 — Native C++ Binding

- Implemented in C++ using node-gyp. Compiles a platform-specific `.node` binary at install time.
- **Synchronous** API — all reads and writes block the thread.
- Electron ships its own modified Node.js runtime (different ABI from system Node). This causes the well-known `NODE_MODULE_VERSION` mismatch when loading a `better-sqlite3` binary compiled for system Node inside Electron.
- **Proven workarounds:**
  1. Run `@electron/rebuild` after `npm install` to recompile the `.node` binary against Electron's headers.
  2. Run drizzle-kit migrations using `ELECTRON_RUN_AS_NODE=1 electron ./node_modules/drizzle-kit/bin.cjs migrate` to use Electron's own Node.js runtime.
  3. Use `electron-forge` rebuild config with `asar` unpack settings to ensure `.node` and `.dylib` files are not compressed inside the archive.
- Source: [better-sqlite3 GitHub Issue #1171](https://github.com/WiseLibs/better-sqlite3/issues/1171)

### 4. @libsql/client — Native Rust/N-API Binding

- libSQL is an open-contribution fork of SQLite, maintained by Tursodatabase (formerly Turso).
- The Node.js driver (`libsql` npm package) is written in Rust and compiled to platform-specific `.node` binaries via N-API (specifically using the Neon framework).
- Pre-built binaries are distributed as separate npm packages named `@libsql/<target>` (e.g., `@libsql/darwin-arm64`, `@libsql/linux-x64-gnu`). The correct one is loaded at runtime by `@neon-rs/load`.
- **This means `@libsql/client` also requires native module rebuilding for Electron**, just like `better-sqlite3`. The mechanism is N-API instead of node-gyp, but the ABI incompatibility problem is identical.
- Known cross-compilation issue: when building Electron apps for both arm64 and x64 on an ARM Mac, only the `darwin-arm64` package installs, not `darwin-x86_64`.
- Source: [libsql-js GitHub](https://github.com/tursodatabase/libsql-js), [Turso engineering blog](https://turso.tech/blog/building-a-better-sqlite3-compatible-javascript-package-with-rust-a388cee9), [libsql-client-ts Issue #224](https://github.com/tursodatabase/libsql-client-ts/issues/224)

### 5. sql.js — Pure WASM, No Native Dependencies

- `sql.js` is SQLite compiled to WebAssembly via Emscripten. It has **zero native C++/Rust `.node` bindings**.
- Runs anywhere JavaScript runs: browsers, Node.js, Electron's renderer or main process — without any rebuild step.
- Drizzle ORM has historical support for sql.js via the `drizzle-team/drizzle-sqljs` demo repo (January 2023). The import path was `drizzle-orm/sql-js`.
- **There is no dedicated first-party Drizzle ORM documentation page for sql.js** as of the current docs site. The feature is not prominently listed in `get-started-sqlite` or `connect-overview`.
- The demo repo (`drizzle-team/drizzle-sqljs`) has 17 commits and minimal activity, treating sql.js as a working but non-primary integration.
- Migrations via `drizzle-kit` remain problematic in WASM/browser environments — the built-in migrate function is Node.js-only.
- A community library exists for browser-based Drizzle migrations (`proj-airi/drizzle-orm-browser`).
- Source: [drizzle-team/drizzle-sqljs](https://github.com/drizzle-team/drizzle-sqljs), [Issue #193](https://github.com/drizzle-team/drizzle-orm/issues/193)

### 6. Recommended Driver for Electron

No official Drizzle recommendation for Electron exists in the documentation. Based on real-world reports:

- **better-sqlite3** is the most commonly used in Electron apps with Drizzle. It is well-documented, synchronous (convenient for Electron's main process), and has established rebuild tooling (`@electron/rebuild`, `electron-forge` rebuild config).
- **@libsql/client** is also usable in Electron but has the same native rebuild requirement and a known cross-compilation issue for dual-arch macOS builds.
- **sql.js** is the only option that avoids native module rebuild entirely — no `@electron/rebuild` step needed, no ABI mismatch — but it is an in-memory database by default, and Drizzle's support for it is legacy/undocumented. Persistence requires manually exporting and writing the database buffer to disk.

A working Electron + Drizzle demo exists at [djyde/electron-drizzle-sqlite-demo](https://github.com/djyde/electron-drizzle-sqlite-demo) (driver used: not confirmed from public metadata, but likely better-sqlite3 based on the drizzle-kit command used in its README).

---

## Detailed Analysis

### Native vs. WASM Dependency Matrix

```
Driver              | Node.js install | Electron (main) | Browser | WASM?
--------------------|-----------------|-----------------|---------|------
better-sqlite3      | node-gyp build  | rebuild needed  | No      | No
@libsql/client      | pre-built .node | rebuild needed  | No      | via @libsql/client-wasm (experimental)
@libsql/client-wasm | none            | none            | Yes     | Yes (experimental)
sql.js              | none            | none            | Yes     | Yes
bun:sqlite          | n/a (Bun only)  | No              | No      | No
expo-sqlite         | n/a (React Native) | No           | No      | No
```

### drizzle-kit and Native Modules in Electron

`drizzle-kit` (the migration CLI tool) runs in the system's Node.js, not Electron's embedded runtime. If `better-sqlite3` has been rebuilt for Electron, `drizzle-kit` will fail to load it due to the ABI mismatch (inverse of the usual problem).

**Solution confirmed by the community:** Run drizzle-kit through Electron's own Node.js runtime:
```bash
ELECTRON_RUN_AS_NODE=1 electron ./node_modules/drizzle-kit/bin.cjs generate
ELECTRON_RUN_AS_NODE=1 electron ./node_modules/drizzle-kit/bin.cjs migrate
```

### libSQL vs better-sqlite3 API Differences

- `better-sqlite3` is synchronous. `@libsql/client` is asynchronous (Promise-based).
- `@libsql/client` supports additional `ALTER TABLE` operations that SQLite's default restrictions block.
- `@libsql/client` supports remote Turso databases via `wss://` and `https://` URLs — `better-sqlite3` is local-only.
- `@libsql/client/sqlite3` sub-import is a synchronous local-only mode using the `sqlite3` npm package as its backend.

---

## Sources & Evidence

- Official Drizzle SQLite get-started: [Drizzle ORM - SQLite](https://orm.drizzle.team/docs/get-started-sqlite)
- Official Drizzle connection overview: [Drizzle ORM - Database connection](https://orm.drizzle.team/docs/connect-overview)
- libsql-js repository and N-API architecture: [tursodatabase/libsql-js](https://github.com/tursodatabase/libsql-js)
- Turso engineering blog on Rust/Neon bindings: [Building a better-sqlite3 compatible package with Rust](https://turso.tech/blog/building-a-better-sqlite3-compatible-javascript-package-with-rust-a388cee9)
- better-sqlite3 + Electron ABI issue and drizzle-kit workaround: [better-sqlite3 Issue #1171](https://github.com/WiseLibs/better-sqlite3/issues/1171)
- sql.js WASM support GitHub issue (backlog as of Aug 2025): [Issue #193](https://github.com/drizzle-team/drizzle-orm/issues/193)
- drizzle-sqljs demo (legacy): [drizzle-team/drizzle-sqljs](https://github.com/drizzle-team/drizzle-sqljs)
- libsql Electron build issue: [libsql Issue #128](https://github.com/tursodatabase/libsql/issues/128)
- libsql-client-ts dual-arch macOS issue: [Issue #224](https://github.com/tursodatabase/libsql-client-ts/issues/224)
- Electron native modules official docs: [Native Node Modules | Electron](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- Electron rebuild tool: [electron/rebuild](https://github.com/electron/rebuild)
- Real-world 2024 Electron SQLite packaging challenges: [Thought Eddies](https://www.danielcorin.com/posts/2024/challenges-building-an-electron-app/)
- Electron + Drizzle demo: [djyde/electron-drizzle-sqlite-demo](https://github.com/djyde/electron-drizzle-sqlite-demo)
- DeepWiki Drizzle SQLite overview: [SQLite and Mobile Support | drizzle-team/drizzle-orm | DeepWiki](https://deepwiki.com/drizzle-team/drizzle-orm/6.3-sqlite-and-mobile-support)

---

## Research Gaps & Limitations

- The `drizzle-orm/sql-js` import path was not directly verified against a current Drizzle release — the docs page for sql.js is absent from the current site navigation. The feature may be present but undocumented, or it may have been quietly removed.
- No authoritative Drizzle documentation states a recommended driver specifically for Electron.
- The `@libsql/client-wasm` package is marked experimental in Drizzle docs — its production readiness is unknown.
- Actual package.json contents of `djyde/electron-drizzle-sqlite-demo` were not inspectable from the web fetch.

---

## Search Methodology

- Searches performed: 14
- Key search terms: `drizzle orm sqlite drivers`, `drizzle orm electron native module`, `libsql npm N-API native bindings`, `drizzle orm sql.js wasm`, `better-sqlite3 electron rebuild`, `libsql electron build issue`
- Primary source domains: `orm.drizzle.team`, `github.com`, `turso.tech`, `npmjs.com`, `electronjs.org`
