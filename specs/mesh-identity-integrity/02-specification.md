# Mesh identity integrity — specification

Three mechanisms, one migration. All file:line citations are against `main` at `2838947fc`. `01-ideation.md` holds the decision and the rejected alternative; where they differ, this document wins. Revision 2, after adversarial review: the guard's ordering, its errno discipline, the ghost seam, and the M3 decision table were all corrected — the review's findings are folded in below rather than appended.

## 1. M1 — the relocation guard

**Invariant: a registration that would move an agent's row to a new path succeeds only if the old path has actually given the manifest up — and a refused registration mutates nothing at all.**

### Division of labor

`AgentRegistry` stays a pure, synchronous DB adapter (it imports only drizzle + schemas, `agent-registry.ts:10-15`, and its tests call it synchronously). It gains no filesystem I/O. Instead its `upsert` contract changes:

- **Id conflict with a different `projectPath` → no write.** `upsert` returns a `'duplicate-id'` result (a value, not an exception) instead of running the `onConflictDoUpdate` that today rewrites `projectPath` (`:122-144`, the rewrite at `:128`).
- **The refusal is evaluated before any mutation.** Today `upsert` first deletes a different-id row at the incoming path (`:92-96` → hard `DELETE` at `:245-248`) and only then handles the id conflict. That ordering plus a refusal would destroy data: `/w` registered as agent X, `/w` checks out a branch carrying agent D's committed manifest, scan yields D at `/w` → X deleted, D refused, `/w` agent-less and X gone. So: resolve the id-conflict outcome **first**; the path-incumbent delete fires only when the registration actually proceeds. A refused upsert leaves both rows untouched.
- **Relocation is an explicit verb, and it owns the path incumbent.** A new `relocate(id, newPath)` (or an explicit force parameter — implementer's choice, but it must be impossible to relocate by accident) performs the move. Only the discovery layer calls it, after the manifest check below. Because `agents.project_path` is `NOT NULL UNIQUE` (`packages/db/src/schema/mesh.ts:9`), `relocate` must handle a different-id row already sitting at `newPath`: it deletes that incumbent and moves the row **in one transaction** — the same replace-the-path-incumbent semantics `upsert` applies when a registration proceeds. This is reachable, not theoretical: `/w` registered as X, D's manifest appears at `/w`, D's old home has lost its manifest → true relocation of D into X's path. Without this, the B1 fix would trade a silent delete for a UNIQUE-constraint throw inside the discovery generator.

The manifest check lives in `MeshDiscovery.upsertAutoImported` (`mesh-discovery.ts:236-258`), which is already async and already does I/O. On `'duplicate-id'` it reads `<existing.projectPath>/.dork/agent.json` with **errno discipline**:

- `ENOENT` / `ENOTDIR` → the manifest is gone: true relocation, call `relocate`, log one structured `info` (`mesh.identity.relocated`).
- Readable with a **different id** → the incumbent gave the id up: true relocation, same as above.
- Readable with the **same id** → duplicate: refuse, no mutation.
- **Any other failure (`EACCES`, `EIO`, `EMFILE`, parse error, …) → refuse, no mutation.** `readManifest` (`packages/shared/src/manifest.ts:40-45`) currently collapses every error to `null`; the check must not use that path as-is, because treating a transient read failure as "gone" would hand the identity to a duplicate permanently — and the guard itself would then refuse the true owner's return, an irreversible transfer with no reclaim. Under this discipline the wrong-way transfer cannot arise from a transient error; the remaining manual case (operator deletes a manifest, a duplicate registers, the manifest is restored from git) is recoverable by removing the duplicate manifest or row and rescanning, and the warning names both paths.

**Refusal visibility:** a scan aggregates its refusals and logs **one** structured `warn` per id per scan run (`mesh.identity.duplicate_manifest`) naming the registered path and every rejected path. (A per-`(id, path)` damp would still print nine lines on the first scan of this repo's nine worktrees, and a per-process damp would never re-warn after the situation changes; per-scan aggregation does what the damping is actually for.)

**Truthful propagation:** `syncFromDisk` (`packages/mesh/src/mesh-agent-management.ts:323-331`) also feeds committed ids into `upsertAutoImported` and is documented to return "true if the manifest was found and synced". On refusal it must return a falsy/explicit result — its five call sites (`routes/agents.ts:151`, `agent-creator.ts:435`, `agent-updater.ts:151`, `ensure-dorkbot.ts:95`, `:137`) keep their behavior, but the contract stops lying. `register`/`registerByPath` mint fresh ULIDs (`mesh-discovery.ts:92`, `:137`) and cannot hit the conflict branch.

**Duplicates never become candidates:** a directory containing a `.dork/agent.json` **file** is never emitted as a _strategy_ candidate, whatever its registration state. The gate is a file-existence check, deliberately not `readManifest` — the scanner's `readManifest` call (`unified-scanner.ts:137`) collapses "absent" and "invalid" to the same `null`, the exact collapse the errno discipline above rejects, and the two cases must diverge here too. Today `isRegistered` (`unified-scanner.ts:160`) gates candidates, so a refused duplicate would surface on every scan as a "new agent" whose Register button calls `register()` — which mints a fresh ULID and **overwrites the git-tracked manifest** (`mesh-discovery.ts:187`), dirtying a tracked file that would change the primary agent's id if merged. A manifest-bearing directory already has an identity: imported, refused, or invalid — never a candidate. A **corrupt** manifest is surfaced by passing the scan's logger into the existing `readManifest` call (`unified-scanner.ts:137` passes none today, so its path-and-parse-failure logging falls to the console) — no new `ScanEvent` variant; a scan-stream error surface is future work, and the log line is what makes the recovery real. The operator's recovery is to fix or delete the file — deliberately replacing today's only affordance, a Register click that would paper over the corruption by overwriting a tracked file with a fresh id. Someone who wants a clone to be its own agent re-inits its identity deliberately (removes/regenerates the manifest), not via a scan surface.

**Scan determinism:** `unified-scanner.ts` sorts each directory's entries before enqueueing (`:191-199`; `fs.readdir` order is filesystem-dependent). Sorting makes a single traversal reproducible; what makes identity stable across scans is M1 itself — the first registrant is sticky regardless of traversal order.

**Path aliasing, verified during review:** a symlink or case alias of the registered directory reads the incumbent manifest _through_ the alias, sees the same id, and is refused — the safe direction. A case-rename (`/repo` → `/Repo`) on APFS therefore never relocates; the row keeps the old spelling until the manifest is genuinely gone from it. Acceptable.

## 2. M2 — ghost authors release their claims

**Definitions first, because the review showed the boundary matters:**

- A **ghost** is an agent-kind author whose `naturalKey` has **no row at all** in `agents` (`byPath` returns nothing — `apps/server/src/services/rooms/index.ts:45-59`, no status filter). Ghosts are made by the reconciler's 24-hour orphan sweep (`reconciler.ts`, `ORPHAN_GRACE_MS`) or by a true relocation.
- An agent with `status: 'unreachable'` is **not** a ghost: its row exists, `byPath` resolves it, and it keeps its handle mid-conversation. A laptop that closed its lid must not lose its name.

**Invariant: only an author whose directory currently resolves to a live agent — and whose generation stamp, when set, matches it (M3) — may claim a handle or receive a turn.** History rendering is untouched.

- **The seam is `mentionNamesFor` (`author-handles.ts:43-46`), not `claimNames`.** `claimNames` (`mentions.ts:99-108`) takes `{ authorId, names }` with no kind or handle context and cannot implement the rule. `mentionNamesFor` today falls back to `[displayName]` when the handle lookup fails — which is exactly how a ghost claims a name: reviewed by execution, a ghost author ahead of a live same-named agent in roster order claims the name and the live agent is starved. The fix: for agent-kind authors that fail the liveness check, `mentionNamesFor` returns **no names**. `advertisedHandles` (`author-handles.ts:89-97`) gets the same exclusion — revision 1 claimed it already excluded ghosts; execution disproved that, and the review's scenario becomes the regression test.
- **The liveness check needs the occupant's id at this seam, so `RoomAgent` carries it.** `mentionNamesFor` is a pure function over an `AuthorRecord` and a `RoomAgentLookup`, and the roster path reaches it via `getMany` (`author-registry.ts:373`) — **not** `resolve` — so no retirement decision has run when mentions are computed. "Active row implies matching stamp" is therefore false at this seam: agent B registered at A's old directory but not yet posted leaves A's row active with A's stamp while `byPath` returns B, and without the stamp comparison A's author would claim B's `@handle` — H12 surviving in the mention path. So `RoomAgent` (`room-errors.ts:57-68`) gains the occupant's manifest `id`, and the check is: **live ⇔ `byPath` resolves AND (author's stamp is null OR stamp equals the occupant's id)**. The docstrings that forbid a ULID here (`room-errors.ts`, `author-registry.ts:201-204`) are rewritten, not deleted: callers still cannot _supply_ an id and identity still keys on the directory — the id rides along for the generation comparison only, the same distinction M3 draws.

  > **Revision note (implementation, PR pending).** The seam named in the two bullets above MOVED. `mentionNamesFor` was collapsed into `rosterMentionCandidates` (`author-handles.ts`), which returns the roster split into `live` and `unreachable` from one walk; releasing a ghost's names there turned out to make `@ana are you there?` resolve to nobody, trigger nobody and write nothing, so `resolveAddressing` (`mentions.ts`) answers "who did this reach" and "who did it name and miss" in one pass over the text, and the dispatcher writes the `agent_gone` notice for the miss. The liveness rule itself (`isLiveAuthor`) is unchanged and is exactly what these bullets specify.

- **Dispatch refuses ghosts visibly.** The trigger path refuses to dispatch a turn to a member whose author fails the liveness check, through the existing `reportSilence` `(room, agent, reason)` damping seam (`room-trigger.ts:587-602`). Implementation verifies whether the failure already surfaces as `turn_failed`; if this is a new way to go quiet, it earns a new notice code — which lives in the shared Zod enum (`packages/shared/src/room-schemas.ts:74`), with the client rendering map updated to match (the enum's blast radius is client + persisted entries, not just `room-notices.ts`).
- **Rosters keep listing ghosts** with the existing degraded rendering — membership is a fact about the room; the fix is about claims and dispatch, not display.

## 3. M3 — a reused directory starts a new author

**Invariant: an author row belongs to the occupant it was minted for. A different occupant in the same directory gets a fresh row; the old row keeps the old history and retires from active duty.**

### Schema (`packages/db/src/schema/rooms.ts:31-66`)

- `authors.minted_for_manifest_id: text` nullable — the occupant's manifest ULID at mint time. Null means "unknown legacy row".
- `authors.retired_at: text` nullable ISO timestamp.
- The unique index `authors_kind_natural_key_unique` (`:65`) becomes **partial: unique on `(kind, natural_key) WHERE retired_at IS NULL`** — one _active_ author per directory, any number of retired ones. Partial unique indexes are already proven in this schema (`rooms.ts:113` → `drizzle/0034_motionless_nightcrawler.sql:59`). The migration is **generated** via `drizzle-kit generate` (never hand-written — `scripts/assert-migrations-current.sh` gates schema/migration sync) as the next free number at implementation time.
- **Every `(kind, naturalKey)` lookup gains `retired_at IS NULL`** — the resolve lookup (`author-registry.ts:143-147`) and the post-insert re-read (`:186-190`) — or `.get()` becomes nondeterministic across retired siblings.

### Where the ULID comes from

`resolveAgent`'s signature deliberately has no ULID parameter (`author-registry.ts:201-204`) so no _caller_ can key identity on one. That intent is preserved: `AuthorRegistry` **derives** the current occupant's id itself, querying the `agents` table by `projectPath` with the `db` handle it already owns. The ULID is derived, never accepted; the directory stays the identity key; the docstring is rewritten to say so.

### The decision table (complete — revision 1 had no row for the ghost state)

| Active row state                 | Live agent at path | Action                                                                                                                                                                                                                    |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stamp matches occupant's id      | yes                | return the row (today's behavior)                                                                                                                                                                                         |
| stamp null                       | yes                | **adopt**: write the stamp, return the row (grandfathering — a legacy row never retires on its own)                                                                                                                       |
| stamp differs from occupant's id | yes                | **retire + mint**: set `retired_at`, insert a fresh stamped row                                                                                                                                                           |
| any stamp state                  | **no**             | return the row unchanged — this is the ghost state; M2 excludes it from claims and dispatch, and no retirement or mint decision is made without a live occupant (otherwise every ghost would churn a new row per resolve) |

**Retire + mint is one transaction.** `resolve` has no explicit transaction today; under the partial unique index, a crash between `set retired_at` and the fresh insert would leave a directory with no active author. Wrap the pair (better-sqlite3 transactions are synchronous and cheap); note that even unwrapped the state self-heals — the next resolve finds no active row and mints — but the transaction makes the window not exist.

Human-kind authors are untouched — no manifest exists to stamp. `bindOwner` (`author-registry.ts:297-317`) and every `authors.id` consumer keep working: ids never change, rows never delete.

### What retirement does NOT carry — and why that is loud, not silent

`room_members` and `room_sessions` are keyed `(roomId, authorId)` (`rooms.ts:141-155`, `:346-354`), and `responseMode` is a per-membership column. A retired author keeps its memberships; **the fresh author is deliberately a member of nothing**. Room membership is an access fact: a new agent occupying a reused directory must not inherit rooms the previous occupant was invited to. The consequence — re-initializing a manifest in place drops that agent out of every room, and it must be re-invited — is accepted and stated in ADR `260801-003051`; retirement logs a structured `warn` naming both author ids and the memberships left behind, so the drop is visible the moment it happens. A deliberate re-init affordance that carries the author row (the same shape as ADR `260726-170126`'s deferred rename affordance) is future work. The retired `room_sessions` binding is orphaned but neither leaks to nor blocks the new author (review-verified against the PK).

### Relationship to ADR 260726-170126

M3 stores the manifest ULID on the author row and lets it decide occupancy generations. That **partially supersedes** ADR `260726-170126`'s clause "the ULID is never written into an author column" — it is not a mere amendment, and ADR `260801-003051` says so plainly. The original clause guarded against ULID churn: a reconciler rebuild re-registering agents under fresh ids. That premise is unreachable in current code — no reconciler path mints: every `ulid()` call site is registration or author mint (`ensure-dorkbot.ts:103`, `mesh-discovery.ts:92`, `:137`, `author-registry.ts:174`, room creation), `reconciler.ts` only calls `registry.update(entry.id, …)`, and an ADR-0043 DB rebuild reads ids back from the files that store them. The one event that changes a manifest id — re-initializing the manifest — is precisely the generation boundary M3 exists to detect. The directory remains the identity key; the stamp decides which occupancy generation a row belongs to.

## 4. Explicitly out of scope

- Machine-local id minting (rejected — `01-ideation.md`).
- Stored `authors.handle` (specs/handles Phase 2).
- Carrying an author row (and its memberships) across a directory move or deliberate re-init (ADR `260726-170126` future work, extended by M3's retirement note above).
- Any change to relay subjects, `tasks.agent_id`, `a2a.agent_id`, or `agent_identity_tokens`.

## 5. Tests that must exist (each proven to fail without its mechanism)

1. Upsert with same id from a second path while the first path's manifest is intact → both rows untouched, `'duplicate-id'` returned; the scan logs one aggregated warn naming all rejected paths.
2. **The B1 scenario:** a path registered as agent X receives a manifest carrying agent D's already-registered id → D refused **and X's row survives** (the path-incumbent delete must not fire on a refused registration).
3. Incumbent manifest read fails with `EACCES` (existing file, permissions dropped) → refuse, no mutation. Incumbent manifest `ENOENT` → relocation proceeds, info logged. Incumbent readable with a different id → relocation proceeds.
4. `relocate` is the only write path that moves a row's `projectPath` on id conflict; plain `upsert` never does. (Different id at same path replacing the incumbent when registration proceeds is already pinned — `agent-registry.test.ts:225-230`.) `relocate` into a path occupied by a different-id row deletes that incumbent and moves the row atomically — no UNIQUE-constraint throw. 11. **The stale-stamp scenario:** agent B registered at agent A's old directory, B has never posted (A's row still active with A's stamp, roster fetched via `getMany` with no resolve) → A's author claims no names, advertises nothing, receives no turn; once B posts, B's fresh author is the only addressable one.
5. Scanner: identical fixture tree yields identical candidate order across runs (sorted readdir); a directory containing `.dork/agent.json` is never a strategy candidate, registered or refused.
6. `syncFromDisk` on a refused duplicate returns a falsy/explicit-refusal result, not `true`.
7. **The review's executed scenario as regression:** roster with a ghost author and a live agent sharing a display name, ghost first in roster order → the live agent claims the `@handle` and the mention name; the ghost claims nothing, is not advertised, and receives no turn, with the refusal visible. An `unreachable` (but present) agent keeps its handle.
8. Directory reuse: register agent B where agent A lived → A's entries keep A's author id; B's first post mints a new stamped author; the old row has `retired_at` set; only B is mention-addressable; B is a member of no rooms and the retirement warn names the memberships left behind.
9. Legacy row (null stamp) with a live occupant resolves without retiring and gains the stamp; a ghost row (no live agent) resolves unchanged with no new row minted, whatever its stamp.
10. Migration: existing rows survive; the partial index enforces one active author per directory while permitting a retired sibling; the resolve and re-read lookups return only the active row when a retired sibling exists.

## 6. Delivery

One worktree, one PR (`Refs DOR-790`), sequenced after the in-flight rooms branch lands (shares `mentions.ts`/rooms test surfaces). ADRs `260801-003050`/`260801-003051` ride the spec PR as `proposed` and progress via `/adr:review` once implemented; ADR `260726-170126` carries an amendment note pointing at its partial supersession. That supersession is prose-only by intent: the `superseded-by` frontmatter field means _full_ supersession and most of that ADR stands, so setting it would mislead `/adr:list` worse than leaving it null does — the Status-section note is the record. Changelog fragment: user-facing sentence about agents no longer losing their identity to a copied checkout.
