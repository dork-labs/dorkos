# MCP Server Management for Agents — Specification

**Linear:** DOR-891 · **Spec id:** 260803-232451 · **Stage:** SPECIFY

## 1. Summary

Add per-agent **managed MCP servers**: a user (or an agent acting for one) can
add / remove / enable / disable / test an MCP server for a specific agent from the
DorkOS UI and CLI, with live status, a uniform approval gate, and honest
per-runtime degradation. v1 fully implements the **Claude Code** runtime; Codex
and OpenCode advertise what they can do and their write paths are follow-ups.

Managed servers are **injected inline** at session time (the mechanism connectors
already use), so no `.mcp.json` is written and the "pending approval" dual-trust
confusion never arises for them.

## 2. Architecture

Four layers, three of them runtime-neutral:

```
UI (Agent Hub → Toolkit)     ─┐
CLI (dorkos call mcp.*)       ─┤→  mcp.* capability domain  →  AgentMcpServerService
HTTP (/api/agents/:id/mcp-*)  ─┘        (tier gate)               (manifest store + fingerprint)
                                                                        │
                                       claude-code setMcpServerFactory ─┘  (inline injection)
                                       getMcpStatus (existing)  → live status join in the UI
```

- **`AgentMcpServerService`** (new, runtime-neutral, `apps/server/src/services/mesh/`
  or `core/`): owns CRUD over `AgentManifest.mcpServers[]` via
  `readManifest`/`writeManifest` (`packages/shared/src/manifest.ts`), fingerprint
  computation, and the `test` probe. Single source of truth for the management verbs.
- **`mcp.*` capability domain** (new): declares the verbs once; the Capability
  Registry projects them to the MCP tool, `dorkos call` CLI, and HTTP routes, with
  the tier gate enforced once in `registry.invoke`.
- **Claude Code injection**: the existing factory closure at `apps/server/src/index.ts`
  (currently `{ dorkos, ...connectorServers }`) gains a third spread of the agent's
  enabled managed servers, converted via `toSdkMcpServers`.
- **Status**: the existing `getMcpStatus` / `GET /api/mcp-config` path is unchanged;
  the client joins managed config (`mcp.list`) with live status by server name.

## 3. Data model

Add to `AgentManifestSchema` (`packages/shared/src/mesh-schemas.ts`, after
`enabledToolGroups`):

```ts
export const McpServerTransportSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({ transport: z.literal('http'), url: z.string().url(), headers: z.record(z.string(), z.string()).default({}) }),
  z.object({ transport: z.literal('sse'),  url: z.string().url(), headers: z.record(z.string(), z.string()).default({}) }),
]);

export const ManagedMcpServerSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  enabled: z.boolean().default(false),          // safe-default: absence withholds
  connection: McpServerTransportSchema,
  addedAt: z.string().datetime(),
  addedBy: z.string().min(1),                   // audit: who approved it
}); // no separate stored fingerprint — recomputed from `connection` on demand

// on AgentManifestSchema:
mcpServers: z.array(ManagedMcpServerSchema).default([]),
```

- **No DB column, no migration** — manifest-file-only, exactly like
  `enabledToolGroups` (excluded from the mesh reconciler's diff by omission).
- `.catch([])` is **not** applied here (unlike `model`/`effort`): a malformed
  entry should fail the individual entry, not silently degrade the security-relevant
  list. `readManifest` already returns `null`→agent hidden on a fully invalid
  manifest; we keep the array strict so a bad server surfaces loudly.
- The `connection` shape reuses the existing `McpAppServerConnection` union
  (`stdio`/`http`/`sse`), so `toSdkMcpServerConfig` converts it directly.

### `AgentManifestUpdate` (PATCH)

`mcpServers` is **omitted** from the general agent PATCH surface — it is mutated
only through the `mcp.*` capabilities, never a blanket manifest write. (Enforced
by not adding it to `AgentManifestUpdateSchema`.)

## 4. Trust & safety model

This is the answer to the request's security concern (#4) and the `safe-defaults`
rule. Four guarantees:

1. **Absence withholds.** `mcpServers` defaults to `[]`; an entry's `enabled`
   defaults to `false`. Injection fires only for `enabled === true` entries.
2. **The only legitimate writer is the gated capability.** `mcp.add` and any
   command change are `destructive`-tier: they raise a human approval card showing
   the exact `command`/`args`/`url` that will run (`approvalDisplayFields`). There
   is no un-gated write path — `mcpServers` is excluded from the agent PATCH.
3. **Marketplace packages may not carry `mcpServers`.** The marketplace agent-
   manifest validator (`packages/marketplace`) rejects a packaged manifest that
   declares `mcpServers`. This closes the "a cloned/installed agent smuggles an
   auto-injected command" vector. A person adds servers post-install, through the
   gate.
4. **Hand-editing your own `agent.json` stays trusted** — identical to the fact
   that a hand-written `.mcp.json` is already auto-loaded by the SDK. This is the
   documented threat boundary; we do not defend the operator against their own
   filesystem, only against packaged/remote content (guarantee 3).

Tier assignment:

| Verb          | Tier          | Approval card      | Notes                                                                                                                   |
| ------------- | ------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `mcp.list`    | `observe`     | no                 | Returns managed config + enabled state.                                                                                 |
| `mcp.add`     | `destructive` | **yes** (cmd diff) | Also enables the server. Rejects reserved (`dorkos`) and duplicate names.                                               |
| `mcp.update`  | `destructive` | **yes** (cmd diff) | Changing `connection` re-prompts.                                                                                       |
| `mcp.remove`  | `act`         | no                 | Reversible (re-add).                                                                                                    |
| `mcp.enable`  | `act`         | no                 | No command introduced (already approved at add).                                                                        |
| `mcp.disable` | `act`         | no                 |                                                                                                                         |
| `mcp.test`    | `act`         | no                 | Only on an **existing** (already-approved) entry — never an arbitrary ad-hoc command, so it cannot bypass `add`'s gate. |

## 5. Capability domain (`apps/server/src/services/mesh/mcp-capabilities.ts`)

Follow the `connector-capabilities.ts` template exactly:

- Module-augment `CapabilityDeps` with `mcpDeps?: { service: AgentMcpServerService; agents: AgentRegistry }`.
- `requireMcpDeps(deps)` narrowing helper.
- `export const mcpDomain: CapabilityDomain = { name: 'mcp', assertDeps: requireMcpDeps, capabilities: [...] }`.
- Register in `dorkos-registry.ts`: gated (`if (deps.mcpDeps) domains.push(mcpDomain)`) in `composeDorkOsCapabilityRegistry`, and unconditionally in `composeCapabilityRegistryForDocs`.

Each capability's `surfaces`:

- `mcp`: `{ toolName: 'mcp_<verb>_server' , servers: ['in-session','external'] }` (list/test read-only carve-out where applicable).
- `cli`: `{ verb: 'mcp', subcommand: '<verb>' }` (collision-detection only; generic `dorkos call mcp.<verb>` is the CLI parity for v1 — no curated command file).
- `http`: REST routes under the agent (see §7).

`approvalDisplayFields` for `mcp.add`/`mcp.update`: `['input.connection.transport',
'input.connection.command', 'input.connection.args', 'input.connection.url']`.

Input is keyed by **agent id** (not cwd): capabilities resolve the agent → its
workspace path → manifest, via the `AgentRegistry`. Output is the updated managed
server list (or the `test` probe result).

## 6. Injection (claude-code)

At `apps/server/src/index.ts` (the `setMcpServerFactory` closure), add a third
spread:

```ts
claudeRuntime.setMcpServerFactory((session, sessionId) => ({
  ...toSdkMcpServers(agentMcpService.injectableServersForCwd(session.cwd)), // NEW
  ...toSdkMcpServers(sessionConnectorService.mcpServersForSession(sessionId).servers),
  dorkos: createDorkOsToolServer(/* … */), // dorkos spread LAST — always wins
}));
```

- `injectableServersForCwd(cwd)`: read the manifest at `cwd` (agent workspace ==
  cwd); return `Record<string, McpAppServerConnection>` of `enabled` entries only;
  empty for a non-agent session (no manifest). Cached with a short TTL / manifest
  mtime check so it is not a disk read on every query.
- **Ordering / collisions:** managed spread first, connectors second, `dorkos`
  last so `dorkos` can never be shadowed. `mcp.add` rejects the reserved name
  `dorkos`. A managed↔connector name clash resolves to the connector (later spread)
  and is a documented edge (rare; both are user-controlled).
- Only claude-code is wired (mirrors the existing `if (claudeRuntime)` guard).
  Codex/OpenCode never call the factory (`supportsMcp: false`), so a managed server
  added for such an agent is stored but not injected — see §8.

## 7. HTTP + Transport

Capability `surfaces.http` (projected + OpenAPI):

| Verb | Method | Path |
| -------------- | ------ | ----------------------------------------------- | --------- |
| list | GET | `/api/agents/:agentId/mcp-servers` |
| add | POST | `/api/agents/:agentId/mcp-servers` |
| update | PATCH | `/api/agents/:agentId/mcp-servers/:name` |
| remove | DELETE | `/api/agents/:agentId/mcp-servers/:name` |
| enable/disable | POST | `/api/agents/:agentId/mcp-servers/:name/(enable | disable)` |
| test | POST | `/api/agents/:agentId/mcp-servers/:name/test` |

Add matching methods to the `Transport` interface and both implementations
(`HttpTransport`, `DirectTransport`) — the client never calls `fetch` directly.
The `destructive` verbs return the capability layer's `ApprovalRequiredPayload`
when an approval is pending; the client renders the approval flow (reusing the
existing capability-approval UI path).

## 8. Client UI (Agent Hub → Toolkit)

Extend `apps/client/src/layers/features/agent-settings/ui/ToolsTab.tsx` (the MCP
roster at lines ~282-305) into a managed-servers section:

- **Managed servers** (from a new `useAgentMcpServers(agentId)` hook over
  `mcp.list`): each row shows a live status dot (joined with `useMcpConfig` live
  status by `name`), name, transport, tool count (from status), enable/disable
  `Switch`, a **Test** button, and a **Remove** action.
- **Add server**: a form (stdio: command/args/env; http/sse: url + headers) →
  `mcp.add` → approval card → optimistic refresh. Gate the whole Add affordance on
  the runtime capability `supportsMcp`: when false (Codex/OpenCode), disable it with
  an inline explanation ("This agent's runtime can't run DorkOS-managed MCP servers
  yet"), and still show the existing read-only discovered/status roster.
- **Discovered servers** (existing `.mcp.json`/live entries with no managed match):
  keep read-only, labeled "discovered" to distinguish from managed (editable).
- Design bar (REVIEW.md): explicit loading / empty / error states; keyboard-reachable
  controls with `focus-visible`; theme tokens only (no hardcoded hex); the status
  dot colors reuse the existing `MCP_STATUS_COLORS` map.

FSD: hook lives in `entities/agent` (or a new `entities/mcp`), UI in the
`agent-settings` feature; barrel imports only.

## 9. Testing

- **Schema**: `ManagedMcpServerSchema` valid/invalid cases; manifest round-trip
  (`writeManifest`→`readManifest`) preserves `mcpServers`; a malformed entry fails
  loudly (not `.catch`-swallowed).
- **Service**: CRUD writes through to the manifest file (real temp dir, not a mock);
  `injectableServersForCwd` returns only `enabled` entries and `[]` for a manifest-less
  cwd; disabling removes it from injection.
- **Capability/tier**: `mcp.add` requires a `destructive` approval and is blocked
  without it; `mcp.list` is `observe` and free; the approval card carries the command
  fields. Prove the gate can fail: an add attempted without approval returns
  `ApprovalRequiredPayload`, and after approval writes the entry.
- **Injection**: `FakeAgentRuntime` + a manifest with one enabled + one disabled
  server → factory output includes only the enabled one, `dorkos` always present and
  unshadowed. A reserved-name add is rejected.
- **Marketplace guard**: a packaged manifest declaring `mcpServers` fails validation.
- **Client**: mock `Transport`; managed rows render with joined status; Add disabled
  when `supportsMcp` is false; empty/error states.
- **Conformance**: no change required (optional interface members untouched); the
  `supportsMcp` boolean assertion already covers the flag.

## 10. Out of scope (follow-up issues, filed at DECOMPOSE)

- **DOR-892 Codex managed-server apply** — write via `CodexOptions.config.mcp_servers`
  or `~/.codex/config.toml`; verify stdio at the SDK pin; reconcile user-global scope.
- **DOR-893 OpenCode MCP status + apply** — implement `getMcpStatus` first, then
  managed config write + sidecar reload.
- **DOR-894 Import `.mcp.json` into the managed store** — one-way import of a
  discovered server into a managed (editable, gated) one.
- Curated `dorkos mcp …` CLI subcommand (generic `dorkos call mcp.*` covers v1).

## 11. ADR seeds

- **ADR: MCP servers are managed via inline injection, not `.mcp.json` writes** —
  records why v1 injects DorkOS-managed servers inline (dissolves the CLI-vs-SDK
  dual-trust confusion; keeps the harness's "MCP not projected as files" stance;
  covers local stdio). Amends nothing; complements the connector session-exposure
  design.
- **ADR: managed MCP server trust model** — the four guarantees in §4 (gated writes,
  marketplace rejection, absence-withholds, hand-edit boundary).
