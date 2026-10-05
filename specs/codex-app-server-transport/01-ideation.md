---
slug: codex-app-server-transport
id: 261005-112122
created: 2026-10-05
status: ideation
linearIssue: DOR-2719
---

# Run Codex through `codex app-server`, not `codex exec` per turn

## Intent

Dorian, #dorkos 2026-10-05: "let's switch to using the codex app-server. This is not
urgent, but high priority as Codex will not work correctly until we do it."

Today `@openai/codex-sdk` spawns `codex exec --experimental-json` for every turn and
closes stdin. The process exits at turn end, so background terminals and sub-agents
die with it, there is no approval channel, no mid-turn steer, and no thread listing.
Codex's own guidance puts app-server at "deep integration inside your own product"
(the VS Code extension and Codex Desktop use it) and the SDK at CI/automation.

## Sources

- DOR-2719 (build list and done-when).
- `decisions/0309-codex-adapter-sdk-threads.md` — the decision being superseded.
- `research/20261005_codex-app-server-protocol-0154.md` — protocol reference, from the
  vendored 0.154.0 binary's generated schema, a free smoke run, and upstream source.
  Generated schemas: regenerate with
  `<vendored codex> app-server generate-json-schema --experimental --out <dir>`.
- `apps/server/src/services/runtimes/codex/` (runtime, `model-catalog.ts` app-server
  client, `NOTES.md`), `packages/test-utils/src/runtime-conformance.ts`,
  `apps/server/src/services/runtimes/opencode/server-manager.ts` (ADR-0308, the
  long-lived child precedent), `.claude/config/runtime-deps.json`.
- `research/20260911_connections-codex-chat-proof.md` — a live regression oracle.

## Codebase findings

1. **The SDK seam is narrow.** Only `codex-runtime.ts`, `codex-options.ts`,
   `turn-input.ts`, `event-mapper.ts`, `mcp-server-config.ts` and `credits-launch.ts`
   touch SDK types. Thread map, registry, context gate, rollout readers, account
   usage and skills are SDK-free.
2. **An app-server client already exists**, one-shot: `model-catalog.ts` spawns
   `codex app-server --stdio`, frames newline JSON, does `initialize`/`initialized`,
   pages `model/list`. No request map, no notifications, no server→client requests,
   no lifecycle.
3. **One process = one `CODEX_HOME` + one env.** Credits turns run in their own home
   (`creditsCodexHome`) with a provider entry and a per-turn env key. So DorkOS needs
   at least two processes: the person's home and the credits home.
4. **Per-turn secrets ride env today** (DorkOS MCP bearer, connector header, credits
   key), because `-c` config is flattened into argv. On a long-lived process they must
   move to per-thread `config` over stdin JSON-RPC (not visible in `ps`) or to a
   process keyed by them. This is the main design risk.
5. **Protocol facts that shape the design** (research §): `turn/start` on a thread
   with an active turn joins that turn; events (background terminal exits, sub-agent
   completions) arrive after `turn/completed` under the old turn id; background
   terminal control needs `experimentalApi: true`; token usage comes from
   `thread/tokenUsage/updated`, not `turn/completed`; approvals never time out
   server-side and `serverRequest/resolved` reports clears; `thread/start` starts the
   person's own configured MCP servers and can mark the project trusted in their
   `config.toml`.
6. **The conformance suite has hooks for everything we want to declare**: persistent
   session (warmSession), steer (dispositionTurn proving in-turn delivery), interrupt,
   durable history. No dedicated approval case: add one.
7. **Mode descriptors** say Codex "never asks". With approvals they change, which also
   feeds the DOR-2714 ceiling comparison (descriptor-based, so it stays correct).

## Assumptions

- The vendored, pinned binary (`@openai/codex@0.154.0`) is the app-server we run.
- Exec stays as a selectable fallback until app-server passes conformance and a live
  proof, then app-server becomes the default; exec is removed in a later cleanup once
  app-server has shipped a release without needing the switch.
- A real Codex chat for the done-when proof runs on the operator's own Codex sign-in.

## Trade-offs

- **Transport switch vs big-bang swap.** A switch (`runtimes.codex.transport`) costs a
  config field and two code paths for a while, but lets each phase merge safely and
  gives a way back. Chosen.
- **One process per home vs per thread.** Per home matches how Codex Desktop works and
  is what keeps background work alive. Per thread would rebuild exec's lifetime.
  Chosen: per (binary, CODEX_HOME, env fingerprint).
- **Secrets per thread config vs per process.** Thread config keeps one process per
  home; if a loaded thread cannot take new config, fall back to resuming with fresh
  config or a longer-lived token. Decided in the spec's phase-1 spike, with evidence.

## Recommended direction

Three build phases behind one transport seam:

1. **Turns on app-server**: JSON-RPC client, supervised process pool, thread
   start/resume, streaming, interrupt, usage, MCP injection, credits — behind the
   switch, default exec. Protocol schema snapshot + check, so a binary bump flags
   protocol changes.
2. **Interaction**: real approvals (`supportsToolApproval: true`, new mode mapping),
   `turn/steer`, approval conformance case.
3. **Lifetime**: background terminals and sub-agents outlive the turn and wake the
   chat; thread listing; flip the default to app-server; docs; live proof.

## Next step

SPECIFY, with a new ADR superseding ADR-0309.
