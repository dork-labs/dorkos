# Claude Code SDK Verification Notes

Live-verified facts about `@anthropic-ai/claude-agent-sdk` that the adapter depends on and
that are not obvious from the types alone. Each entry says what was checked and how, so the
next person can tell an observed fact from an assumed one.

---

## Verdict 1: which launch parameters can be changed on a LIVE query — task 3.5 (DOR-1170)

Spec `persistent-session-runtime` §4.5 asks for a verdict **per field** on
`model` / `effort` / `fastMode`, and warns against assuming the three behave alike. They do
not. The dispositions live in `PIN_DISPOSITIONS`
(`sessions/launch-fingerprint.ts`); this is why each landed where it did.

### Evidence basis

SDK **0.3.224**, the version this repo pins. Verified against both the declarations
(`sdk.d.ts`) and the **shipped implementation** (`sdk.mjs`), which is the stronger of the
two: a method can be declared and not wired, and the implementation shows the actual
control-request subtype that goes down the wire.

**Not** verified by running a credentialed turn against a live model. Doing that costs real
money and this repo deliberately gates such runs behind an explicit opt-in (see AGENTS.md).
So: "the SDK sends this control request on a live streaming query" is observed; "the CLI on
the other end honours it for the next turn" is read from the SDK's own documentation, not
watched. Anything resting on the second is marked LIVE-VERIFY below, and every one of those
was resolved in the **safe** direction — relaunch — rather than assumed to work.

### The four that are set on the live process

Each is a real control-request round-trip in `sdk.mjs`, on the `Query` returned by a
streaming-input `query()`:

| Field            | Method                    | Wire subtype (`sdk.mjs`) |
| ---------------- | ------------------------- | ------------------------ |
| `model`          | `setModel(model?)`        | `set_model`              |
| `permissionMode` | `setPermissionMode(mode)` | `set_permission_mode`    |
| `mcpServers`     | `setMcpServers(servers)`  | `mcp_set_servers`        |
| `plugins`        | `reloadPlugins()`         | `reload_plugins`         |

`setModel` carries **only a model id**. It does not carry effort, thinking or fastMode, so
it cannot be the mechanism for those three — which is the per-field answer the spec asked
for, and the reason the row splits.

### `effort` — RELAUNCH

There is no `setEffort`. The nearest lever is
`applyFlagSettings({ effortLevel })` (`apply_flag_settings`), which is real and which the
SDK documents as session-scoped. It is still not enough, and the reason is ours, not the
SDK's: DorkOS resolves `effort` and the `thinking` block **together**, against the selected
model's capability (`messaging/thinking-config.ts` — an adaptive-capable model gets
`thinking: { type: 'adaptive', display: 'summarized' }`, a non-adaptive one gets no
`thinking` at all). `applyFlagSettings` moves the settings-layer effort and leaves
`Options.thinking` exactly as it was launched. That is a **partial** application: the live
process would end up in a combination no fresh launch would ever produce, which is precisely
the staleness the pin list exists to prevent.

So the pin covers the resolved pair, and a change to either relaunches. This also makes the
live `setModel` safe: a model change that WOULD have resolved different reasoning options
moves that pin and relaunches instead of silently running the old model's thinking config on
the new model.

LIVE-VERIFY: whether `applyFlagSettings({ effortLevel })` alone takes effect on the very next
turn was not watched on a live model. Irrelevant to the verdict — the coupling above decides
it either way — but it is the thing to check if effort is ever revisited.

### `fastMode` — RELAUNCH

`Settings.fastMode` exists (`sdk.d.ts:6605`) and `applyFlagSettings` accepts any `Settings`
key, so a live path plausibly exists. Two things stopped it being taken:

1. The launch spells fastMode through `Options.settings`, a **different layer** from the
   flag-settings layer `applyFlagSettings` merges into, and there is a second, adjacent key
   (`fastModePerSessionOptIn`, `sdk.d.ts:6609`) whose interaction with it is not documented.
2. `applyFlagSettings` shallow-merges top-level keys, so a later call with any other
   `settings` key would silently drop it.

Neither is fatal; both are unverified. A relaunch costs one cold boot on a setting a person
toggles rarely, and a wrong answer costs a turn that ran in the wrong mode. Fail safe.

LIVE-VERIFY: `applyFlagSettings({ fastMode })` on a live query, against `Options.settings`.
Move the pin to `live` only after watching a turn actually change behaviour.

### `mcpServers` is compared by SET, not by instance

The MCP server factory builds new `McpServer` objects per launch on purpose ("Already
connected to a transport" from reusing one), so object identity is meaningless across
launches. The fingerprint compares names and transports. Without that, `setMcpServers` would
fire on every dispatch and reconnect every server for no change.

### The agent identity token is pinned by IDENTITY, not by value

`agent-identity-service.mint()` returns fresh random bytes on every call, so two resolutions
for the same agent produce different tokens. Pinning the token value would relaunch on every
single dispatch and warmth would never exist. The pin is the identity the token was minted
for. Revocation does not need a relaunch either: a revoked token stops resolving for the live
process too, so the tools it authorizes start failing rather than quietly continuing to work.

---

## Verdict 2: `startup()` / `WarmQuery` — evaluated, not adopted — task 3.5 (DOR-1170)

`startup({ options, initializeTimeoutMs })` is exported and implemented (`sdk.mjs`, the
function behind the `startup` export). It spawns the subprocess, awaits
`initializationResult()`, and returns a handle whose `query(prompt)` may be called once — a
second call throws `WarmQuery.query() can only be called once`.

**It does not change the pin list.** `startup()` takes the same `Options` a launch does,
`resume` included, so every pinned value is still resolved once at launch under either boot
path. The fingerprint, its comparison, and the unconditional account rule are identical with
or without it.

Where it would genuinely fit is the pump's `warm()` path, which today boots through
`createIdlePrompt()` — a held stream containing no message — only to get a process up without
opening a turn. `startup()` does that with no prompt at all, and its one-shot `query()` is not
a constraint, because a pump calls `query()` once per process anyway. Its default
`initializeTimeoutMs` (60 s) even matches the pump's own `INIT_TIMEOUT_MS`.

Left alone here for scope: adopting it edits `session-pump.ts`'s boot path, which task 3.5
does not own, and it buys the pin list nothing. Worth raising against the pump itself.
