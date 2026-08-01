# Mesh identity integrity — ideation

**Ticket:** DOR-790. **Source:** the 2026-07-31 messaging deep review, corrected by a code-level recon of `main` at `2838947fc` (2026-08-01).

## The three defects

1. **A duplicated checkout can silently steal an agent's identity.** `.dork/agent.json` is git-tracked, so this repo plus its nine `.claude/worktrees/*` checkouts all carry the same manifest ULID (`01KJXYKJYW4N8QGQ5W4GB6YM9J`, verified). The scanner auto-imports every manifest it finds (`unified-scanner.ts:136-141` — the `isRegistered` guard at `:160` gates strategy candidates, not auto-import), and `AgentRegistry.upsert` resolves an id conflict by rewriting `projectPath` to the newcomer (`agent-registry.ts:122-144`, the rewrite at `:128`). Last directory in BFS order wins, and BFS order is `fs.readdir` order — unsorted, filesystem-dependent (`unified-scanner.ts:102,191-199`). When the row moves, `@handle` resolution goes null (`author-handles.ts:43-46` looks up `agents.byPath(naturalKey)` live), `responseMode` falls back to `'always'` (`room-roster.ts:206`), and room membership 404s (`room-roster.ts:234`).
2. **Ghost authors keep their claims (H11).** Nothing ever deletes an `authors` row. A relocated agent's old row stays in rosters; `claimNames` is first-claimant-wins over the roster (`mentions.ts:99-108`), and a room can still target a member whose directory no longer holds any live agent.
3. **Directory reuse inherits history (H12).** `AuthorRegistry.resolve` mints purely on `(kind, naturalKey)` with no ownership or liveness check (`author-registry.ts:142-199`). Registering a _new_ agent in a previously-occupied directory silently reattributes the previous agent's entire message history to the newcomer. ADR `260726-170126` documented the _move_ direction (a moved agent splits in two — accepted); the _reuse_ direction is absent from both the ADR and the code.

## Corrections to the review (from the recon — these bound the urgency, not the fix)

- Defect 1 is **live-but-unfired** here: the 5-minute reconciler never reaches the worktrees (`RECONCILE_DISCOVERY_MAX_DEPTH = 2`, `mesh-core.ts:58`; and the live row's `scan_root` is `$HOME`, filtered by the homedir-fallback guard at `mesh-core.ts:466-479`). The trigger is a user-initiated `mesh_discover` (depth 5). The DorkOS row still points at the repo root today.
- The handle isn't _lost_ on theft, it _stops resolving_ — and comes back the instant the row returns. That makes the failure intermittent and unattributable, which is worse to debug, not better.

## The decision: keep committed ids, refuse the silent relocation

Two options were on the table (recorded on DOR-790 and the program handoff):

**(a) Treat a manifest-id conflict at a different path as a conflict.** Contained: `AgentRegistry.upsert` and the auto-import call site (`mesh-discovery.ts:236-258`) are the only two seams. Nothing downstream changes shape — `authors`, `room_*`, and `agent_identity_tokens` are all path-keyed by prior decisions.

**(b) Stop trusting git-committed ids; mint machine-locally.** Rejected. The ULID is load-bearing for routing: relay subjects (`relay.agent.{ns}.{id}`, `relay-bridge.ts:128`), `tasks.agent_id` (with cascade-disable on unregister), `a2a.agent_id`, shapes, and every persisted relay binding hold it. Re-minting would force remap-or-rebuild across all of them, and `registeredAt`/`registeredBy` ride the commit too, so the scheme would need a new home for the local half. That is a migration program, not a fix — and (a) removes the harm without it.

The refinement that makes (a) correct rather than merely safe: **a same-id-different-path registration is a legitimate relocation exactly when the incumbent path no longer holds that manifest.** A user who moves an agent's directory must keep working (ADR-0043's file-first contract). A checkout that _duplicates_ a manifest while the original still exists is the theft case — and it is detectable by reading the incumbent path's manifest at conflict time.

Worktree checkouts get no special case. A linked worktree is just the most common duplicator; the incumbent-manifest-still-present check handles it generically, and it keeps working for the edge where the primary checkout is deleted and the worktree is the only surviving copy (that is then a true relocation).

## Constraints carried forward

- ADR `0043`: files are canonical, the `agents` table is a rebuildable index. The conflict rule must live in registration, not in a DB constraint alone.
- ADR `260726-170126`: author identity keys on the directory. The H12 fix stamps the occupant's manifest ULID on the author row to distinguish successive occupants of one directory — the directory stays the identity key, but storing the ULID **partially supersedes** that ADR's "never written into an author column" clause, and we say so rather than calling it an amendment. The clause's premise — reconciler ULID churn — is unreachable in current code: no reconciler path mints ids (every `ulid()` call site is registration or author mint; `reconciler.ts` only updates by existing id, and an ADR-0043 rebuild reads ids back from the files that store them). The "moved agent splits in two" cost stays accepted and unchanged.
- ADR `0076`: the ULID remains the routing id everywhere it is today.
- `specs/handles` Phase 2 (stored `authors.handle`) is adjacent, planned, and untouched by this work; `advertisedHandle`'s doc (`mentions.ts:137-142`) already defers the claim-everything problem there. This spec only removes _dead_ claimants, which is compatible with either outcome.
