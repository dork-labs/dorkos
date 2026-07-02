# Codex SDK Verification Notes — task 2.2 (additional-agent-runtimes)

Verification of the permission/sandbox/approval mapping against `@openai/codex-sdk@0.142.5`
(pinned; bundles CLI `@openai/codex@0.142.5`). Consumed by tasks 2.4 (event mapper) and
2.5 (facade). Written 2026-07-02.

## Evidence basis

No system `codex` install exists on this machine, but the SDK vendors the exact pinned CLI
binary via optional deps, so most findings are **live-verified against the real pinned
binary**, not just types:

- SDK types: `apps/server/node_modules/@openai/codex-sdk/dist/index.d.ts`
- SDK implementation: `apps/server/node_modules/@openai/codex-sdk/dist/index.js` (readable tsup output)
- Vendored CLI binary (live probes, isolated `CODEX_HOME` in the session scratchpad — no real
  `~/.codex` state touched, no authenticated turns run):
  `node_modules/.pnpm/@openai+codex@0.142.5-darwin-arm64/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex`
  (`codex --version` → `codex-cli 0.142.5`)
- Docs: developers.openai.com/codex (`/noninteractive`, `/agent-approvals-security`, `/config-reference`)
- GitHub: openai/codex issues #24135, #28224, #29463, #17320

Items that still need a **live re-verification with an authenticated login** are flagged
`LIVE-VERIFY` below. Everything else was directly observed.

---

## Verdict 1: Tool approvals — `supportsToolApproval: false`

The SDK provides **no interactive approval channel**. Declare `supportsToolApproval: false`
and model Codex permission posture as upfront mode selection (sandbox level), not
interactive gating. This is the honest, spec-aligned outcome — capability flags gate the
approval UI off.

Evidence (each independently sufficient):

1. **No approval event type.** The stream union is exactly 8 events
   (`thread.started`, `turn.started`, `turn.completed`, `turn.failed`,
   `item.started/updated/completed`, `error`) — `dist/index.d.ts:106-165`. Nothing carries
   an approval request, and no SDK method answers one.
2. **stdin is closed after the prompt.** `dist/index.js` (`CodexExec.run`):
   `child.stdin.write(args.input); child.stdin.end();` — there is physically no channel to
   deliver an approval response to the subprocess mid-turn.
3. **`codex exec` has no approval flag.** Live `codex exec --help` at 0.142.5 offers only
   `--sandbox` and `--dangerously-bypass-approvals-and-sandbox`; approval policy is only
   reachable as a `-c approval_policy=...` config override (which is exactly how the SDK
   passes `ThreadOptions.approvalPolicy`).
4. **Approval-requiring calls are auto-cancelled in exec mode.** openai/codex#24135:
   MCP tool calls needing approval in `codex exec` fail with "user cancelled MCP tool call"
   (stdin EOF read as rejection); even `approval_policy = "never"` did not convert them to
   auto-approvals. The only bypass is `--dangerously-bypass-approvals-and-sandbox`.
5. **Official docs.** The auto-review doc states approval handling applies "when approvals
   are interactive"; `codex exec` is the non-interactive surface, and the SDK wraps
   `codex exec` exclusively.

Consequences for the facade (2.5): `approveTool()` returns `false` (no pending approvals can
exist); the event mapper (2.4) never emits `approval_required`.

## Verdict 2: `permissionModes` descriptor array

### Decision

Three modes, one per sandbox level, all with `approvalPolicy: 'never'` passed **explicitly**
(ADR-0307: no implicit defaults post-0.132.0). Rationale for `never` everywhere: with no
approval channel, `on-request` produces auto-cancelled escalation attempts and noisy failed
items (#24135); `never` tells the model upfront to work within the sandbox, which is Codex's
own documented posture for automation. The **sandbox is the enforcement boundary**.

Default is `default` → `read-only`, matching `codex exec`'s own default ("By default,
`codex exec` runs in a read-only sandbox", developers.openai.com/codex/noninteractive) and
the spec's conservative-default requirement (§Security).

```ts
permissionModes: {
  supported: true,
  default: 'default',
  values: [
    {
      id: 'default',
      label: 'Read only',
      description:
        'Sandboxed reads — Codex can read files and answer questions, but not edit files, run mutating commands, or access the network.',
    },
    {
      id: 'acceptEdits',
      label: 'Workspace write',
      description:
        'Codex can read, edit, and run commands inside the workspace. Network access stays off.',
    },
    {
      id: 'bypassPermissions',
      label: 'Full access',
      description:
        'No sandbox — full file and network access. Use only in trusted or externally-sandboxed environments.',
    },
  ],
},
```

### Mode → ThreadOptions projection (for 2.5's `ensureSession`/`sendMessage`)

| DorkOS mode id      | `sandboxMode`        | `approvalPolicy` | Codex analog                        |
| ------------------- | -------------------- | ---------------- | ----------------------------------- |
| `default`           | `read-only`          | `never`          | `codex exec` default / "Read Only"  |
| `acceptEdits`       | `workspace-write`    | `never`          | "Auto" preset (headless projection) |
| `bypassPermissions` | `danger-full-access` | `never`          | "Full Access"                       |

Both fields must be passed explicitly on every `startThread`/`resumeThread` (ADR-0307).

`networkAccessEnabled` (→ `-c sandbox_workspace_write.network_access=...`) is an orthogonal
knob on `workspace-write`, defaulting to off (matches Codex's posture). It is deliberately
NOT a fourth mode — keep the mode set at three (less, but better); the facade can expose it
later via `runtimes.codex` config or `features` if a real need appears.

### Enum decision: NO change to `PermissionModeSchema`

All three ids (`default`, `acceptEdits`, `bypassPermissions`) are existing members of
`PermissionModeSchema` (`packages/shared/src/schemas.ts:21-23`). No additive members needed.

Why enum membership matters here (verified): `PATCH /api/sessions/:id` parses the body with
`UpdateSessionRequestSchema` (`apps/server/src/routes/sessions.ts:200`), which types
`permissionMode` as the shared enum — a non-enum mode id would 400 before reaching
`session_metadata` persistence (the DB column itself is unconstrained text,
`packages/db/src/schema/sessions.ts:22`). The test-mode pattern (capability-declared,
non-enum ids) works for display/selection but not for persistence through that route, so
reusing enum ids is strictly better than inventing `codex-*` ids.

Semantic fit is also good, not just convenient:

- `acceptEdits` ↔ workspace-write: "auto-accept file edits" is exactly what the sandbox grants.
- `bypassPermissions` ↔ danger-full-access: same danger semantics; the client's existing
  presentation metadata transfers correctly for free — `ShieldOff` icon + red warn treatment
  (`MODE_ICONS`/`MODE_WARN` in
  `apps/client/src/layers/features/status/ui/PermissionModeItem.tsx`), and
  `ChatStatusStrip.tsx:177` special-cases `bypassPermissions` for its warning verb.
- `default` ↔ the runtime's own default posture (read-only for headless Codex).

### `ApprovalMode` value drift (informational)

Live probe of the pinned binary: `-c approval_policy="bogus"` errors with
``expected one of `untrusted`, `on-failure`, `on-request`, `granular`, `never` `` — all four
SDK `ApprovalMode` values parse fine at 0.142.5 (plus `granular`, absent from the SDK type).
The **latest** docs config-reference omits `on-failure`, suggesting deprecation upstream.
We only ever pass `never`, so this is drift to watch on re-pin, not a problem.

## Verdict 3: Interrupt surface (for 2.5 `interruptQuery`)

- The only interrupt primitive is **`TurnOptions.signal?: AbortSignal`**
  (`dist/index.d.ts:167-172`), passed straight to
  `spawn(this.executablePath, commandArgs, { env, signal })` (`dist/index.js`, `CodexExec.run`).
- Semantics: **per-turn subprocess kill, not a graceful in-turn stop.** Each
  `runStreamed()` call spawns a fresh `codex exec --experimental-json` process
  (subsequent turns use `codex exec ... resume <threadId>`); aborting the signal kills that
  process (Node sends SIGTERM). There is no thread-level kill because no long-lived thread
  process exists — a Thread is just an id plus rollout files under `$CODEX_HOME/sessions/`
  (live-observed: `sessions/2026/...` created per run).
- **The events generator THROWS on abort.** After the readline loop ends, `CodexExec.run`
  throws the spawn `error` (AbortError) or `Codex Exec exited with signal SIGTERM: ...`.
  The facade must wrap iteration, treat abort-caused throws as expected cancellation, and
  emit a graceful turn end rather than an error event.
- Implementation shape for 2.5: keep an `AbortController` per in-flight turn (adjacent to
  the 2.3 thread map); `interruptQuery(sessionId)` aborts it and returns `true` if a turn
  was in flight.
- `LIVE-VERIFY`: that a thread killed mid-turn resumes cleanly via `resumeThread(id)` on the
  next message (rollout-file consistency after SIGTERM). Types/docs say sessions persist
  incrementally; not provable without an authenticated turn.

## Verdict 4: `logs_2.sqlite` unbounded-write defect at the pin

**Partially patched at 0.142.5.** openai/codex#28224 (closed) was fixed across three PRs:

- #29432 "Stop logging every Responses WebSocket event" — shipped **0.142.0** ✓ in our pin
- #29457 "Filter noisy targets from persistent logs" — shipped **0.142.0** ✓ in our pin
- #29599 "Stop persisting bridged log events" — ships **0.143.0** ✗ NOT in our pin

Live probe: a fresh `CODEX_HOME` after ~7 trivial unauthenticated runs already holds a
49 KB `logs_2.sqlite` — the sink is active at the pin, just far less noisy than pre-0.142.0.

**No config mitigation exists.** The sqlite feedback sink ignores `RUST_LOG` (#29463,
#17320), and none of the config-reference logging keys (`log_dir`, `history.*`,
`analytics.enabled`, `otel.*`) govern it. Community workarounds (a SQLite trigger dropping
inserts; symlinking `logs_2.sqlite` to tmpfs) are user-level hacks DorkOS should not apply
to a user's `$CODEX_HOME`.

**Recommendation:** acceptable at 0.142.5 (the two worst offenders are fixed); bump the pin
to ≥ 0.143.0 during P2 stabilization to pick up #29599, and note the residual write churn in
the runtime's docs until then.

## Additional live-verified facts for 2.4 / 2.5

- **JSONL events are stdout-only; tracing lines are stderr-only** (verified with separate
  capture files). The SDK's readline-over-stdout parse is safe from log pollution.
- **Stream-level `error` events are NOT always fatal**, despite the type docstring
  ("unrecoverable"). Live sequence during auth failure: five
  `{"type":"error","message":"Reconnecting... N/5 ..."}` events, an
  `item.completed` carrying an `error` item ("Falling back from WebSockets to HTTPS..."),
  more `error` events, then a terminal `turn.failed`. The 2.4 mapper must NOT end the turn
  on `error`; only `turn.failed` / `turn.completed` (or generator throw) terminate. Real
  fatal shape: `{"type":"turn.failed","error":{"message":"..."}}` where the message
  duplicates the final `error` event's message (dedupe opportunity).
- `--experimental-json` (the flag the SDK passes) is accepted at 0.142.5 and emits the same
  stream as the help-documented `--json`.
- `CodexOptions.env` gotcha: when set, the subprocess does **not** inherit `process.env`
  (dist source) — if 2.5 ever sets it, it must pass PATH/HOME/CODEX_HOME explicitly.
  Omitting it inherits everything (and the SDK then injects
  `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_sdk_ts`).
- `CodexOptions.codexPathOverride` is where `runtimes.codex.binaryPath` config wires in;
  when unset the SDK resolves its **own vendored binary** from `@openai/codex` optional
  deps — it does not search PATH. So execution does not strictly require a system `codex`
  install; auth state (`codex login` under `$CODEX_HOME`) does. `check-dependencies.ts`
  (2.1) probing for a system binary is still the right UX for the login flow.
- `codex exec --ephemeral` exists ("without persisting session files") — must NOT be used;
  resume depends on persisted rollouts.

## Open items flagged for live re-verification (authenticated)

1. Resume-after-interrupt: thread killed mid-turn via AbortSignal resumes cleanly.
2. Confirm no approval-shaped `item.*` payload appears at runtime for sandbox-escalation
   attempts under `approvalPolicy: 'never'` (expected: the command simply fails in-sandbox
   as a `command_execution` item with non-zero `exit_code`).
3. Behavior of `web_search` / `mcp_tool_call` items under `read-only` sandbox.
4. Re-check `on-failure` acceptance on the next SDK re-pin (latest docs dropped it).
