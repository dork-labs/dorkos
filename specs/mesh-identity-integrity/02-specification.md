# Mesh identity integrity — specification

Three mechanisms, one migration. All file:line citations are against `main` at `2838947fc`. `01-ideation.md` holds the decision and the rejected alternative; where they differ, this document wins.

## 1. M1 — the relocation guard

**Invariant: a registration that would move an agent's row to a new path succeeds only if the old path has actually given the manifest up.** While the incumbent path still holds a readable manifest with the same id, the newcomer is a duplicate, and a duplicate never registers, never relocates the row, and is never silent about it.

In `AgentRegistry.upsert` (`packages/mesh/src/agent-registry.ts:89-146`), before the id-conflict `onConflictDoUpdate` can rewrite `projectPath` (`:128`):

- Look up the existing row by id. If there is none, or its `projectPath` equals the incoming path, proceed as today.
- If the paths differ, read `<existing.projectPath>/.dork/agent.json`. **Same id still present there → refuse**: return without writing, and emit one structured `warn` naming both paths and the id (`mesh.identity.duplicate_manifest`). Damp the log per `(id, rejectedPath)` per process — a depth-5 `mesh_discover` over this repo would otherwise print nine identical lines per scan.
- Manifest gone, unreadable, directory missing, or its id changed → **true relocation**: proceed with the update, and log one structured `info` naming the move (`mesh.identity.relocated`). A user who moves an agent's directory keeps working; a worktree that outlives its deleted primary checkout becomes the agent, which is correct.

The refusal is a return value, not an exception: discovery's auto-import (`mesh-discovery.ts:236-258`) and `reconcileOnStartup` treat it as a skipped candidate, never a fatal error. The other conflict branch — different id at the same path deletes the incumbent (`agent-registry.ts:92-96`) — is a deliberate re-init and stays as is, but gains the test coverage it currently lacks.

**Scan determinism**, so the same disk always produces the same outcome: `unified-scanner.ts` sorts each directory's entries before enqueueing (`:191-199`). With M1 in place order no longer decides identity; sorting makes what it does still decide (candidate listing order) reproducible.

## 2. M2 — ghost authors release their claims

**Invariant: only an author whose directory currently resolves to a live agent may claim a handle or receive a turn.** History is untouched — old entries keep their author and render fine.

- `claimNames` (`apps/server/src/services/rooms/mentions.ts:99-108`) skips agent-kind candidates whose handle lookup (`author-handles.ts:43-46`, `agents.byPath(naturalKey)`) returns null. They stop claiming `@names` they can no longer answer to; a live agent with the same display name becomes reachable again.
- `advertisedHandles` (`author-handles.ts:89-97`) already returns nothing for them — pin that with a test.
- The trigger path refuses to dispatch to a member whose author has no live agent, and the refusal is visible per room-conduct: reuse `turn_failed` if the failure already surfaces there today, otherwise this is a new way to go quiet and earns its own notice code in `room-notices.ts`. Implementation verifies which before choosing.
- Rosters keep listing such members (marked by the existing degraded rendering) — membership is a fact about the room; the fix is about claims and dispatch, not display.

## 3. M3 — a reused directory starts a new author

**Invariant: an author row belongs to the occupant it was minted for. A different occupant in the same directory gets a fresh row; the old row keeps the old history and retires from active duty.**

Schema (`packages/db/src/schema/rooms.ts:31-66`):

- `authors.minted_for_manifest_id: text` nullable — the occupant's manifest ULID at mint time. Null means "unknown legacy row".
- `authors.retired_at: text` nullable ISO timestamp.
- The unique index `authors_kind_natural_key_unique` (`:65`) becomes **partial: unique on `(kind, natural_key) WHERE retired_at IS NULL`** — one _active_ author per directory, any number of retired ones. SQLite migration: create the new partial index, drop the old (new numbered migration in `packages/db`).

`AuthorRegistry.resolve` / `resolveAgent` (`author-registry.ts:142-224`) for agent-kind authors:

- Existing active row whose `minted_for_manifest_id` matches the current manifest id at that path → return it (today's behavior).
- Stamp is **null** and a manifest is present → adopt: write the stamp, return the row. Grandfathering — a legacy row never retires on its own.
- Stamp differs from the current manifest id → set `retired_at` on the old row, mint a fresh one stamped with the new id. The old history keeps its author; mentions and dispatch exclude retired rows exactly as M2 excludes ghosts (a retired row's directory now resolves to an agent that is not its own, so M2's live-agent check must consult the stamp too: live means `byPath` resolves **and** the stamp, when set, matches).
- Human-kind authors are untouched — no manifest exists to stamp.

`bindOwner` (`author-registry.ts:297-317`) and every `authors.id` consumer are unaffected: ids never change, rows never delete.

## 4. Explicitly out of scope

- Machine-local id minting (rejected — `01-ideation.md`).
- Stored `authors.handle` (specs/handles Phase 2).
- Carrying an author row across a directory move (ADR `260726-170126` future work).
- Any change to relay subjects, `tasks.agent_id`, `a2a.agent_id`, or `agent_identity_tokens`.

## 5. Tests that must exist (each proven to fail without its mechanism)

1. Upsert with same id from a second path while the first path's manifest is intact → row unmoved, one damped warn, second call same scan logs nothing.
2. Upsert with same id after the incumbent manifest is deleted → row relocates, info logged.
3. Different id at same path still replaces the incumbent (pins `:92-96`).
4. Scanner: identical fixture tree yields identical candidate order across runs (sorted readdir).
5. A roster with a ghost author and a live agent sharing a display name → the live agent gets the `@handle`; the ghost gets no turn and the refusal is visible.
6. Directory reuse: register agent B where agent A lived → A's entries keep A's author id; B's first post mints a new author; the old row has `retired_at` set; only B is mention-addressable.
7. Legacy row (null stamp) resolves without retiring and gains the stamp.
8. Migration: existing rows survive, partial index enforces single active author per directory while permitting a retired sibling.

## 6. Delivery

One worktree, one PR (`Refs DOR-790`), sequenced after the Lane A rooms branch lands (shares `mentions.ts`/rooms test surfaces). Extract the ADR amending `260726-170126` via `/adr:from-spec` at PR time. Changelog fragment: user-facing sentence about agents no longer losing their identity to a copied checkout.
