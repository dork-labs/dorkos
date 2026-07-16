---
slug: universal-command-intents
id: 260716-234343
created: 2026-07-16
status: ideation
linearIssue: DOR-109
project: Universal Command Interface
---

# Universal Command Intents with Cross-Agent Aliases (compact / clear / context)

**Slug:** universal-command-intents
**Author:** Hopper (IDEATE stage, /flow drain)
**Date:** 2026-07-16
**Tracker:** DOR-109 (Universal Command Interface project) · type hypothesis · size 5 · Medium
**Maturity:** partial spec — design direction already validated; this ideation deepens it with codebase reality and surfaces what the direction missed. Fast-tracked toward SPECIFY.

---

## 1) Intent & Assumptions

- **Hypothesis (verbatim from DOR-109):** If DorkOS defines canonical command intents with cross-agent aliases — typing any major agent's name for an intent works on any runtime — users keep their muscle memory regardless of which agent they came from, and DorkOS commands become a portable, runtime-agnostic surface.

- **Verified cross-agent landscape (2026-06-11, official docs — preserved verbatim):**

  | Agent       | Compact                         | Clear/new   | Context usage                                    |
  | ----------- | ------------------------------- | ----------- | ------------------------------------------------ |
  | Claude Code | `/compact [instructions]`       | `/clear`    | `/context`, `/usage` (aliases `/cost`, `/stats`) |
  | Codex CLI   | `/compact`                      | `/new`      | `/status`                                        |
  | OpenCode    | `/compact` (alias `/summarize`) | `/new`      | TUI                                              |
  | Gemini CLI  | `/compress`                     | `/clear`    | `/stats`                                         |
  | Cursor CLI  | `/compress`                     | `/new-chat` | —                                                |
  | Copilot CLI | none (auto-only)                | `/clear`    | `/usage`, `/session`                             |

- **Design direction (from investigation session "compact-and-commands", preserved):**
  - Canonical intents in `@dorkos/shared`: `compact`, `clear`, `context` — start with exactly three (less, but better).
  - Runtimes declare support via `RuntimeCapabilities` (e.g. a `commandIntents` map); the Claude runtime fulfills `compact` by sending the bare `/compact` prompt.
  - Alias resolution server-side at the message-dispatch chokepoint — all four client surfaces benefit without duplicating logic.
  - Palette dedupe: native runtime command + universal intent merge into one entry; aliases act as search keywords ("also: /compress, /summarize" hint).
  - Honest unsupported state: disabled entry "Not supported by {runtime}" — never silent failure.
  - `clear` intent maps to a DorkOS-native action (fresh session in the same project, linked back) — identical across all runtimes, sidesteps `/clear`-under-resume-per-message semantics.
  - Emulated compaction for non-native runtimes is deliberately out of scope (separate idea issue — DOR-114).

- **Validation criteria (preserved):**
  - Typing `/compress` or `/summarize` on the Claude runtime triggers compaction.
  - Palette shows one entry per intent with alias hints, no duplicates.
  - `RuntimeCapabilities` cleanly gates intents per runtime (verified with `FakeAgentRuntime`).

- **Confidence (from DOR-109):** high — mechanism proven this session; design validated against SDK types + cross-agent docs.

- **Assumptions carried in:**
  - The runtime abstraction (`AgentRuntime`, `RuntimeCapabilities`) is the right home for per-runtime intent fulfillment — consistent with ADR-0256 (structured caps first-class) and ADR-0273 (neutral-down, adapter-expands boundary).
  - The prior-art seams (bare command dispatch, SDK aliases, ranker with alias provenance, native-command seam, global palette) are stable and are the surfaces this feature composes with — not rewrites them.
  - Three-runtime scope for launch: claude-code, codex, opencode. Gemini/Cursor/Copilot rows inform the _alias vocabulary_ users type, not adapters to build.

- **Out of scope:**
  - Emulated compaction for runtimes without a native compact (DOR-114 — Triage).
  - Adding a fourth+ canonical intent (`model`, `resume`, `export`, `usage`-as-command). Three intents only.
  - Runtime-agnostic usage/cost _status surface_ — that is DOR-100 (`runtime-usage-status`). This issue must coordinate the `context` intent with it (see Decisions), not re-implement it.
  - The Cmd+K global-palette redesign (already shipped via `command-palette-10x`).

---

## 2) Pre-reading Log

- `AGENTS.md` — quality bar (world-class UX + DX), FSD layer rule, SDK-import confinement (each runtime SDK banned outside its adapter dir), "describe what happens for the user."
- `decisions/0273-runtime-neutral-context-injection.md` — **the load-bearing precedent.** §"Same rule for commands": _"Universal command intents (compact / clear / context) translate at the same boundary — neutral intent down, per-runtime expansion in the adapter. This ADR is the shared principle for both context and commands; the command track is tracked under the Universal Command Interface project (DOR-109)."_ DOR-109 is the _named_ command sibling of the context channel.
- `research/20260315_agent_sdk_slash_command_discovery_api.md` — the SDK exposes `Query.supportedCommands()` → `SlashCommand { name, description, argumentHint }` and `commands_changed` mid-session pushes; DorkOS merges these with its filesystem scan. Confirms Claude-side discovery is authoritative and includes built-ins (`/compact`, `/clear`).
- `research/20260303_command_palette_agent_centric_ux.md` — cmdk `keywords` prop is the mechanism for alias search; inline slash palette (`features/commands`) and global Cmd+K palette (`features/command-palette`) are two distinct systems, both kept.
- `specs/web-chat-native-commands/*` (DOR-128, ADR-0300, shipped) — the client-side native-command seam. **Explicitly declares DOR-109's intents (compact/clear/context) out of its scope and independent** — leaving the intent set for this issue.
- `specs/command-palette-10x/*` (#87, shipped), `specs/sdk-command-discovery/*` (#133), `specs/improve-slash-commands/*` (#19) — the palette/ranking/discovery lineage this composes with (see Codebase Map + Research §Prior Art).

---

## 3) Codebase Map

**Primary components/modules:**

- `packages/shared/src/agent-runtime.ts:242-308` — `RuntimeCapabilities`. Today: flat booleans + structured `permissionModes` (first-class, ADR-0256) + `nativeContext` + `logBackedHistory?` + a `features: Record<string, unknown>` extension point. **No `commandIntents` field exists yet — this is the core additive change.**
- `packages/shared/src/schemas.ts:1547-1574` — `CommandEntrySchema` / `CommandRegistrySchema`. `aliases?: string[]` already exists (DOR-108) but is populated with runtime-_native_ aliases (e.g. Claude's `/cost`,`/stats` → `/usage`), **not** cross-agent aliases. This is the field the palette-merge/hint would extend or feed.
- `apps/server/src/services/session/trigger-turn.ts` — the runtime-neutral server turn chokepoint (ADR-0264). Assembles the neutral context bag, then calls `deps.sendMessage(sessionId, content, { cwd, additionalContext })` with **`content` passed pristine.** This is the "message-dispatch chokepoint" the design direction names — but note it does **not** currently do slash-command detection (see below).
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts:343-369` — where slash-command dispatch **actually** happens today: `detectSlashCommandName(content)` (76) + `getKnownCommands()` (349) set `isCommandDispatch`, which trims the content bare and skips the context prepend (DOR-107 command-skip guard). `getKnownCommands` is a **Claude-SDK-specific** cache — not runtime-neutral.
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts:637-654` + `:761-790` — SDK command discovery: `supportedCommands()` on first query and the `commands_changed` mid-session push, both mapping `aliases` through (DOR-108).
- `apps/server/src/services/runtimes/{codex,opencode}/*-runtime.ts` — `getCapabilities()` returns a static caps constant; `getCommands()`: codex surfaces authored skills only (`codex-runtime.ts:679`), opencode returns `[]` (`opencode-runtime.ts:667`). Neither has any `/compact` / `/clear` / `/context` trigger path today.
- `apps/server/src/routes/commands.ts` — `GET /api/commands` resolves a runtime (explicit `runtime` param → `sessionId` → default) and returns its `CommandRegistry`.
- `apps/client/src/layers/entities/command/lib/rank-command.ts` — the DOR-119/120 ranker: ranks name > alias > description, surfaces `matchedAlias` provenance.
- `apps/client/src/layers/features/commands/ui/CommandPalette.tsx:89-91` — inline `/` palette already renders a "matched /{alias}" hint. The alias-hint UX the design direction wants **already exists** for native aliases.
- `apps/client/src/layers/features/chat/model/native-commands/registry.ts` — the client-side native-command seam (ADR-0300): a `NATIVE_COMMANDS` registry, `parseNativeCommand`, intercepted at `executeSubmission` + `useChatQueue.handleQueue` so a native command never reaches the runtime. `/rename` is the sole entry today. **This is the natural home for the `clear` intent** (a DorkOS-native action).
- `apps/client/src/layers/features/command-palette/*` — the global Cmd+K palette (`command-palette-10x`, Fuse.js, prefix modes `@`/`>`/`#`).

**Shared dependencies:** `Transport` (`packages/shared/src/transport.ts:487` `getCommands`) with `HttpTransport` (web) and `DirectTransport` (Obsidian, in-process). `CommandEntry`/`CommandRegistry`/`RuntimeCapabilities` are all `@dorkos/shared` types crossing the boundary.

**Data flow (compact today, Claude):** user types `/compact` → client send path → `POST /api/sessions/:id/messages` → `trigger-turn` (pristine content) → `claude-code` `message-sender` detects known command → sends bare `/compact` to SDK → CLI compacts. **Non-Claude runtimes have no equivalent path.**

**Feature flags/config:** none specific. Intents are a static registry, not user config.

**Potential blast radius:**

- `RuntimeCapabilities` shape change → touches every adapter's caps constant + `FakeAgentRuntime` in `@dorkos/test-utils` (compile-time forcing is intentional) + the OpenAPI/`getCapabilities` DTO.
- Both palettes (inline `features/commands` + global `features/command-palette`) and the ranker.
- The `clear` intent touches the native-command seam (client) _and_ session-creation/linking.
- Codex/OpenCode adapters' dispatch path (they gain intent handling they don't have today).

---

## 5) Research

### Prior art — what already shipped, and what DOR-109 adds on top

DOR-109 sits on a nearly-complete substrate. The Universal Command Interface project already landed most of the plumbing; DOR-109 is the _canonicalization + cross-agent_ layer, not a green field.

| Prior work                                         | Status                                                                                                                                                                                        | What it provides                                                                                                                   | What DOR-109 adds / whether it conflicts                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DOR-107** (bare slash dispatch)                  | Shipped (`message-sender.ts:343-369`)                                                                                                                                                         | `/`-prefixed content reaches the CLI bare; command-skip guard suppresses context prepend on command turns.                         | DOR-109 must route a _resolved_ intent through this same guard. **Constraint:** the guard lives _inside the Claude adapter_, keyed off a Claude-specific `getKnownCommands` cache — so "resolve aliases at the chokepoint" needs a home decision (Decision 2). Not a conflict, but the design direction's phrase "server-side at the message-dispatch chokepoint" does not match where dispatch physically happens today. |
| **DOR-108** (SDK aliases)                          | Shipped (`schemas.ts:1559`, `message-sender.ts:640,761`)                                                                                                                                      | `CommandEntry.aliases`, populated from SDK `supportedCommands()` + `commands_changed`.                                             | These are runtime-_native_ aliases. DOR-109 adds _cross-agent_ aliases (`/compress`→compact) that the SDK will never report. Decision: reuse `aliases` for cross-agent terms vs. a separate field (Decision 5).                                                                                                                                                                                                           |
| **DOR-119/120** (ranker + alias provenance)        | Shipped (`rank-command.ts`, `CommandPalette.tsx:89`)                                                                                                                                          | Fuzzy ranking name>alias>description; "matched /{alias}" hint already renders.                                                     | The "aliases act as search keywords + hint" requirement is **already satisfied mechanically** — DOR-109 just feeds cross-agent aliases into it. Low risk.                                                                                                                                                                                                                                                                 |
| **`sdk-command-discovery`** (#133)                 | Landed via the DOR-107/108 track (the #133 `04-implementation.md` reads 0/5, but `supportedCommands()` + merged SDK/filesystem discovery are live in `message-sender.ts`/`runtime-cache.ts`). | Claude command discovery is SDK-authoritative and includes built-ins (`/compact`,`/clear`).                                        | DOR-109 relies on this to know Claude's native fulfillment strings. The stale #133 04-doc should be reconciled to `superseded`/`implemented` (housekeeping, not scope).                                                                                                                                                                                                                                                   |
| **`command-palette-10x`** (#87)                    | Shipped                                                                                                                                                                                       | Global Cmd+K palette: Fuse.js search, prefix modes (`@`/`>`/`#`), preview, sub-menus.                                              | DOR-109's palette-dedupe must land in the **inline** slash palette (where `/compact` is typed) primarily; whether the global palette also surfaces intents is a scope decision. No conflict.                                                                                                                                                                                                                              |
| **`web-chat-native-commands`** (DOR-128, ADR-0300) | Shipped                                                                                                                                                                                       | Client-side native-command seam; `/rename`; intercepts before the runtime.                                                         | **Directly relevant:** the `clear` intent = a DorkOS-native action ("fresh session, linked back") → belongs in this seam, not the runtime seam. The spec _explicitly_ left compact/clear/context to DOR-109. So DOR-109 spans **two seams** (runtime-fulfilled compact/context; client-native clear) — the design direction implies this but doesn't name it.                                                             |
| **ADR-0273** (runtime-neutral context)             | Accepted/implemented                                                                                                                                                                          | The boundary principle: neutral intent down, per-runtime expansion in the adapter — and it _names DOR-109_ as the command sibling. | DOR-109 is the ADR's own designated follow-through for commands. Strong architectural mandate for the "canonical intent in shared, adapter expands" shape.                                                                                                                                                                                                                                                                |

**Net:** No prior spec partially implements universal intents. The _cross-agent canonical layer_ is genuinely new. Everything DOR-109 needs to _compose with_ is shipped and stable.

### Per-runtime fulfillment reality (the honest matrix)

| Intent                                                              | claude-code                                                                                                                            | codex                                                                                                                                                  | opencode                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **compact**                                                         | Native `/compact` — send bare (works today via DOR-107).                                                                               | `codex exec` **cannot** run TUI commands; SDK has no command API → **genuinely unsupported** → honest disabled state. (Emulated compaction = DOR-114.) | Sidecar **has native compaction** (`event-mapper.ts:239` maps `session.compacted`) but **no trigger path is wired**. Could be fulfilled via a sidecar call — that wiring does not exist yet (Decision 3). |
| **clear** (DorkOS-native: fresh session, same project, linked back) | Identical across all three — it's a client/server DorkOS action, **not** a runtime command. Sidesteps `/clear`-under-resume semantics. | same                                                                                                                                                   | same                                                                                                                                                                                                      |
| **context**                                                         | Native `/context` / `/usage`.                                                                                                          | `/status` (not runnable under `exec` — same limitation as compact).                                                                                    | TUI-only; no headless equivalent.                                                                                                                                                                         | **Overlaps DOR-100** (`runtime-usage-status`), which introduces a runtime-neutral `UsageStatus` _status item_. Question: is `context` a command intent at all, or already the DOR-100 surface? (Decision 4). |

### Solution options (where intent resolution lives)

1. **Resolve at `trigger-turn` (server, runtime-neutral) using `getCapabilities().commandIntents`.** A shared `@dorkos/shared` registry maps cross-agent alias → canonical intent (runtime-neutral); the active runtime's caps map intent → fulfillment; `trigger-turn` rewrites `/compress` → `/compact` before `sendMessage`. **Pros:** matches ADR-0273 boundary exactly; one place, all transports (Http + Direct) benefit; adapters stay dumb. **Cons:** `trigger-turn` today does no command detection — adds a responsibility; the existing DOR-107 guard still lives in the adapter, so detection would exist in two places unless refactored.
2. **Resolve inside each adapter's `sendMessage`, reading the shared intent registry.** **Pros:** dispatch already lives there (Claude); guard stays put. **Cons:** duplicated across three adapters; violates the "one chokepoint" goal; drifts from ADR-0273's "neutral down" (adapters would each re-derive the neutral→canonical map).
3. **Split by intent type (recommended synthesis):** cross-agent **alias→canonical-intent** map is a pure `@dorkos/shared` registry (usable by client palette _and_ server). **compact/context** (runtime-fulfilled) resolve at the server boundary via `commandIntents` capability (option 1's mechanism). **clear** (native action) resolves client-side in the existing native-command seam (ADR-0300). This honors both existing seams and ADR-0273, and keeps each intent where its execution actually lives.

**Recommendation:** Option 3. It is the only option that reconciles the two shipped seams (runtime dispatch vs. client-native) with the ADR-0273 boundary, rather than forcing all three intents through one path they don't share.

---

## 6) Decisions

Resolved during ideation (design direction + codebase reality). Genuine ambiguities that need the human are in **Open Questions**.

| #   | Decision                                                                            | Choice                                                                                                                                                                                              | Rationale                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Canonical intent set                                                                | `compact`, `clear`, `context` — exactly three, defined in `@dorkos/shared`                                                                                                                          | Matches DOR-109 verbatim and "less, but better." Adding a fourth is a separate issue.                                                                                                                                                |
| 2   | Where cross-agent alias → canonical intent is defined                               | A pure `@dorkos/shared` registry (alias table + intent metadata), consumed by both client (palette) and server (dispatch)                                                                           | Runtime-neutral, single source of truth; both transports and both palettes read the same table. Honors ADR-0273 "neutral down."                                                                                                      |
| 3   | Where a runtime-fulfilled intent (compact/context) is resolved to a runtime command | At the server boundary via a new `RuntimeCapabilities.commandIntents` map (intent → fulfillment/unsupported), applied where dispatch happens                                                        | ADR-0273 mandate (adapter expands); capability-gated so `FakeAgentRuntime` verifies per-runtime gating (validation criterion 3). Exact insertion point (trigger-turn vs. adapter refactor) is a SPECIFY-level detail — see Open Q A. |
| 4   | `clear` intent implementation                                                       | A DorkOS-native action (fresh session in the same project, linked back), landing in the existing native-command seam (ADR-0300), **not** a runtime command                                          | DOR-109 says so explicitly; sidesteps `/clear`-under-resume semantics; identical across runtimes; reuses the shipped `native-commands` seam.                                                                                         |
| 5   | `commandIntents` placement in `RuntimeCapabilities`                                 | First-class structured field (sibling of `permissionModes`), **not** the `features` bag                                                                                                             | ADR-0256: genuinely-structured, cross-runtime capabilities are first-class; `features` is for runtime-_specific_ metadata. Intents are cross-runtime.                                                                                |
| 6   | Palette dedupe + alias hint                                                         | Reuse the shipped DOR-108/119/120 alias field + ranker + "matched /{alias}" hint; merge the universal intent and the native runtime command into one entry                                          | The mechanism already exists (`rank-command.ts`, `CommandPalette.tsx:89`). Minimizes new surface; satisfies validation criterion 2.                                                                                                  |
| 7   | Honest unsupported state                                                            | Disabled palette entry "Not supported by {runtime}", driven by `commandIntents` gating; never silent                                                                                                | DOR-109 requirement + "be honest by design."                                                                                                                                                                                         |
| 8   | Runtime scope                                                                       | claude-code (compact/context native), codex (compact/context unsupported → disabled), opencode (compact native-if-wired, context unsupported); Gemini/Cursor/Copilot inform _alias vocabulary_ only | Three launch runtimes; the extra rows are muscle-memory sources, not adapters.                                                                                                                                                       |

### Open Questions (need the human operator — bounded, decision-ready)

- **A. OpenCode `compact` — wire it now or defer?** OpenCode has _native_ compaction in the sidecar (`event-mapper.ts:239`) but no trigger path exists. Options: **(a)** wire opencode's native compact in this issue (adds an adapter method + sidecar call, modest scope creep on a size-5), or **(b)** mark opencode `compact` "unsupported" for now and wire it in a fast-follow. Recommendation leans (b) to keep DOR-109 tight, but (a) is the higher-value demo. **Which?**
- **B. `context` intent vs. DOR-100 (`runtime-usage-status`).** For Claude, `context` is a real command (`/context`/`/usage`). For codex/opencode there is no headless command — the equivalent is the DOR-100 runtime-neutral `UsageStatus` _status item_. Options: **(a)** `context` intent = "open/focus the usage-status surface" (a DorkOS-native action like `clear`, unifying with DOR-100), or **(b)** `context` = a runtime command intent that only Claude fulfills and everyone else shows disabled. **(a)** is more coherent but couples DOR-109 to DOR-100's shape. **Which framing?**
- **C. Scope of the palette merge — inline only, or global Cmd+K too?** The inline `/` palette is where `/compact`/`/compress` are typed and is the must-have. Should universal intents _also_ appear in the global Cmd+K palette (`command-palette-10x`), or is inline-only sufficient for v1? (Global adds surface for little muscle-memory value.)

### Risks

- **Two-seam split is the subtle part.** compact/context (server, runtime) and clear (client, native) resolve in different layers via different mechanisms. If SPECIFY treats all three uniformly it will fight one of the two shipped seams. The alias→intent _registry_ is shared; the _execution_ is not. Call this out loudly in the spec.
- **`RuntimeCapabilities` change is compile-time viral** (intended): every adapter caps constant + `FakeAgentRuntime` + the caps DTO must be updated. Low risk but touches many files.
- **DOR-107 guard duplication.** If resolution moves to `trigger-turn`, the adapter's `getKnownCommands`-based guard and a new neutral resolver could both exist — a "no half-migrations" hazard (AGENTS.md). SPECIFY must decide whether to lift the guard to the boundary or leave it and layer intents above it.
- **Silent-failure regression on unsupported runtimes.** Today, typing `/compact` on codex likely sends it as bare text to the model (no-op-ish). The honest-disabled-state requirement means the palette must _gate_ the entry — but a user can still _type_ `/compact` in the composer. Decide whether the composer send path also surfaces "not supported by {runtime}" or only the palette hides it.

### Recommended direction & next step

**Next step: move-to-specify.** The mechanism is proven (DOR-109 confidence: high) and the design direction is validated, but ideation surfaced three genuine, bounded decisions (Open Q A/B/C) and one non-obvious architectural reality (the two-seam split; the "chokepoint" is not where dispatch lives today) that must be resolved _before_ freezing a spec. This is more than "adapt-directly-into-spec" (there are real forks to resolve) and past "stay-in-ideation" (the substrate is shipped and the shape is clear).

Concretely, SPECIFY should: (1) resolve Open Q A/B/C with the operator; (2) define the `@dorkos/shared` intent+alias registry (Decision 2) and the `RuntimeCapabilities.commandIntents` shape (Decisions 3, 5); (3) pin the server resolution point and reconcile it with the DOR-107 guard; (4) route `clear` through the ADR-0300 native seam (Decision 4); (5) feed cross-agent aliases into the existing ranker/hint (Decision 6); (6) update all three adapters + `FakeAgentRuntime` and add the conformance gate for `commandIntents`. Draft ADR candidate: "Canonical command intents + cross-agent alias resolution" (extends ADR-0273's command clause from principle to contract).
