# MCP Server Management for Agents — Ideation

**Linear:** DOR-891 · **Spec id:** 260803-232451 · **Stage:** IDEATE

## Problem

An operator (or an agent acting for one) can connect an agent to an external MCP
server today only by dropping to a terminal and running `claude mcp add` (or
hand-editing `.mcp.json`). That path has four failures, all confirmed against the
code:

1. **No write surface.** DorkOS shows MCP server status read-only (Agent Hub →
   Toolkit, fed by `GET /api/mcp-config` → `runtime.getMcpStatus()`), but there is
   no add / remove / enable / disable / test anywhere in the UI or CLI. A
   non-technical operator cannot do it at all.
2. **A confusing dual trust model.** `claude mcp list` reports a project-scope
   server as "⏸ Pending approval" while the in-session agent uses it fine. The
   concrete cause: the standalone `claude` CLI reads its own trust store
   (`~/.claude.json` → `enabledMcpjsonServers`), while the DorkOS SDK session runs
   with `settingSources: ['project']` and a possibly-relocated `CLAUDE_CONFIG_DIR`
   (per-account, `claude-config-dir.ts`). The two surfaces read **different
   files**, so they disagree.
3. **No health/error feedback on failure.** A bad command path or a closed app
   just makes the tools silently not appear.
4. **Invisible security posture.** A project `.mcp.json` (in a cloned repo or a
   marketplace-installed agent) auto-connects at session start and can run
   arbitrary stdio, with no per-agent review of the command.

## Ground truth (from code review)

- **Read/status is already cross-runtime.** `getMcpStatus(cwd)` is an optional
  `AgentRuntime` method: claude-code reads the SDK's live `mcpServerStatus()`,
  codex shells `codex mcp list --json`, opencode implements nothing. The client
  renders a read-only roster in `agent-settings/ToolsTab.tsx`.
- **Injection is Claude-Code-only.** `setMcpServerFactory` + the connector
  `session-exposure` path are gated to claude-code (`supportsMcp: true`). Codex
  and OpenCode are `supportsMcp: false` — the flag means "DorkOS can inject a tool
  server," not "has MCP." Codex still runs user servers from `~/.codex/config.toml`;
  OpenCode from its own sidecar config.
- **The tool-call gate is separate and already exists.** External MCP tool calls
  are not auto-approved; they route through `canUseTool` and prompt in every mode
  except `bypassPermissions`. Server _connection_ (auto) and tool _execution_
  (gated) are two different layers.
- **The Capability Registry is the surface generator.** A capability domain
  declares verbs once and the registry projects them to an MCP tool, a `dorkos`
  CLI verb, and an HTTP route, with a per-verb tier gate (`observe`/`act`/
  `destructive`) enforced once in `registry.invoke`.
- **The harness deliberately excludes MCP from file projection**
  (`installed-projector.ts`: "MCP servers are configured per-harness, not
  projected as files").

## The core idea

Build **one uniform management surface** (capability domain + Agent Hub UI + CLI +
approval gate) on top of a **runtime-neutral store of DorkOS-managed MCP servers**,
and a **per-runtime apply strategy** underneath the `AgentRuntime` seam. Crucially,
for Claude Code the managed servers are **injected inline** at session time (the
same mechanism connectors already use), which means:

- No `.mcp.json` is written, so the "pending approval" dual-trust confusion never
  arises — inline servers are auto-trusted by the SDK and never touch the CLI
  trust store.
- Live status and tool counts come free via the existing `getMcpStatus` snapshot.
- Local **stdio** servers (the original OpenReel case) are covered —
  `toSdkMcpServerConfig` already handles the stdio transport.

The **security gate** is the uniform part: adding a server (or changing its
command) is a `destructive`-tier capability that routes through the existing
human-approval machinery, showing the exact command/args that would run.

## v1 scope (this flow item)

Ship a complete vertical slice for the launch-critical runtime and make the seam
real:

- **Store**: per-agent managed MCP servers (name, transport, stdio
  command/args/env or http/sse url/headers, enabled flag), file-first per ADR-0043,
  synced to the SQLite cache.
- **Capability domain `mcp.*`**: `list` (observe), `enable`/`disable` (act),
  `add`/`remove` (destructive, command-diff approval), `test` (act). Projects to
  MCP tool + CLI verb + HTTP route.
- **Claude Code apply**: inline injection at session time via the existing
  per-session server assembly (`dorkos` + connectors + **managed**). Full
  add/remove/enable/disable/status/test.
- **UI**: extend the existing Agent Hub → Toolkit MCP roster into full management —
  add form, enable/disable, remove, test connection, live status + tool count,
  with origin labeling (DorkOS-managed vs discovered from `.mcp.json`).
- **CLI parity** via the capability CLI projection.
- **Honest degradation**: the "Add" affordance is gated on the runtime's ability
  to apply managed servers (`supportsMcp`). Codex/OpenCode show what they can
  (codex: existing read-only status; opencode: nothing yet) with a clear
  explanation, not a dead button.

## Deferred (follow-up issues, filed at DECOMPOSE)

- **Codex managed-server write path** — via `CodexOptions.config.mcp_servers`
  (the proven `dorkos_ui` channel) or `~/.codex/config.toml`; verify stdio
  injection works at the SDK pin. Note Codex MCP config is user-global, not
  per-agent.
- **OpenCode** — implement `getMcpStatus` first, then managed-server config +
  sidecar reload.
- **Import existing `.mcp.json` servers** into the managed store (one-way import),
  if wanted after v1.

## Open decisions for SPECIFY

- **D1 Storage**: extend `AgentManifest` with an `mcpServers` field (file-first,
  consistent with `enabledToolGroups`) vs a separate store. _Lean: AgentManifest._
- **D2 Injection wiring**: extend the connector `session-exposure` assembly to
  emit managed servers vs a parallel managed-server source folded into the
  factory. _Lean: a dedicated managed-server source, kept distinct from connector
  accounts so the two concerns don't entangle._
- **D3 UI placement**: extend the Toolkit MCP section vs a dedicated "MCP Servers"
  tab. _Lean: extend Toolkit for v1 (lowest friction, consistent)._
- **D4 Approval**: confirm add/remove = `destructive` and that the command diff
  routes through the existing standing-approvals posture machinery.
- **D5 Origin labeling**: how the UI distinguishes managed (editable) from
  discovered (read-only) servers. _Lean: join `mcp.list` (managed config) with
  `getMcpStatus` (live) by name, client-side; managed entries carry a stable
  marker._
- **D6 Capability flag**: reuse `supportsMcp` as "can apply managed servers" (it
  already means exactly the injection seam) vs a new flag. _Lean: reuse
  `supportsMcp`; "can show status" is separately signalled by `getMcpStatus`
  presence._

## Non-goals

- Rewriting or reconciling the standalone `claude` CLI trust store — the inline
  model sidesteps it entirely for managed servers.
- Making a managed server portable to a bare `claude` session (that would require
  writing `.mcp.json`; explicitly out of scope for v1).
- Managing DorkOS's own outward `/mcp` server or connector OAuth toolkits (those
  are separate, existing surfaces).
