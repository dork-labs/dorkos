# Message search — implementation record

Closed 2026-08-26. Every phase shipped, the deferred-work tickets included; the spec is implemented (Amendments 8–11 track where delivery moved past the frozen text).

## What shipped

| Area                     | PRs                              | What landed                                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core index + sources     | #1280–#1283, #1291, #1294, #1295 | The derived, rebuildable FTS5 index (ADR `260728-214214`); Claude Code transcript indexing (DOR-681, bare-CLI sessions included, all profiles); the query API (DOR-684); OpenCode subdir-session fix (DOR-674).                                                                  |
| Palette UI               | #1296                            | ⌘⇧F message search in the command palette (DOR-685).                                                                                                                                                                                                                             |
| Codex + OpenCode sources | #1297, #1303                     | Codex rollouts (DOR-683); OpenCode via snapshot + allowlist (DOR-688, ADR `260825-110420` amends 0308). Scope copy flipped truthful in #1312 (DOR-1556, Amendments 8–10).                                                                                                        |
| Authoring guide          | #1307                            | `contributing/adding-a-search-source.md`, pinned by `guide-example.test.ts` (DOR-686).                                                                                                                                                                                           |
| Embed (Obsidian)         | #1310, #1319, #1325              | DOR-691 groundwork (answerSearch seam, `DirectTransport.search`, parity tests), then DOR-1563: prebuilt SQLite addons (SHA-256-pinned), strictly read-only index access (`peekOperator`, no second writer), polyfill hardening, and the gate flip — search runs inside Obsidian. |
| Sweep hardening          | #1327                            | DOR-709 (a source failing discovery is recorded and the sweep continues) + DOR-702 (the sweep yields to the event loop; boot never blocks).                                                                                                                                      |
| Land on the message      | #1328                            | DOR-687: channel/DM hits land on the exact message (ordinal = room `seq`), consumed-once landing semantics, thread hits open the thread on the reply; transcripts stay container-level (Amendment 11, follow-up DOR-1579).                                                       |
| Hygiene found on the way | #1313, #1320                     | e2e manifest description rot (DOR-1555); raw-NUL grep hazard + CI guard (DOR-1561).                                                                                                                                                                                              |

## Deliberate limits, stated in the product

- Tool output is never indexed; matching is whole-word (porter unicode61) — the scope copy says both, pinned by tests.
- Sessions are owner-only and reachable by no agent (spec §7).
- The Obsidian embed reads what the DorkOS app has indexed (read-only; staleness stated in the scope copy).
- Transcript hits land at the container until a stable per-message id exists end to end (DOR-1579).

## Open follow-ups (filed, outside this spec's scope)

DOR-1577 (full-suite worker OOM on the dev machine), DOR-1578 (sweep re-entrancy guard; `runSweep`'s TSDoc records why overlap is currently safe), DOR-1579 (transcript per-message id).

## Evidence pointers

Tracker: umbrella DOR-672 (Done with evidence, 2026-08-25); project "Search Every Message". Adversarial-review rounds with mutation proofs are summarized in each PR body (#1319, #1325, #1327, #1328). The e2e deep-link spec (`apps/e2e/tests/search/message-search-deeplink.spec.ts`) asserts the landed row's box inside the scroller — the assertion the task file itself required.
