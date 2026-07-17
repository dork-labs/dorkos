# Tasks — MCP local-auth posture (close the unauthenticated localhost surface)

**Spec:** `specs/mcp-local-auth-posture/02-specification.md` · **Slug:**
`mcp-local-auth-posture` · **Tracker:** DOR-278 (HIGH · posture · under the
DOR-272 security umbrella) · **Mode:** full · **Generated:** 2026-07-16

11 tasks across 4 phases. The change is transport-layer and additive
(`FakeAgentRuntime` is untouched). **Phase 1** builds the per-instance `0600`
local-token substrate and wires it into boot. **Phase 2** is the security core:
the `READ_ONLY_MCP_TOOL_NAMES` SSOT + drift guard, then the atomic middleware
rewrite that deletes the passthrough, adds the local-token acceptor and the
read-only carve-out, and re-wires all three mounts — **plus the full matrix
tests, in the same task.** **Phase 3 runs fully in parallel with Phase 2** (no
shared files: config DTO + client vs middleware + mounts) and covers the
`ServerConfig.mcp` DTO, the rotate route, and the settings UI. **Phase 4** is
docs + a breaking-change changelog fragment + a draft ADR. Tests live in the
phase that verifies them (`__tests__/` alongside source), never bunched at the
end.

## The security-ordering invariant (why 1.2 → 2.2 and why 2.2 is atomic)

The passthrough deletion and the local-token acceptor must never be split across
commits. Delete the passthrough without a working acceptor and every legitimate
client hard-locks on 401; add the acceptor without deleting the passthrough and
the surface stays open. So **task 2.2 is atomic** — passthrough deletion +
local-token acceptor + read-only carve-out + the three mount re-wirings + the
full middleware matrix tests all land together. And **2.2 depends on 1.2**
(boot wiring): the acceptor compares against `getMcpLocalToken()`, which is only
populated once boot resolves the token — so the token must be resolvable at boot
before the passthrough is removed.

## Dependency graph

```
P1:  1.1 (token module + tests) → 1.2 (boot wiring)
     2.1 (SSOT + drift test)                      [∥ 1.1, 1.2 — new file, no shared edits]

P2:  2.2 (ATOMIC: middleware rewrite + 3 mounts + matrix)   deps: 1.2, 2.1
     2.3 (integration tests)                                deps: 2.2

P3:  3.1 (DTO authSource 'local-token' + localToken + rotate route + OpenAPI)   deps: 1.1
     3.2 (client display + honest states)                                       deps: 3.1
     3.3 (rotate: Transport method + button)                                     deps: 3.2, 1.1

     Phase 2 ∥ Phase 3  (mcp-auth.ts + index.ts  vs  config.ts + schemas.ts + client)

P4:  4.1 (docs)             deps: 2.3, 3.3
     4.2 (changelog)        deps: 2.2, 3.1
     4.3 (draft ADR)        deps: 2.2
```

Compact form: `1.1→1.2; 2.1 (∥1.1,1.2); {1.2,2.1}→2.2→2.3; 1.1→3.1→3.2→3.3; (P2 chain ∥ P3 chain); 4.1←{2.3,3.3}; 4.2←{2.2,3.1}; 4.3←2.2`.

**Mutually independent (parallelizable):** `2.1 ∥ {1.1, 1.2}` (the SSOT is a new
file with no shared edits). **All of Phase 2 ∥ all of Phase 3** — the rotate
route lives on the already-mounted config router (`/api/config`, `app.ts:120`),
so Phase 3 never touches `index.ts`, and the two phases share no files. Inside
Phase 3 the client chain `3.1 → 3.2 → 3.3` is sequential (3.2 and 3.3 both edit
`ExternalMcpCard.tsx`; 3.2 needs 3.1's DTO type). No task reaches `xl`, so none
is promoted to its own sub-issue (threshold `xl`).

---

## Phase 1 — Token substrate

### Task 1.1: `mcp-local-token.ts` substrate + unit tests

New `apps/server/src/services/core/auth/mcp-local-token.ts`, a near-clone of the
sibling `secret.ts`: `resolveMcpLocalToken(dorkHome)` (env override → persisted
`0600` file → generate `dork_mcp_local_<64 hex>` + persist, with a lax-permission
repair pass), `rotateMcpLocalToken(dorkHome)`, and the module-level cache
accessors `getMcpLocalToken()` / `getMcpLocalTokenPath()` the middleware and DTO
read without a per-request file read. Unit tests mirror `secret.test.ts` (env
wins; stable across restarts; first-boot generate + `0600`; lax perms repaired;
rotate writes a new value; prefix + hex length).

- size: md · priority: high · deps: none · parallelWith: 2.1 · cites spec §Detailed Design 1, §Testing (Unit — token substrate)

### Task 1.2: Resolve the local token once at server boot

Wire the resolution into `index.ts` beside `initAuth` / `seedLegacyMcpApiKey`
(~lines 242-249): call `resolveMcpLocalToken(dorkHome)` **only when login is off
and `MCP_API_KEY` is unset**, populating the cache `getMcpLocalToken()` reads.
When `MCP_API_KEY` is set or login is on, do not resolve (cache stays null; the
acceptor is inert). **Security-ordering edge:** this must land before 2.2 deletes
the passthrough, or the acceptor has no token to match.

- size: sm · priority: high · deps: 1.1 · parallelWith: 2.1 · cites spec §Detailed Design 1 (Generation timing)

---

## Phase 2 — Middleware + carve-out SSOT

### Task 2.1: `READ_ONLY_MCP_TOOL_NAMES` SSOT + drift-guard test

New `apps/server/src/services/core/external-mcp/tool-security.ts` exporting the
`ReadonlySet<string>` of exactly the 23 read-only tool names (any name not in it
is guarded — fail-closed). The drift test spins up `createExternalMcpServer`
(with mock deps **and** marketplace deps so all 23 register), issues `tools/list`
over a transport, and asserts the set equals exactly the tools with
`annotations.readOnlyHint === true` — both directions, plus `size === 23`. Locks
the constant so it can never drift from the annotations.

- size: md · priority: high · deps: none · parallelWith: 1.1, 1.2 · cites spec §'read-only carve-out SSOT', §readOnlyHint audit, §Testing (drift guard)

### Task 2.2: `createMcpAuth({surface})` rewrite + rewire 3 mounts + full matrix (ATOMIC)

**The security core, atomic.** Rewrite `middleware/mcp-auth.ts` into a
`createMcpAuth({ surface: 'mcp' | 'a2a' })` factory: common acceptors (env key,
`verifyRequestAuth`, legacy key, **new local-token acceptor** vs
`getMcpLocalToken()` when login off); **delete the passthrough** (`mcp-auth.ts:63-68`);
on no-match apply the login-off carve-out — `surface: 'mcp'` peeks `req.body` to
allow discovery + read-only `tools/call` and 401 everything else (batches
all-or-nothing, unparseable → 401, fail-closed); `surface: 'a2a'` allows
agent-card `GET` and 401s JSON-RPC `POST`. Helpful 401 bodies name the token
**file path** (`getMcpLocalTokenPath()`) and the `Authorization: Bearer` header,
never the value. Re-wire `/mcp` (surface `mcp`) and the two well-known cards +
`/a2a` (surface `a2a`) in `index.ts`. Extend `mcp-auth.test.ts` with the FULL
matrix in the same task (add `req.body` + `req.method` to the mock harness).

- size: lg · priority: high · deps: 1.2, 2.1 · parallelWith: 3.1, 3.2, 3.3 · cites spec §Detailed Design 3 (rewrite + logic table), §Helpful 401 bodies

### Task 2.3: End-to-end integration tests

Extend `routes/__tests__/mcp-integration.test.ts` + `middleware/__tests__/mcp-auth.integration.test.ts`
through the real `/mcp` mount with the live auth wired: a tokenless read-only
call succeeds; a tokenless mutating call 401s with the helpful body (path +
Bearer, no token value); the same call with the local token succeeds; a tokenless
`resources/read` 401s. Existing harness — no new one.

- size: md · priority: high · deps: 2.2 · parallelWith: 3.1, 3.2, 3.3 · cites spec §Testing (Integration — end-to-end auth)

---

## Phase 3 — Config DTO + client (∥ Phase 2)

### Task 3.1: `ServerConfig.mcp` DTO + rotate route + OpenAPI regen + tests

`schemas.ts`: add `'local-token'` to `authSource` and a nullable optional
`localToken` field. `routes/config.ts`: populate `authSource === 'local-token'`
(login off, no env key, no user/legacy key, token available) and emit
`localToken` **only** in that mode; `'none'` remains only as the degenerate
can't-generate fallback (`authConfigured` stays true for local-token). Add
`POST /api/config/mcp/rotate-token` to the config router (already mounted at
`/api/config` — no `index.ts` edit) → `rotateMcpLocalToken(dorkHome)`, returns
`{ localToken }`, 409 when `MCP_API_KEY` is set or login is on. Regenerate
`docs/api/openapi.json` (`pnpm docs:export-api`). **No `UserConfigSchema` change,
no `conf` migration** (the token is a file). Extend `config-mcp.test.ts`.

- size: md · priority: high · deps: 1.1 · parallelWith: 2.2, 2.3 · cites spec §Detailed Design 2 (no persisted-config change), §Detailed Design 4, §Testing (Route — rotate + DTO)

### Task 3.2: `ExternalMcpCard` local-token display + honest states + tests

Pass `mcp.localToken` into `SetupInstructions` so the paste-ready per-client
config pre-fills the real `Authorization: Bearer dork_mcp_local_…` header (today
it passes `null`, `ExternalMcpCard.tsx:125`). Add a `'local-token'` branch to
`McpAuthRow` (KeyRound row, token in a copy field, Copy button). Keep the other
states honest: `'env'` → environment-variable badge; `'user-keys'` → personal-key
guidance (token hidden); degenerate `'none'` → an honest "couldn't generate"
note. Header badge reads green **Enabled** for local-token (authConfigured true),
amber **No auth** only for `'none'`. Tests in `ExternalMcpCard.test.tsx` +
`external-mcp-snippets.test.ts` (token vs placeholder).

- size: md · priority: high · deps: 3.1 · parallelWith: 2.2, 2.3 · cites spec §Detailed Design 4 (client, honest states), §User Experience
- _Rotate is carved out into 3.3 — keep this task display + snippets + honest states only._

### Task 3.3: `Transport.rotateMcpLocalToken` + Rotate button + tests

Add the required `rotateMcpLocalToken(): Promise<{ localToken }>` to the
`Transport` interface and implement it in `HttpTransport` (POST the rotate route),
`DirectTransport` (in-process, mirroring `getConfig`), and the `mock-factories`
mock. Add the **Rotate** button to the local-token `McpAuthRow`: a confirm dialog
that plainly warns rotating breaks configured clients until they re-paste, then
calls the transport and invalidates the `['config']` query so the new token +
snippets re-render. Tests in `ExternalMcpCard.test.tsx`.

- size: md · priority: high · deps: 3.2, 1.1 · parallelWith: 2.2, 2.3 · cites spec §Detailed Design 4 (Rotate), §User Experience (Rotate)

---

## Phase 4 — Docs, changelog, ADR

### Task 4.1: Docs — MCP/self-hosting token step + A2A auth note

Add the one-time `Authorization: Bearer` header step and where to find the token
(Settings → Server → External MCP, or the `mcp-local-token` file) to the
external-MCP / self-hosting docs. Note the A2A auth requirement in login-off mode
**without** claiming Mesh+Relay/A2A works end-to-end (demo-claim gate).
`writing-for-humans` throughout; `docs:coverage` green if a page is added.

- size: sm · priority: medium · deps: 2.3, 3.3 · parallelWith: 4.2, 4.3 · cites spec §Documentation

### Task 4.2: Changelog fragment — breaking hard-cut

`changelog/unreleased/<id>-mcp-local-auth-posture.md` (timestamp-id filename,
no frontmatter, `### Security` + `### Changed`). Plain, user-facing
(`writing-for-humans`): with login off, tools that change things and A2A calls
now need a one-time token you paste into your MCP client (found in Settings →
Server → External MCP or the token file); read-only checks still work tokenless;
no grace period. Reference `(DOR-278)`. No unverified end-to-end claims.

- size: sm · priority: medium · deps: 2.2, 3.1 · parallelWith: 4.1, 4.3 · cites spec §Documentation (Changelog fragment), changelog/README.md

### Task 4.3: Draft ADR — default-on local MCP token with a `readOnlyHint` carve-out

Draft the proposed ADR (prefer `/adr:from-spec`): the per-instance `0600` token,
the fail-safe read-only carve-out keyed off `readOnlyHint`, the hard-cut rollout,
and A2A execution always token-gated. Supersedes ADR-0103's passthrough branch;
extends ADR-0320's login-off path; cross-links ADR-0227/0315/0311.

- size: sm · priority: low · deps: 2.2 · parallelWith: 4.1, 4.2 · cites spec §Related ADRs

---

## Verification (VERIFY stage)

Per-task `Verify:` commands are targeted (`pnpm --filter <pkg> typecheck`,
`pnpm vitest run <path>`, `pnpm docs:export-api`). Whole-feature close-out:
`pnpm verify` (affected typecheck + lint + test), plus the spec's Acceptance
Criteria — the passthrough is gone; a login-off mutating `tools/call` 401s
tokenless and succeeds with the token while read-only calls stay tokenless;
`/a2a` `POST` is token-gated and card `GET` is open; `READ_ONLY_MCP_TOOL_NAMES`
equals exactly the 23 read-only tools (drift guard); the settings tab shows the
token + Copy + Rotate with honest env/login-on states; `UserConfigSchema` is
unchanged with no `conf` migration; `FakeAgentRuntime` is untouched.
