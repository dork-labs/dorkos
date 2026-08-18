# Jordan Lyall findings (0.61.0) — specification

Status: **specified 2026-08-18** — executing. Findings numbered as in [`00-findings.md`](00-findings.md) (F1…F16). Each section names the root cause **as reproduced**, the decision, and the acceptance bar. Work items map 1:1 onto `03-tasks.json` and the Linear project.

Conventions for every work item: isolated worktree from `origin/main` (`git gtr new <branch> --from origin/main --yes`), TDD (red before / green after for every fix), an adversarial review by a separate agent against `REVIEW.md` **before** the PR opens, a changelog fragment (`changelog/unreleased/<id>-<slug>.md`, `writing-for-humans` voice), and a real-browser (or packaged-app) proof in the PR body. Builders and reviewers run on Opus/Sonnet, never Fable.

---

## §A — The Mac app reports its own bundled Claude Code as missing (F2, F3, F4, F9, F11)

### Root causes (reproduced 2026-08-18 against the installed 0.61.0 `DorkOS.app`)

1. **F2 — "Claude Code CLI: missing" in the packaged app.** `GET /api/system/requirements` answered in **10 ms** with both Claude checks `missing` — no probe process ever ran. Mechanism (reproduced with a synthetic asar in a real Electron `utilityProcess`, see the orchestrator's `eprobe3` harness):
   - `resolveClaudeBinaryPath()` (`apps/server/src/services/runtimes/claude-code/tooling/claude-cli-auth.ts`) is `resolveBundledClaudeBinary() ?? findBinaryOnPath('claude')`. It **never consults `DORKOS_CLAUDE_CLI_PATH`**, the unpacked path the desktop shell hands the server (`apps/desktop/src/main/server-spawn.ts`), even though the SDK spawn path `resolveClaudeCliPath()` (`sdk/sdk-utils.ts`) does.
   - Inside the packaged app, `resolveBundledClaudeBinary()`'s `require.resolve` **succeeds** and returns `…/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` (Electron's asar fs patch makes `existsSync` true). The server bundle is **ESM**; `import { execFile } from 'node:child_process'` binds the _unpatched_ Node `execFile`, so spawning that `app.asar/…` path fails instantly with **`spawn ENOTDIR`**. (`require('child_process').execFile` — CJS — is asar-patched and works, which is why a CJS probe passes and the real bundle fails.)
   - `checkCliBinary`'s `catch {}` swallows the ENOTDIR (F3), `isClaudeCliAuthenticated` swallows the same error → both checks `missing`, state `connect`, "Install Claude".
   - The npm CLI is unaffected: no asar, `require.resolve` lands on a real file.
2. **F9 — Codex absent from the Mac app payload.** `new CodexRuntime()` calls `new Codex()` (SDK) eagerly; the SDK's `findCodexPath` throws `Unable to locate Codex CLI binaries` because **`@openai/codex-darwin-arm64` is not in the packaged `app.asar` at all** (it is a nested optional dependency of `@openai/codex`; electron-builder's pnpm collector never picked it up — verified by extracting the asar). `registerOptionalRuntime` swallows the throw, the runtime is never registered, the payload lacks `codex`, and the client still draws a Codex card from `config.runtimes`. The same packaging gap drops **`@esbuild/darwin-arm64`**, so the bundled `marketplace` extension fails to compile in the Mac app on every boot (`[Extensions] Compilation failed for marketplace … "@esbuild/darwin-arm64" could not be found`) — F10's "re-init loop right after boot" has this as one leg (§B has the other).
3. **F11 — `aggregateSessionList … Access denied: path outside directory boundary` on every Mac-app boot.** The desktop shell sets no `DORKOS_DEFAULT_CWD`, so `lib/resolve-root.ts` falls back to `path.resolve(thisDir, '../../../')`, which from `app.asar/dist/server` is **`/Applications/DorkOS.app/Contents/Resources`** — outside the `$HOME` boundary. `GET /api/directory/default` hands that path to the client, the session list asks for it, and the boundary refuses. `GET /api/config.workingDirectory` is `process.cwd()`, which for a Finder-launched app is `/` — also useless.
4. **PATH.** A Finder/Dock-launched app inherits launchd's `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Nothing under `~/.local/bin`, `~/.nvm/…`, `/opt/homebrew/bin` is findable, so every `which <binary>` rung fails in the Mac app for anything not bundled. This is why "packaging is the variable" for every runtime that is not vendored.

### Decisions

- **A1 (server, `apps/server`)**
  - One resolver for the Claude binary, shared by the probe and the SDK spawn: **env override (`DORKOS_CLAUDE_CLI_PATH`) → bundled → provisioned → PATH**. `resolveClaudeBinaryPath()` and `resolveClaudeCliPath()` must never disagree again (single function or one delegating to the other; the doc comment that today says "approximates" goes away).
  - **Asar-safe bundled resolution.** A shared helper (`services/runtimes/shared/asar-path.ts` or similar) maps `…/app.asar/<rest>` → `…/app.asar.unpacked/<rest>` when that unpacked file exists (Electron's documented convention). Applied to `resolveBundledClaudeBinary()` and `resolveCodexVendoredBinary()`. Unit-tested with a fake `app.asar/` + `app.asar.unpacked/` fixture on disk.
  - **F3: probes log.** `checkCliBinary` / `isClaudeCliAuthenticated` (and the codex/opencode twins) log the swallowed error at `warn` with the binary path and `err.code` (once per distinct binary+code to avoid spam). A user reading the server log must be able to see _why_ it is `missing`.
  - **F4: `POST /api/runtimes/claude-code/provision`.** Same SSE contract as codex/opencode (ADR-0317): installs `@anthropic-ai/claude-agent-sdk-<platform>-<arch>@<SDK version>` under `~/.dork/runtimes/claude-code` via `npm install --prefix`, version-locked to the SDK pin; a `resolveProvisionedClaudePath()` rung joins the ladder above. `checkClaudeDependencies` finds it; the SDK spawn uses it. The client's existing `ProvisionConnect` then works unchanged; verify in the browser that the error path (server without the route) still renders a message + manual hint (Jordan saw "nothing" — confirm what the client renders on a 404 and fix the copy if it is a bare `Not found`).
  - **F9 (server half): Codex client is lazy and ladder-driven.** `CodexRuntime` no longer constructs `new Codex()` in its constructor. It resolves the binary through `resolveCodexBinaryPath()` (config → vendored → provisioned → PATH) on first use and passes the result as `codexPathOverride`, so probe and spawn agree; when nothing resolves, the runtime **still registers** (so `checkDependencies` reports an honest `missing` + install hint and the card can offer one-click install) and a turn fails with a clear "Codex CLI not found — install it or set `runtimes.codex.binaryPath`" error. `registerOptionalRuntime` stays as the last-resort guard.
  - `GET /api/config.workingDirectory` reports `DEFAULT_CWD` (the boundary-clamped default), not `process.cwd()`; the ServerTab label stays "Working Directory".
- **A2 (desktop, `apps/desktop`)**
  - **Login-shell PATH for the server child.** `server-spawn.ts` resolves the user's login shell `PATH` once (`$SHELL -ilc 'printf %s "$PATH"'`, bounded ~5 s, fallback to the inherited PATH; skipped on Windows and in dev) and merges it into the child env. Logged at info with the resolved value's length/first entries, never the whole thing at warn.
  - **`DORKOS_DEFAULT_CWD` for the packaged server**: config `server.cwd` (validated inside the boundary, mirroring `packages/cli/src/cli.ts`'s clamp) else the user's home; also fork the utility process with `cwd` = that directory. Read `server.cwd`/`server.boundary` the same way `server-port.ts` reads `server.port`.
  - **Package the missing platform binaries**: `optionalDependencies` for `@openai/codex-darwin-arm64` (npm alias `npm:@openai/codex@<pin>-darwin-arm64`, `os`/`cpu` guarded like the Claude SDK ones), `@openai/codex-win32-x64`, `@esbuild/darwin-arm64`, `@esbuild/win32-x64` — pins locked to `@openai/codex` / `esbuild` in `apps/server/package.json`; `asarUnpack` globs for all four. Update the "wired so far" comments in `electron-builder.yml` and `.claude/rules/desktop.md`.
  - **`scripts/smoke-packaged.ts` grows discriminating assertions** (this is the desktop test Jordan asked for): `GET /api/system/requirements` lists **all three** runtimes and `claude-code`'s "Claude Code CLI" check is `satisfied` with a version (CI has no `claude` on PATH, so this can only pass through the bundled binary — red before A1, green after); `codex`'s CLI check is `satisfied` (vendored binary); `GET /api/directory/default` is inside the throwaway home; `GET /api/sessions` returns no `warnings`; server log contains no `Compilation failed for marketplace`. Runs in CI (`desktop-smoke.yml`, on PRs touching `apps/desktop`); A2 must show that run green.
  - Local packaging is allowed but sequenced (it rebuilds shared native modules; run `pnpm rebuild better-sqlite3 node-pty` afterwards, and never while sibling worktrees run vitest).

### Acceptance

- Packaged app (CI smoke + one local run by the orchestrator at the end): three runtimes in the payload; Claude Code CLI `satisfied`; codex CLI `satisfied`; opencode reports honestly; no boundary warning on boot; marketplace extension compiles; `~/.local/bin` binaries findable from a Finder launch (asserted by the smoke through a fake `PATH` dir when feasible, else by the login-shell resolution unit test + a manual launch note).
- npm cockpit unchanged (baseline payload captured 2026-08-18 in the orchestrator's session: all three satisfied except opencode auth).

---

## §B — Extension hygiene: "Ignoring the project copy" ×2 and the boot-time restart (F10)

### Root causes

- `ExtensionDiscovery.discover()` scans `<cwd>/.dork/extensions` as "local" without checking whether it **is** the global dir. When the working directory is `$HOME` (a Finder-launched app after A2, or `dorkos` run from `~`), local == `~/.dork/extensions`, so every core extension (hello-world, linear-issues, marketplace) is re-found as a "project copy" and warned about. Printed twice because `initialize(cwd)` at boot and the client's `POST /extensions/cwd-changed` → `updateCwd()` both call `discover()`.
- `ExtensionServerLifecycle.initialize()` unconditionally `shutdown()`s a running instance before re-initialising. The client's `extension-loader` POSTs `/extensions/:id/init-server` for every server extension on **every page load** (and every tab), so the marketplace extension server restarts on each load — the "shutdown/re-init loop right after boot".

### Decisions

- `discover()` skips the local scan when `path.resolve(cwd/.dork/extensions) === path.resolve(dorkHome/extensions)` (and, more generally, never lists the same directory twice). Test: cwd = dorkHome's parent → no warning, one record per extension.
- `initialize()` is **idempotent**: if the extension is already running and its `sourceHash` (and manifest) are unchanged, it returns `{ ok: true }` without restarting. Restarts happen only on a changed hash or an explicit reload path (`reloadExtension`, `enable`). Test: two `initialize` calls with the same record → one `Server shutdown` log at most on the _second_ only if changed; the client's per-load POST is now a no-op.
- `updateCwd(sameCwd)` is a no-op (no re-discovery) — cheap and removes the second warning.

### Acceptance

- Dev cockpit boot log with cwd `$HOME`: zero "Ignoring the project copy" lines; opening two browser tabs produces zero "Server shutdown for marketplace" lines.

---

## §C — Relay: the docs teach a subject the ACL cannot match; errors cross the boundary as empty successes; schemas are deferred (F5, F6, F8)

### Root causes

- **F5.** Canonical agent inbox subjects are `relay.agent.{namespace}.{agentId}` (`packages/mesh/src/relay-bridge.ts`); every allow rule is `relay.agent.{ns}.*`. The system prompt (`messaging/context-builder.ts` RELAY_TOOLS_CONTEXT lines "Subject hierarchy", workflows 1–4) and the tool schema `.describe()` strings (`mcp-tools/relay-tools.ts` `relay_send`, `relay_send_async`, `relay_send_and_wait`) all say **`relay.agent.{agentId}`** (two segments). Such a subject matches only the blanket `relay.agent.{ns}.* → relay.agent.>` deny → `ACCESS_DENIED`. `mesh_inspect` returns `relaySubject`; `mesh_list` (the tool the docs say to use) **does not**.
- **F6.** In `packages/relay/src/adapters/claude-code/agent-handler.ts`, the inbox-reply branch forwards only `text_delta`/`tool_call_start`/`tool_result` events. When the target's turn ends with an in-stream **`error` event followed by `done`** (an upstream API 500 surfaces this way — the iterator does not throw), `streamedDone` is true, no error is published, and `publishAgentResult(envelope, collectedText='')` sends `{type:'agent_result', text:'', done:true}`. The waiter (`relay-tools.ts` `createRelayQueryHandler`) already maps a terminal `error` payload to `AGENT_ERROR`, but never receives one on this path.
- **F8.** `mcp-tools/tool-exposure.ts` `ALWAYS_LOADED_TOOLS` is the five room tools + `list_capabilities`; every relay/mesh tool is deferred, so an agent doing agent-to-agent work pays a `ToolSearch` round trip inside its timeout budget.

### Decisions

- **F5.**
  - `mesh_list` returns `relaySubject` per agent (derived exactly as `inspect` does; namespace-stripped manifest is otherwise unchanged).
  - Docs + describe strings teach the canonical form: `relay.agent.{namespace}.{agentId}` — "use the `relaySubject` from `mesh_list`/`mesh_inspect`, never build it by hand". Update the "Subject hierarchy" block, all four workflows, and the three `.describe()` strings.
  - **Canonicalise before ACL**: `relay_send`, `relay_send_async`, `relay_send_and_wait` accept a bare `relay.agent.<agentId>` (2 segments where segment 2 is a registered mesh agent id) and rewrite it to that agent's canonical subject before publish (log at debug). Anything else passes through unchanged. Unit test both the rewrite and the pass-through (a 2-segment subject whose second segment is a session id, the legacy routing shape, must not be touched).
- **F6.** The CCA inbox branch records `event.type === 'error'` (message from `event.data.message`) and the terminal `agent_result` gains an optional **`error: string`** (`RelayAgentResultPayloadSchema`); on error, `text` is whatever was collected. `createRelayQueryHandler` maps `agent_result.error` to `AGENT_ERROR` (same shape as today's error-event branch, with `partialText`). Docs teach the poller (`relay_send_async` + `relay_inbox`) that a `done:true` payload may carry `error`. Regression test: a fake stream yielding `error` then `done` → the waiter returns `AGENT_ERROR`, never a success-shaped empty reply.
- **F8.** Tool exposure becomes context-aware: for a session whose sender identity resolves to a **registered mesh agent** and relay is enabled, `mesh_list`, `mesh_inspect`, `relay_send`, `relay_send_async`, `relay_send_and_wait`, `relay_inbox` are `alwaysLoad`. Plain sessions keep today's exposure. The RELAY_TOOLS_CONTEXT tells agent sessions those six are already in the tool list. Measure the added prompt weight in the PR body (six schemas).

### Acceptance

- Live test in a dev cockpit: two fresh agents in different namespaces, an allow rule a→b, agent a told to "ask b …" following its own system prompt (no hand-holding) → succeeds. Then remove the rule → `ACCESS_DENIED` with hint. Then simulate a failing target (e.g. invalid model) → caller receives `AGENT_ERROR`, not an empty answer. Transcript excerpts + tool-call log in the PR.

---

## §D — A fresh mesh is fully disconnected and nothing says so (F7)

### Root cause

Every agent lands in its own namespace (managed agents under `~/.dork/agents/<slug>` derive `namespace = <slug>` from the scan root), with the default `same-namespace allow` / `cross-namespace deny`. Two agents created in the app cannot talk until the operator adds a directional pair rule in Team → Access — N agents = N·(N−1) grants — and nothing during onboarding or agent creation says so; the agent discovers it mid-task.

### Decision (deny-by-default stays; the switch becomes one click and visible)

- **One mesh-wide switch: "Let all my agents talk to each other."** Persisted as a topology rule `* → *` (projected into Relay as `relay.agent.> → relay.agent.>` allow at the cross-namespace-allow priority). `PUT /api/mesh/topology/access` accepts `sourceNamespace: '*'`/`targetNamespace: '*'`; `GET /api/mesh/topology` reports it as `openMesh: true` (or the equivalent field the client reads). DorkBot's bridge rules unaffected.
- **Team → Access UI**: a switch at the top of the Access view with honest copy (what it grants, that it is off by default, that per-pair rules still work when it is off). When on, the pair-grant controls read as "already allowed by the mesh-wide switch".
- **Surface it where the wall is hit**: (a) the agent-creation flow shows a one-line notice with the switch inline when ≥1 other agent exists and the switch is off; (b) `ACCESS_DENIED_HINT` and the RELAY_TOOLS_CONTEXT mention the switch by name; (c) `mesh_query_topology` output includes `openMesh`.
- **Not done here** (filed follow-up): a namespace-model rethink so managed agents share a namespace by default. That is a migration with ACL implications; the switch delivers the same outcome today without changing anyone's stored rules.

### Acceptance

- Browser: create two agents on a fresh `DORK_HOME`, see the notice, flip the switch, agent a reaches b (relay tool call succeeds) with no pair rule; flip off → denied. Screenshots in the PR.

---

## §E — Marketplace: consent without paths, and your own packages buried (F12, F13)

### Root causes

- The install preview already carries `fileChanges[] {path, action}`; `format-permissions.ts` collapses it to a count.
- Browse lists 298 packages, 289 mirrored from `claude-plugins-official`, with no source facet and a "Featured" default sort that does not distinguish DorkOS-native packages.

### Decisions

- **F12.** The effects row states counts **per action** and the common root ("134 files under `~/.dork/plugins/flow` — 130 created, 4 modified, 0 deleted"), with an expandable list (deletes and modifies first, then creates; paths shown relative to the common root; a "everything stays inside `~/.dork`" line when true, an explicit warning when not). Keyboard-accessible; tested in RTL and in the browser.
- **F13.** A **Source** facet in the marketplace sidebar (counts per source, e.g. `dork-labs/marketplace`, `claude-plugins-official`, custom sources), and the default sort ranks DorkOS-native packages ahead of mirrored ones. Cards show a subtle source label. Search unchanged.

### Acceptance

- Browser: install preview for the flow plugin shows the root + per-action counts + list; the marketplace opens with DorkOS packages first and the source facet filters. Screenshots in the PR.

---

## §F — Flow plugin (dork-labs/marketplace, `plugins/flow`) (F1, F14, F15, F16)

### Root causes

- **F1.** `scripts/config-schema.ts` `TrackerSchema = z.enum(['linear'])` (and the generated `config/config.schema.json`) reject any tracker `/flow:init` recommends other than Linear; 42 prose references hard-code `linear-adapter` although init generates `skills/<tracker>-adapter/SKILL.md`.
- **F14.** The runtime scripts (`config-schema.ts`, `dispatch-policy.ts`, `flow-state.ts`, …) import `zod`, but `package.json` lists it only under `devDependencies` and claims the runtime is dependency-free; a shell with `NODE_ENV=production`/`omit=dev` installs nothing, so `validate-config.ts` cannot run. `npm audit` shows 3 high (dev-transitive: fast-uri, nanoid, postcss; `npm audit fix` available).
- **F15.** Init Step 4 resolves the rubric with `git rev-parse --show-toplevel`, which fails outside a repo, so no `REVIEW.md` is scaffolded and the verify stage silently reviews without a rubric.
- **F16.** Init Step 5 calls the pure policy oracle `dispatch.ts` and calls it "a dry dispatch that reaches the adapter"; it never touches the tracker.

### Decisions

- **F1.** `tracker` becomes a validated slug (`^[a-z][a-z0-9-]*$`; `linear` documented as the reference); regenerate `config.schema.json`; every generic command/skill refers to "the tracker adapter skill (`<tracker>-adapter`, per `config.tracker`; `linear-adapter` in this repo)". Add an engine test asserting no generic (non-adapter) skill hard-codes `linear-adapter` as the only name.
- **F14.** `zod` moves to `dependencies`; the package.json description tells the truth; init Step 1's toolchain check runs `validate-config.ts` and, on `ERR_MODULE_NOT_FOUND`, runs (or instructs) `npm install --omit=dev --prefix <flow-root>`; the DorkOS-side install path (harness sync / plugin install) is checked for whether it runs `npm install` for a plugin with `dependencies` — if not, file it. `npm audit fix` applied.
- **F15.** Rubric path resolution: repo root when inside a repo, else the current working directory; the verify skill **says loudly** ("no rubric at X — reviewing without one; run /flow:init") instead of degrading silently.
- **F16.** Step 5 = (1) a real adapter read (`getCurrentUser` + list the configured team) as the connectivity proof, then (2) the dispatch oracle over the real candidate set, both labelled honestly ("policy check, no tracker call" for the oracle).

### Acceptance

- Plugin tests green; `validate-config.ts` accepts `tracker: "github"`; a fresh `npm install --omit=dev` is enough to run every runtime script; `npm audit` clean.

---

## What is deliberately not done

- Namespace-model migration for managed agents (§D follow-up).
- Bundling `opencode` into the desktop app (it stays provisioned on demand, unchanged).
- Anything about Codex turn behaviour beyond registration/status.
