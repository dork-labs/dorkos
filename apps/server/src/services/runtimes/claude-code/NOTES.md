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

**Carve-out added for DOR-1308.** "The selected model's capability" above is read from
`RuntimeCache.resolveModelCapability`, a cache that starts EMPTY on every server boot and is
populated by a session's own first turn. That made the pin's own logic self-defeating on the
very first session after a boot: launch 1 resolved `effort`/`thinking` against an unknown
capability, and dispatch 2 — landing after turn 1's response had warmed the cache — resolved
the SAME session setting into a different shape, so the pin read "changed" and relaunched a
process that had been warm for exactly one turn. Nothing the user had touched actually moved.

`compareLaunchFingerprints`'s `reasoningChanged` helper now carries the session's raw effort
setting alongside the derived shape (`LaunchFingerprint.reasoning`), and treats a derived-shape
difference as real only when BOTH sides resolved it against a known capability. A raw setting
change always relaunches regardless. This keeps the `setModel` guarantee above intact for the
case that matters — a live model swap once the cache is warm on both sides still relaunches —
and only stops treating "the cache hadn't finished warming up yet" as a change the user asked
for.

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

### `mcpServers` is compared by DECLARED CONFIG, not by instance

The MCP server factory builds new `McpServer` objects per launch on purpose ("Already
connected to a transport" from reusing one), so object identity is meaningless across
launches. Without ignoring it, `setMcpServers` would fire on every dispatch and reconnect
every server for no change.

`instance` is therefore the only field dropped. Everything else the config declares is
hashed into the descriptor, because two of those fields carry credentials: an `http`/`sse`
server's `headers` and a `stdio` server's `env`, both filled from the session's connector
accounts (`mcp-server-config.ts`). An earlier version compared only name, transport and
URL/command, which meant a refreshed OAuth token — or a switch to a different account on the
same toolkit, which keeps the server name and URL — compared EQUAL: `setMcpServers` never
fired and the warm process went on using the old credential. Fields are hashed rather than
spelled so no secret lands in the fingerprint.

### The agent identity token is pinned by IDENTITY, not by value

`agent-identity-service.mint()` returns fresh random bytes on every call
(`randomBytes(16).toString('hex')`), so two resolutions for the same agent produce different
tokens. Pinning the token value would relaunch on every single dispatch and warmth would
never exist. The pin is the identity the token was minted for.

**Revocation still bites a live process, and needs no relaunch — on the bearer path.** The
token in the child's env is only a lookup key; authority is resolved server-side on every
request. `resolve()` filters on `isNull(revokedAt)` per call and
`middleware/agent-identity.ts` calls it per request with no cache, so the moment
`revoke(agentPath)` marks the rows, the very next `dorkos call` from the running process
stops resolving. Nothing is baked in but the key.

Two precisions, because "stops resolving" is not the same as "stops working":

- A call that does not resolve becomes **unattributed**, not refused. Identity is never
  required, and the anonymous ceiling is `destructive` by default
  (`DEFAULT_ANONYMOUS_TIER_CEILING`), so revocation removes attribution and any
  identity-scoped standing grants — meaning MORE approval prompts — rather than failing the
  tools outright. It only denies where an operator has lowered `anonymousTierCeiling`.
- The **in-session** MCP path does not use the token at all: it resolves from the session's
  cwd via `describeAgent()`, and `createInSessionContextResolver` memoizes for the life of
  the MCP server instance — which is one per `query()`, i.e. one per PROCESS. Under a pump
  that is the whole warm lifetime, so a revocation lands only on the next relaunch, where on
  the resume-per-message path it landed on the next message. That is a property of warmth,
  not of this pin: `agentPath` does not move when a token is revoked, so no fingerprint row
  could catch it. Worth a follow-up against the pump — the resolver wants invalidating when a
  process is reused, not just when it is built.

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
