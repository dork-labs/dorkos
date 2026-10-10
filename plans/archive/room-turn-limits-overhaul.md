# Room turn limits overhaul

**Date:** 2026-08-22 · **Status:** proposed · **Owner:** Dorian

## What changes, in one breath

Agents in a room get dramatically more automatic back-and-forth: the ancestry
rule ("one turn per agent per conversation, ever") becomes a counter, every
default is raised for new AND existing installs, the numbers become editable in
Settings, and any room can override them.

## Decisions already made (Dorian, 2026-08-22)

1. **Ancestry becomes a counter.** Each agent may run N automatic turns per
   cascade (per human message), instead of exactly one. The loop-killer stays a
   mechanism — it just fires at N instead of 1 (amends ADR 260726-170127, keeps
   its spirit: a bound in code, never a prompt).
2. **Shipped defaults change for everyone**, new and existing users. This is a
   deliberate reversal of the conservative posture for these four fields and
   needs its own ADR + `PERMISSIVE_DEFAULTS` entries (ADR 260727-181825 requires
   the argument to be written down).
3. **The numbers:**

   | Setting                                  | Old default        | New default | Old max | New max |
   | ---------------------------------------- | ------------------ | ----------- | ------- | ------- |
   | `rooms.maxAgentDepth`                    | 3                  | **30**      | 10      | 100     |
   | `rooms.maxTurnsPerAgentPerCascade` (NEW) | — (behavior was 1) | **10**      | —       | 100     |
   | `rooms.maxAutomaticTurnsPerRoomPerHour`  | 60                 | **1000**    | 10 000  | 10 000  |
   | `rooms.maxAutomaticTurnsTotalPerHour`    | 240                | **5000**    | 100 000 | 100 000 |

   Worst-case runaway on a fresh install is now ~5000 model turns/hour. The
   hourly caps become the real safety net; the ADR must say this plainly.

4. **An explicit "unlimited" switch** (Dorian, same day): a person can turn the
   limits off entirely — globally in Settings, and per room. Off means the
   cascade guard and the turn budget allow every trigger; the halt button and
   per-agent Stop become the only brakes. This is a distinct state, not a big
   number: `rooms.turnLimitsEnabled: boolean, default true` in config, and a
   nullable `turn_limits_enabled` on the room row (NULL = inherit, `true` =
   limited even if the install is not, `false` = unlimited even if the install
   is). Modeled as its own flag rather than a `0`/sentinel on each number so
   the numbers keep their meanings and toggling off-then-on restores exactly
   what was set. Ships default ON — the toggle is permissive only when moved.

## How the pieces work today (for the implementer)

- `cascade-guard.ts` — pure. Depth rule (`depth > maxAgentDepth`) + ancestry
  rule (`authorsInCascade.includes(target)` → refuse). Provenance comes from
  `room-trigger.ts` via `SELECT DISTINCT author_id … WHERE cascade_root = ?`.
- `turn-budget.ts` — `RoomTurnBudget` with `TurnBudgetLimits { perRoom(),
global() }`, read live per call; durable via `room_turn_spend`.
- Config: `packages/shared/src/config-schema.ts` (~line 1441), defaults are
  **persisted to disk** by `conf` — an existing install's file literally holds
  `"maxAgentDepth": 3`, so a schema-default change alone reaches nobody who
  already ran the app. Migration required.
- Write policy: all spend caps are `operator-only`
  (`services/core/operator/config-write-policy.ts:304-310`). Agents must stay
  unable to raise their own allowance — this posture is unchanged.
- No Settings UI exists for any `rooms.*` field today.
- `rooms` table has no per-room limit columns.

## Phase 1 — the new bounds model (shared + server)

1. **Schema** (`config-schema.ts`): raise defaults/maxes per table above; add
   `maxTurnsPerAgentPerCascade` (int, min 1, max 100, default 10) and
   `turnLimitsEnabled` (boolean, default true) with plain-language TSDoc in the
   same voice as their neighbors. When `turnLimitsEnabled` is false, the
   trigger path short-circuits BOTH checks to allowed — one branch in
   `room-trigger.ts` before `evaluateCascade`/`tryReserve`, never inside the
   pure guard functions (they stay limit-agnostic and fully tested).
   `remaining()` reports unlimited honestly (e.g. `null` headroom) so
   `room_context.budget` does not print a fake number to agents.
2. **Migration** (new semver key in `config-manager.ts`, strictly greater than
   newest `v*` tag — append-only guards will enforce): for each of the three
   existing fields, bump the stored value **only if it equals the old default**
   (3→30, 60→1000, 240→5000). A value someone set deliberately travels whole
   (safe-defaults rule 3). The new field needs no migration — Zod fills it.
3. **Safe-defaults bookkeeping**: classify BOTH new leaves
   (`maxTurnsPerAgentPerCascade`, `turnLimitsEnabled`) in
   `default-verdicts.ts`, `config-disclosure.ts`, `config-write-policy.ts`
   (operator-only, same reasoning as their siblings); add argued
   `PERMISSIVE_DEFAULTS` entries for the raised caps. `turnLimitsEnabled`
   default-true is the protective side, so no carryover rule is needed for it;
   but a person who turned it back ON after experimenting must survive a config
   wipe — add the `PROTECTIVE_CARRYOVERS` rule.
4. **Cascade guard**: `CascadeProvenance.authorsInCascade` becomes
   `turnsByAuthor: ReadonlyMap<string, number>` (from `SELECT author_id,
COUNT(*) … GROUP BY author_id` on the same indexed cascade-root query).
   `evaluateCascade` gains `opts.maxTurnsPerAgentPerCascade`; refusal reason
   `'ancestry'` renames to `'repeat'` (fires when the target's count ≥ N).
   Depth rule unchanged. The un-provenanced-agent-post rule (stamp at the
   depth ceiling) is untouched and still refuses by depth.
5. **Guard re-ask on held batches stays** (room-conduct: it is what terminates
   ping-pong now that claims hold instead of refuse). With a counter it matters
   MORE — the count moves while a batch waits.
6. **ADR ×2**: (a) counter amendment to 260726-170127; (b) the defaults
   reversal, arguing the bill exposure explicitly.

## Phase 2 — per-room overrides

1. **DB** (`@dorkos/db`): four nullable columns on `rooms` —
   `turn_limits_enabled`, `max_agent_depth`, `max_turns_per_agent_per_cascade`,
   `max_auto_turns_per_hour`. NULL = inherit. The global total cap has no
   per-room meaning and gets no column. One asymmetry to state in the ladder's
   TSDoc: the GLOBAL hourly cap still applies to an unlimited ROOM unless the
   install-wide toggle is also off — a room can opt out of its own bounds, not
   out of the install's wallet.
2. **Resolution ladder** (one helper, `resolveRoomLimits(room, config)` in
   `services/rooms/`): room override → user config → schema default. Both
   consumers go through it — `room-trigger.ts` for the guard numbers,
   `RoomTurnBudget` via `perRoom(roomId)` (signature change from `perRoom()`;
   the budget already re-reads limits per call, so overrides are live).
   Precedent: the billing-account ladder (DOR-1407) — same shape, keep the
   naming style.
3. **API**: extend the existing room-update route to accept the three fields.
   **Person-only** — resolved caller must be human; an agent (or the room
   capability tools) can never write them. Validation bounds = the same maxes
   as the config schema. Absence in a PATCH means "don't touch"; explicit
   `null` means "clear override".
4. **Refusal notices unchanged** in copy; `room_context.budget` already reports
   remaining and picks up overrides for free through the ladder.

## Phase 3 — Settings UI + room UI (client)

1. **Settings → new "Rooms" section** in the settings panel
   (`features/settings`): a master **"Limit automatic replies"** toggle at the
   top; the four numbers beneath it, disabled (with values kept) while the
   toggle is off. Labels in `writing-for-humans` voice (e.g. "How many replies
   in a row agents may trade before the room pauses them"), defaults shown,
   Zod bounds enforced client-side, saved through the existing config PATCH
   path. Turning the toggle OFF gets a one-line consequence sentence ("agents
   can reply to each other without limit — the Stop button is the only brake"),
   no scare modal.
2. **Room settings → "Limits" section** (`features/room-management`): a
   three-state room toggle (Use default / Limited / Unlimited) plus the three
   numeric overrides, each "Use default (N)" or a custom value; clearing
   returns to inherit. Visible to the operator only, matching the API rule.
3. Both surfaces: check the dev playground candidacy rule after building.

## Phase 4 — verification

- Unit: counter semantics in `cascade-guard` (N-1 allowed, Nth refused, human
  reset, un-provenanced stamp); ladder resolution incl. explicit-null clears;
  `perRoom(roomId)` budget.
- Migration: **real `ConfigManager` over a real file** (safe-defaults rule) —
  stock values bump, a hand-set `3` survives, Ajv-invalid file recovers.
- Integration: re-run/extend `rooms-cascade.test.ts` scripts with the new
  numbers; two-agent ping-pong terminates at the counter, not at one hop.
- The append-only migration guards and safe-defaults drift guards go green.
- Changelog fragment (user-facing: "agents can hold longer conversations, and
  you can tune or cap them per room").

## Sequencing / PRs

Worktree per repo rules. Three PRs, stackable:

1. Phase 1 (schema + migration + guard + ADRs) — behavior change ships here.
2. Phase 2 (DB + ladder + API).
3. Phase 3 (both UIs) + phase-4 leftovers.

## Risks, stated honestly

- **Bill exposure is the design.** 5000 auto-turns/hour default is real money
  on a misconfigured install; the reversal ADR owns this.
- **Unlimited mode has no automatic brake at all.** Two `always` agents in an
  unlimited room run until a person presses Stop. The toggle is operator-only
  and default-on, the room header's halt button already exists, and the
  consequence sentence in Settings is the disclosure — but the ADR should name
  this state explicitly as accepted.
- The migration cannot tell "left at 3 on purpose" from "never touched" — both
  read as the stock value. We bump both; the Settings UI is the remedy.
- `cascade_depth` stamped at the OLD ceiling (3) on historical un-provenanced
  agent posts stays refusable under the new ceiling (3 < 30 ⇒ now RE-triggerable
  one more hop). Harmless — those cascades are cold — but the guard tests
  should pin the new reading.
