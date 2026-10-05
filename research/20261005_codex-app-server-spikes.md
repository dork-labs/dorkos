---
title: 'Codex app-server spikes: secrets, trust, multiplexing, experimental API (codex-cli 0.154.0)'
date: 2026-10-05
type: internal-architecture
status: active
tags: [codex, app-server, json-rpc, runtime, security, mcp, credits]
feature_slug: codex-app-server-transport
---

# Codex app-server spikes (codex-cli 0.154.0)

Four questions the spec for DOR-2719 had to answer before it could be written, each answered by running the vendored binary DorkOS pins. Companion to `research/20261005_codex-app-server-protocol-0154.md`.

## Method

- **Binary:** `node_modules/.pnpm/@openai+codex@0.154.0-darwin-arm64/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex`.
- **Isolation:** every run used a fresh `CODEX_HOME` and `HOME` under `/tmp/codex-spike/run*`, with `PATH=/usr/bin:/bin` and no `OPENAI_API_KEY`/`CODEX_API_KEY`. Nothing was copied from `~/.codex`; the person's `config.toml`, MCP servers and trust list were never read or written.
- **No money spent.** The only turns started were sent to a fake provider, configured per thread; no request left `127.0.0.1`. One local HTTP server (in the spike script) played two parts:
  - a fake streamable-HTTP **MCP server** that logs every request's `Authorization` and `X-Probe` header and answers `initialize` / `tools/list`;
  - a fake **Responses API provider** at `/v1/responses` that logs headers and answers `400`.
- **Scripts:** `/tmp/codex-spike/spike{,2,3,4,5}.mjs`, results in `/tmp/codex-spike/result{,2,3,4,5}.json` (scratch; the technique is described here so it can be rebuilt). Requests below are trimmed to the fields that matter.

## Answers

| #   | Question                                                                                | Answer                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | Can per-thread `config` carry an MCP server with a literal header?                      | **Yes.** The header reaches the server; nothing in argv or env.                                                                                            |
| 1b  | Can a **loaded** thread's config change?                                                | **No, and it fails silently.** `thread/resume` on a loaded thread returns success and ignores the new `config`. Only a cold load (new process) applies it. |
| 1c  | Does `turn/start` (or `thread/settings/update`) take `config`?                          | **No.** Neither has the field, and unknown fields are **silently dropped**, not rejected.                                                                  |
| 1d  | Can per-thread `config` carry a model provider with a literal bearer?                   | **Yes.** The bearer reaches the provider, fixed for the thread's loaded life.                                                                              |
| 1e  | Can per-thread `config` set the environment of commands the agent runs?                 | **Yes.** `shell_environment_policy.set` is per thread.                                                                                                     |
| 2a  | Does `thread/start` with a writable sandbox write trust into `$CODEX_HOME/config.toml`? | **Yes**, for `workspace-write` and `danger-full-access`, ephemeral or not. Not for `read-only`.                                                            |
| 2b  | Does `codex exec` (today's path) do the same?                                           | **Yes**, for `workspace-write`, and it then loads the project's `.codex/config.toml` (its MCP servers start).                                              |
| 2c  | Can the write be prevented?                                                             | **Yes.** An in-memory `projects.<realpath>.trust_level` in the thread's `config` stops the write, and its value decides whether project config loads.      |
| 3   | One process, threads with different cwd/sandbox/approval?                               | **Yes.** Each thread keeps its own; MCP servers start per thread.                                                                                          |
| 4   | `initialize` with `experimentalApi: true`?                                              | **Works.** Unlocks `thread/backgroundTerminals/*`, `thread/settings/update`, the `granular` approval policy; refused without it.                           |

## Evidence

### 1a. Per-thread MCP server with a literal bearer

```jsonc
→ thread/start {"cwd":".../proj-ro","sandbox":"read-only","approvalPolicy":"on-request",
   "config":{"mcp_servers":{"probe":{"url":"http://127.0.0.1:<port>/mcp",
                                     "http_headers":{"Authorization":"Bearer SECRET-A"}}}}}
← {"thread":{"id":"01a10bcf-1b0c-…"},"sandbox":{"type":"readOnly","networkAccess":false},"approvalPolicy":"on-request",…}
probe saw: POST /mcp  Authorization: Bearer SECRET-A   initialize, notifications/initialized, tools/list
probe saw: POST /home-mcp  X-Probe: home              (the home config.toml's server ALSO started)
← mcpServer/startupStatus/updated  probe: starting → ready; homeprobe: starting → ready
← mcpServerStatus/list(threadId) → probe {authStatus:"bearerToken"}, homeprobe {authStatus:"unsupported"}
```

Per-thread `mcp_servers` **merges** with the home `config.toml`'s servers; it does not replace them.

### 1b. A loaded thread ignores new config

A thread is not resumable until its first turn writes a rollout:

```jsonc
→ thread/resume {"threadId":"<A, no turns yet>","config":{…SECRET-B…}}
← {"error":{"code":-32600,"message":"no rollout found for thread id 01a10bcf-1b0c-…"}}
```

With a rollout (one turn sent to the fake provider), in the **same process**:

```text
thread/start   config: provider bearer PROV-1, MCP bearer MCP-1
turn/start     → provider saw "Bearer PROV-1"
thread/resume  config: PROV-2, MCP-2   → {ok:true, modelProvider:"spike"}; MCP NOT re-initialized
turn/start     → provider saw "Bearer PROV-1"            (new config ignored)
thread/unsubscribe → {"status":"unsubscribed"}; thread/loaded/list still lists it
thread/resume  config: PROV-3, MCP-3; turn/start → provider saw "Bearer PROV-1"; no MCP init
```

In a **new process** (cold resume):

```text
thread/resume  config: PROV-4, MCP-4; turn/start → provider saw "Bearer PROV-4"; MCP init with "Bearer MCP-4"
```

There is no `thread/unload`/`thread/close` method in 0.154 (full client-request list checked); a thread unloads only after ~30 idle minutes with no subscriber, or when its process exits. `config/mcpServer/reload` returned `{}` and re-initialized nothing for the loaded thread.

### 1c. `config` on turn-scoped methods is silently dropped

The generated schema has no `config` on `TurnStartParams` or `ThreadSettingsUpdateParams` (it is on `ThreadStartParams`, `ThreadResumeParams`, `ThreadForkParams`). Sent anyway:

```jsonc
→ turn/start {"threadId":"00000000-0000-7000-8000-000000000000","input":[…],"config":{"foo":1}}
← {"error":{"code":-32600,"message":"thread not found: 00000000-…"}}   // field ignored, not rejected
→ thread/settings/update {"threadId":"<A>","config":{"foo":1},"effort":"low"}
← {"result":{}}                                                         // accepted; config dropped
```

So a misspelled or misplaced param is a silent no-op. Typed request builders and a schema snapshot are the only guard.

### 1d. Per-thread model provider with a literal bearer

```jsonc
→ thread/start {"cwd":"…","sandbox":"read-only","approvalPolicy":"never","ephemeral":true,"model":"fake-model",
   "config":{"model_provider":"spike","web_search":"disabled",
     "model_providers":{"spike":{"name":"spike","base_url":"http://127.0.0.1:<port>/v1","wire_api":"responses",
       "requires_openai_auth":false,"experimental_bearer_token":"SECRET-PROVIDER",
       "request_max_retries":0,"stream_max_retries":0}}}}
← {"modelProvider":"spike","model":"fake-model",…}
→ turn/start {"threadId":"<P>","input":[{"type":"text","text":"hi","text_elements":[]}]}
fake provider saw: POST /v1/responses  Authorization: Bearer SECRET-PROVIDER
← turn/completed {status:"failed", error:"{\"error\":{\"message\":\"spike: fake provider refuses\"…}}"}
```

### 1e. Per-thread environment for the agent's commands

```jsonc
→ thread/start {…,"config":{"shell_environment_policy":{"set":{"DORKOS_SPIKE_TOKEN":"per-thread-A"}}}}   // thread A
→ thread/start {…,"config":{"shell_environment_policy":{"set":{"DORKOS_SPIKE_TOKEN":"per-thread-B"}}}}   // thread B, same process
→ thread/shellCommand {"threadId":"<A>","command":"echo token=$DORKOS_SPIKE_TOKEN home=$CODEX_HOME"}
← item/completed commandExecution source:"userShell" aggregatedOutput:"token=per-thread-A home=/tmp/…/codex-home\n"
→ same on B → "token=per-thread-B …"
```

Side notes: `thread/shellCommand` opens and closes a turn of its own (`turn/started` … `turn/completed`) without any model call, and `CODEX_HOME` is visible to the agent's commands.

### 2. Trust writes

`config.toml` in the throwaway home, after each step (the home started with one `[mcp_servers.homeprobe]` table):

| Step                                                      | Written to `config.toml`                                        |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| `thread/start` `read-only` in `proj-ro`                   | nothing                                                         |
| `thread/start` `workspace-write` in `proj-ww`             | `[projects."/private/tmp/…/proj-ww"] trust_level = "trusted"`   |
| `thread/start` `danger-full-access` in `proj-full`        | `[projects."/private/tmp/…/proj-full"] trust_level = "trusted"` |
| `thread/start` `workspace-write`, `ephemeral: true`       | trust written (ephemeral does not prevent it)                   |
| `codex exec --sandbox read-only` (SDK's argv shape)       | nothing                                                         |
| `codex exec --sandbox workspace-write` (SDK's argv shape) | `[projects."/private/tmp/…/proj-exec"] trust_level = "trusted"` |

Project config follows trust:

- `proj-ww` has `.codex/config.toml` with `[mcp_servers.projprobe]`. The very `thread/start` that wrote trust also started `projprobe` (and every later thread there did too).
- `proj-ro` has the same file. A `read-only` `thread/start` there started only the per-thread server, not `projprobe`.
- `codex exec --sandbox workspace-write` in `proj-exec` (with its own `.codex/config.toml`) started `projprobe` (`X-Probe: project-exec`). `--sandbox read-only` did not.

**This contradicts ADR `261002-221210`'s premise** that "the credits home trusts no folder, so Codex reads no project config": the first `workspace-write` credits turn in a folder writes trust into the credits home, and every later turn there loads that project's `.codex/config.toml`. (The ADR's other guard still held in its own binary test: a project provider never outranks the command-line provider.)

Preventing the write, with no effect on the sandbox:

```jsonc
→ thread/start {"cwd":".../proj-b","sandbox":"workspace-write","approvalPolicy":"never",
   "config":{"projects":{"/private/tmp/…/proj-b":{"trust_level":"trusted"}}}}
← sandbox workspaceWrite; config.toml unchanged
→ same with "trust_level":"untrusted" → sandbox workspaceWrite; config.toml unchanged
```

And the in-memory value decides project config (both `workspace-write`, `on-request`):

```text
trust_level "trusted"   → project .codex/config.toml MCP server started; config.toml unchanged
trust_level "untrusted" → project MCP server NOT started;               config.toml unchanged
```

The key must be the **realpath** of the cwd (`/private/tmp/…` on macOS), matching what Codex writes.

### 3. One process, many threads

Same process and connection, all accepted:

```jsonc
A: thread/start {cwd: proj-ro,   sandbox:"read-only",          approvalPolicy:"on-request"} → readOnly / on-request
W: thread/start {cwd: proj-ww,   sandbox:"workspace-write",    approvalPolicy:"never"}      → workspaceWrite / never
F: thread/start {cwd: proj-full, sandbox:"danger-full-access", approvalPolicy:"untrusted"}  → dangerFullAccess / untrusted
thread/loaded/list → 4 ids (A, W, a second W thread, F)
```

Limits observed or confirmed in source (`research/20261005_codex-app-server-protocol-0154.md` §5, §8): no per-process thread cap; MCP servers start **per thread** (the home server initialized once for each new thread, so N loaded threads hold N MCP connections per server); up to 64 unified-exec processes per thread; ingress overload answers `-32001`; one thread runs at most one turn.

### 4. Experimental API

```jsonc
→ initialize {"clientInfo":{"name":"dorkos_spike","title":null,"version":"0.0.0"},"capabilities":{"experimentalApi":true}}
← {"userAgent":"dorkos_spike/0.154.0 (Mac OS 26.6.2; arm64) …","codexHome":"/private/tmp/codex-spike/run/codex-home",…}
→ thread/backgroundTerminals/list {"threadId":"<A>"}  ← {"data":[],"nextCursor":null}
→ thread/backgroundTerminals/clean {"threadId":"<A>"} ← {}
→ thread/settings/update {"threadId":"<A>","effort":"low"} ← {}
→ thread/start {…,"approvalPolicy":{"granular":{…all true…}}} ← ok
```

Without the opt-in (a second process, `capabilities: null`):

```jsonc
→ thread/backgroundTerminals/list ← {"code":-32600,"message":"thread/backgroundTerminals/list requires experimentalApi capability"}
→ thread/settings/update          ← {"code":-32600,"message":"thread/settings/update requires experimentalApi capability"}
```

Methods and fields the spec relies on that need the opt-in: `thread/backgroundTerminals/{list,terminate,clean}` (stop a background command, know whether a thread still has live work), `turn/start.additionalContext` (optional), `CommandExecutionRequestApprovalParams.availableDecisions` (which buttons to offer). Everything else the spec uses is stable: `thread/start|resume|read|loaded/list|unsubscribe`, `turn/start|steer|interrupt`, the approval server requests, `serverRequest/resolved`, `thread/tokenUsage/updated`, `model/list`, `account/*`.

## What this decides for the spec

1. **Nothing per turn can ride thread config.** A secret bound into a loaded thread lives as long as the thread stays loaded. So DorkOS's per-turn bearers (the `dorkos` tool server and the connector route) become a **thread key**: minted when DorkOS loads the thread, sent once in its `config`, held only in DorkOS memory, and resolved by the internal listener to whichever turn binding is open on that session right now (refused when none is). It dies with the process.
2. **Credits go through the credits relay.** The provider entry in thread config points at the loopback relay with a per-process relay key as `experimental_bearer_token`. The relay already carries the `openai-responses` format. A new credits token needs no reload.
3. **The agent identity token moves to `shell_environment_policy.set`** in thread config. It is per thread, out of argv and out of the process env.
4. **Managed MCP servers ride `http_headers` in thread config**, not `env_http_headers` plus process env. A change reaches a loaded thread only when it reloads, which the pool forces by recycling a process once nothing in it is live.
5. **DorkOS never writes the person's trust list.** Every `thread/start`/`thread/resume` carries `projects.<realpath cwd>.trust_level`: in the person's home, `"trusted"` for writable modes when their `config.toml` has no verdict (exactly what `codex exec` does today, minus the write), their own verdict when it has one; in the credits home, always `"untrusted"`.
6. **One process per (binary, CODEX_HOME, env fingerprint)** is enough, and in practice that is two: the person's home and the credits home.
7. **Persist the thread binding at the first `turn/started`, not at `thread/start`,** since a thread with no rollout cannot be resumed. A cold `thread/resume` answering "no rollout found" is treated as an unbound session.
