# Heartbeats — specification

**Linear:** DOR-2788. **Ideation:** [`01-ideation.md`](01-ideation.md). **ADR:** [`261010-092116`](../../decisions/261010-092116-heartbeats-skill-content-platform-beat-runner.md). **Canon:** [`meta/PROACTIVE-AGENTS.md`](../../meta/PROACTIVE-AGENTS.md).

References: "§n" is a section of this spec; "canon §n" and "P1–P8" are PROACTIVE-AGENTS'.

Six build PRs, each titled with DOR-2788, in the order of §10. Every PR ships something a person can use on its own.

## 1. The shape in one picture

```
 wake (§3) ──► gather (§5) ──► triage (§6) ──► turn (§7) ──► end_beat (§8) ──► manners (§9) ──► record (§11)
 timer/event    code only      decision         the agent's    structured        hours, batch,     one audit row
                               ladder           runtime        tool call         raise once        every beat
```

- **The content is a skill.** `HEARTBEAT.md` holds what to watch, how to judge, what this agent never does unasked, and the report shape (§2).
- **The beating is a platform service,** `apps/server/src/services/heartbeats/`, plus the server's first decision-model wiring in `apps/server/src/services/decisions/` (the one server directory `scripts/__tests__/decision-narrow-only.test.ts` lets import `@dorkos/decisions`). Both are new service domains: `AGENTS.md`'s census line and `scripts/__tests__/agents-service-census.test.ts` change with them.
- **Most beats end before any model runs,** and most of the rest end at triage. A turn on the agent's runtime is the exception.

## 2. `HEARTBEAT.md`

A fourth convention file beside `SOUL.md`, `NOPE.md` and `MEMORY.md`: `<agent>/.dork/HEARTBEAT.md`. It is **skill-shaped** (YAML frontmatter plus a markdown body, parsed with `@dorkos/skills`' frontmatter parser), so templates ship it, people and agents edit it like a skill, and the marketplace's agent packages carry it as a file. It is not a schedule: no cron, and it never enters the Tasks approval flow (canon §5.7, "Approval").

```markdown
---
name: heartbeat
description: What Juno watches between conversations.
wake: timed # timed | events | off. Absent: events.
watch: [addressed, commitments, schedules, health, workspace] # gatherers (§5). Absent: all but workspace.
report: daily # daily | weekly | off. Absent: daily.
sweep: 4h # optional: a full look-around turn at most this often, in working hours.
---

- Invoices: anything unpaid past 14 days gets the second reminder.
- Never touch pricing; ask Dorian.
- Report shape: finished, in progress, at risk, needed. One line each.
```

- `CONVENTION_FILES` gains `heartbeat: 'HEARTBEAT.md'` and `HEARTBEAT_MAX_CHARS` = 8,000. `UpdateAgentConventionsSchema` gains `heartbeatContent` (max `HEARTBEAT_MAX_CHARS`), following `soulContent` / `nopeContent`. No `conventions.heartbeat` toggle: `wake: off` is the one off switch, and the file is never injected anywhere a toggle would gate.
- **It is not injected into ordinary turns.** Only a beat's prompt carries it (§7.3), so a person's chat with the agent costs no more than today.
- **Frontmatter is validated, the body is free.** `HeartbeatFrontmatterSchema` in `packages/shared/src/heartbeat-schemas.ts`. Invalid frontmatter keeps the last valid one in force (its hash is kept in `heartbeat_state`, §11) and is recorded once (`heartbeat.config_invalid`), never silently ignored. Edits take effect at the next beat: the runner checks the file's mtime every beat (OpenClaw #51542 is the bug this avoids).
- **No file means events.** An agent with no `HEARTBEAT.md` wakes on events only and uses the built-in checklist (canon §5.4's seven steps). That is how every existing agent starts after upgrade.
- **Templates per type** (canon §9.1: "types are templates"). `packages/operating-skills` ships three bodies as data: `lead` (`wake: timed`, `report: daily`), `doer` (`wake: timed`, a light beat, `report: daily`), `coder` (`wake: events`, `report: daily`, initiative limited to tech debt, tests, CI, dependencies and security). The template is chosen by the agent's **type**: a marketplace agent package names one (`heartbeatTemplate` in its manifest), and `create_agent` and the new-agent flow take an optional `heartbeatTemplate`. With no type given, the fallback is by runtime: Doe gets `lead`; every other runtime gets **no file** (events, the built-in checklist), because a timed beat on a bring-your-own plan spends that person's plan (canon §5.3). DorkBot gets `lead` with `report: off` until it has work (canon §9.1, "Starter").
- **Changing it is act-then-tell.** An agent editing its own `HEARTBEAT.md` is recorded as `heartbeat.config_changed` with a field diff of the frontmatter; the body's history is the file's.

## 3. Waking

### 3.1 Which agents beat

An agent beats only when all hold: `heartbeats.enabled` is on (§3.6); its `wake` is not `off`; it is not paused (§3.6); and its `manifest.runtime` is a runtime registered in this server's `runtimeRegistry`. Agents the mesh found for other tools (cursor, windsurf, gemini and so on) are skipped, recorded once per server start as `heartbeat.skipped` with the reason, so the launch path's default-runtime fallback (`resolveRuntime`, `launch-session.ts`) can never run a turn nobody chose.

### 3.2 Timed beats

Per agent with `wake: timed`, one `setTimeout` (not croner: the interval changes every beat). The next beat is computed after each beat, first match wins:

| Situation                                                                                        | Next beat                                                 |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Its last 3 beat turns failed (§7.5)                                                              | 2 hours                                                   |
| It asked for a faster pace (`end_beat.pace`, §8) that has not expired                            | its asked interval, 5 to 60 minutes, for at most 12 hours |
| Something it owns is in flight: an open commitment due today, or a turn of its own still running | 10 minutes                                                |
| No beat found any change for 24 hours                                                            | 2 hours                                                   |
| Inside its working hours (§3.5)                                                                  | 30 minutes                                                |
| Outside them                                                                                     | 2 hours                                                   |

Each interval gets ±10% jitter. Timers live in memory; the facts behind them (last beat, pace, wake-again, failures) live in `heartbeat_state` (§11), so on startup each agent's next beat is `max(now + a 1–5 minute stagger, lastBeatAt + interval)`: a restart neither skips a beat for long nor fires a burst. A beat interrupted by a restart is recorded `failed` at startup from its open `heartbeat_beats` row and does not retry; the next beat sees the same changes.

### 3.3 Event wakes

Any beating agent wakes on events, whatever its rhythm. Each source is hooked where the fact already exists (most of these write no audit row today, so `auditLog.observe` alone would see nothing):

| Event                                                                                                                                                           | Hooked at                                                                     | Wakes      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------- |
| A room message from a **local** author (a person on this server or one of its agents) names the agent, and the room turn did not run (paused, refused, a limit) | the room turn runner's refusal path                                           | that agent |
| One of its commitments comes due or goes overdue                                                                                                                | a timer per due date, rebuilt from `commitments` at startup (§12)             | that agent |
| A run of a schedule it owns fails or parks for a person                                                                                                         | the task scheduler's run-end hook                                             | that agent |
| A turn of its own fails outside a beat                                                                                                                          | the session lifecycle emitter (`notifications/emitters/session-lifecycle.ts`) | that agent |
| One of its connections loses access                                                                                                                             | connector status changes                                                      | that agent |
| Its reports-to changes                                                                                                                                          | `agent.reports_to_changed` (§4.2)                                             | that agent |

**Strangers never wake a beat.** A message from an outsider (a bridged Telegram or Slack sender, an external room author, a webhook) is excluded from wakes and from every gatherer: the room path runs those under the binding's grant (`externalAuthor` seeds `'none'`, `turn-origin.ts`), and a beat must not re-handle the same words at the operator's level. A spin-off report (`chat-message`, kind `report`) is already a turn by DOR-2790 and is not a second wake.

Wakes are **coalesced**: events for one agent within 60 seconds become one beat; a failure source wakes an agent at most once per source per local day; a wake that lands while a beat is running sets `wake_again` (§11) for when it finishes. A beat never wakes another agent by itself, and another agent's room post wakes this one only when it names this agent (canon §5.2 step 2).

### 3.4 Beat kinds

- **pulse:** a timed or event beat. Gather, triage, maybe a turn.
- **sweep:** when `sweep:` is set and its interval has passed, in working hours, the next pulse skips triage and runs the turn: a full look around (canon §5.4 steps 3–7, "one useful thing"). Off in every shipped template.
- **report:** at the start of the chain person's working day for `daily` (Monday's for `weekly`). Skipped with a quiet record line when the report queue (§9.3) is empty and no beat turn ran since the last report: a report says what the manager has not already seen. Otherwise a turn writes it (§9.3).

### 3.5 Working hours belong to people

`profile` (the person's own section of `UserConfigSchema`) gains:

- `timezone`: IANA zone or `null`. `null` is filled from the browser's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) the first time the person opens the app after upgrade, so a server in a container or on a remote host never decides it; until then the server's zone stands in.
- `workingHours`: `{ days: number[] (0=Sun…6=Sat), start: 'HH:MM', end: 'HH:MM' } | null`; `null` = Mon–Fri 09:00–17:00.
- `away`: `{ until: ISO | null, note?: string } | null`.

All three are `expose` + `agent-writable` like the rest of `profile` (a person tells DorkBot "I'm off till Monday" and it sets `away`). Each is a config change done by the `adding-config-fields` skill: Zod fields with defaults, a `CONFIG_MIGRATIONS` key **strictly greater than the newest `v*` tag** and pinned in `merged-migration-hashes.ts`, `config-disclosure` and `config-write-policy` entries, docs, a test. Hours are computed with `Intl` in the person's zone, so DST shifts the wall-clock window, never the beat.

An agent's working hours are its **chain person's** (§4.1). Hours never limit work: they set the beat rhythm and when a message to a person is delivered (§9). Agent-to-agent work has no quiet hours.

### 3.6 Off, paused, and the space switch

- `wake: off` stops every beat for that agent, event wakes included. Recorded.
- **Paused** (DOR-2738 PR 5): the runner calls a `isPaused(agentId)` seam before every beat and schedules nothing while it is true; the pause row is the record, so skipped beats write nothing more. Until PR 5 merges the seam answers `false`; whichever PR lands second wires `services/mesh/agent-pause.ts` into it. The registry's paused-agent Proxy is the backstop either way, and a beat it refuses is recorded `refused`.
- **`heartbeats.enabled`** (new top-level section `heartbeats`, default `true`, `operator-only`): off stops the runner for every agent and clears every timer, pinned by a test (the "off is really off" bug OpenClaw shipped, #64293). A new section follows `adding-config-fields` for whether a migration body is reachable (the `keepAwake` precedent) and pins its landing on disk.

## 4. Reports-to

### 4.1 The fields and the chain

`AgentManifestSchema` gains, each with `.catch(null)` like its neighbours:

- `reportsTo: string | null`: an account id (spec `audit-trail` §3.2: a mesh ULID for an agent, a person's account id).
- `createdBy: string | null`: the **account** that created the agent, written once by `create_agent`, the new-agent flow, `mesh_register` and agent-created agents, never changed after. It differs from the existing `registeredBy`, which names the **surface** that registered it (`'dorkos-ui'`, `'mcp'`).

`resolveManager(agentId)` in `services/heartbeats/reports-to.ts` answers canon §9.2: `reportsTo` → `createdBy` → (project lead, group lead: DOR-2755, skipped until built) → the owner. A manager that no longer exists is skipped. `resolveChainPerson(agentId)` walks up to the first person. **Every chain ends at a person:** writes that would make a cycle are refused with `REPORTS_TO_CYCLE` at every surface (`update_agent`, the profile picker, the HTTP route), and because a hand-edited `agent.json` can still make one, the walk itself stops at the owner on the first repeated id and records `heartbeat.chain_cycle` once.

`reportsTo` joins `UpdateAgentRequestSchema`'s pick list; `createdBy` does not (machine-written). The SQLite mirror gains `reports_to` and `created_by` columns through the reconciler (ADR-0043). The new `create_agent` call site and any new `TurnOrigin` call site join `turn-origin-call-sites.test.ts`'s census.

### 4.2 Changing it

A change is recorded (`agent.reports_to_changed`, `change: [{field:'reportsTo', before, after}]`). The old and new manager each get a line in their next report from the agent (§9.3), and the agent's next beat carries `newManager: true`, so it opens with how it reports and asks what they would rather see (P4).

### 4.3 In the app

Profile → a "Reports to" row: a picker listing people first, then agents, showing "You (default)" when unset. When creating an agent, it defaults to whoever is creating it. Settings → "Your hours": time zone, days, start, end, and "Away until". PR 1's copy describes the setting, not behaviour it does not have yet ("Your time zone and working hours."); PR 3 adds what agents do with them.

## 5. Gathering, with no model

A gatherer is `(ctx: GatherContext) => Promise<Change[]>`, plain code, bounded to 2 seconds and 50 changes, never throwing (a failure becomes a `health` change). `ctx` carries the agent, its manifest, `since` (the last beat's time) and the services it reads. `Change = { gatherer, key, summary, at, touches?: ('money'|'customers'|'security')[], ref?: { kind, id } }`. `key` is stable for the same underlying fact (`commitment:<id>`, `run:<id>`, `room-entry:<id>`): it drives raise-once and de-duplication (§9.2).

| Gatherer      | Reads                                                                                                                                                | A change is                                                                                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addressed`   | room entries naming the agent and its DMs, **local authors only** (§3.3)                                                                             | a message to it since `since` with no reply from it after. **DM bodies are never copied:** a DM appears as its sender, time and room id, so a space-visible beat chat and record never hold a private conversation; the agent reads it through its room tools if it needs to. |
| `commitments` | `commitments` (§12)                                                                                                                                  | one of its open commitments due within 24 h, or overdue                                                                                                                                                                                                                       |
| `schedules`   | its task runs                                                                                                                                        | a run since `since` that failed or parked                                                                                                                                                                                                                                     |
| `health`      | its own refused or failed audit rows; connection status; its beat turns' failures; its triage and turn usage today                                   | an error, a refused action, a lost connection, today's beat usage past 2 × its 7-day daily average                                                                                                                                                                            |
| `workspace`   | `git` in its cwd, local only (`rev-parse`, `log --since`); never `fetch`. `gh pr checks` for branches it pushed, at most once per 30 minutes, cached | new local commits on the default branch by someone else; a failed check on its own branch                                                                                                                                                                                     |

`HEARTBEAT.md`'s `watch:` picks the set. An agent with no cwd skips `workspace`. **If every gatherer returns nothing, no commitment is due and no sweep or report is due, the beat ends here** with a quiet record line and no model cost. That is most beats.

A new gatherer is one file in `services/heartbeats/gatherers/` and one registry entry; goals (DOR-2755) and responsibilities (DOR-2743) arrive that way.

## 6. Triage

### 6.1 The rules rung (PR 3)

`services/heartbeats/triage-rules.ts`, free and deterministic, answers one of three:

- `quiet`: nothing needs the agent (only successful runs, only changes the agent itself made);
- `work`: the agent should work on it now (a local message to it unanswered, an overdue commitment, a failed or parked run, a lost connection, a failing check on its branch);
- `undecided`: anything else, including any change with non-empty `touches`.

In PR 3, `undecided` means a turn: unsure goes up to the runtime, never down to silence.

### 6.2 The decision-model rung (PR 5)

`services/decisions/heartbeat-triage.ts` exports `triageBeat(changes, context): Promise<TriageOutcome>` in heartbeat words, so `services/heartbeats/` never imports the decision types. Inside, `runLadder` with the policy `heartbeat.triage`:

- Rung 0 is §6.1's rules as a `createRulesModel` bridge; rung 1 the credits bridge (§6.3); rung 2 absent, because the agent's own runtime is the frontier.
- One `choice` question with neutral labels: `a1` nothing needs the agent, `b2` work on it now, `c3` it can wait for the next report. The item is the changes; the context is `HEARTBEAT.md`'s body and the agent's name, never pasted into the rules (port rule 4).
- `serious: []`, `actAbove: 0.8`, `escalateBelow: 0.5`. `whenUnsure` is required by the schema and does nothing here.
- **Mapping:** `act a1` → quiet; `act c3` → the changes join the report queue (§9.3), no turn; `act b2` → a turn. `review` and `unsure` (every reason) also mean **a turn**: in this use case the agent's own runtime is the "person or agent with authority" the ladder escalates to, and the record says so in plain words.
- **Money, customers, security.** A change with `touches` can be dismissed (`a1` or `c3`) only by an answer carrying token probabilities with `a1`'s or `c3`'s at ≥ 0.9. An ask-twice confidence (no logprobs) never dismisses it (canon §5.2 step 3: confident to say nothing).
- Every rung's model id, answers, confidence and usage go in the beat's `heartbeat_beats` row (§11), as research `20261006_decision-models.md` requires.

### 6.3 Who pays for triage

- **The choice is the person's** (ADR `261001-000811`: who pays is "always a choice a person made, or a default they were told about"). `heartbeats.triageOnCredits` is `null` (not chosen) on every server, upgraded or new. On a computer linked to a DorkOS account, the Heartbeat page (§7.6) offers it once, as a card and one notification: "Run cheap checks on DorkOS credits?" with **Use credits** and **Not now**. Only **Use credits** sets `true`; dismissing sets `false`. Dorian approved credits paying for triage on every runtime, Claude Code and Codex included (2026-10-07); this is how a person is told, and nothing spends before they answer.
- **On credits** when `triageOnCredits` is `true`, this computer is linked, credits are not switched off (`DORKOS_CLOUD_CREDITS`), and the held token lists `openaiChat`. Rung 1 is `createOpenAiCompatibleModel` on the token's `openaiChat` endpoint with the catalog model `recommendedOn` `openaiChat` (`credits-models.ts` already picks it) and a 64-token output limit. Two small changes to `packages/decisions` come with it: a `maxTokens` option, and `apiKey` accepting `() => string`, so the bridge reads the current token through `heldCreditsToken()` on each call and survives a re-mint; the token is never stored, logged or written to a record.
- **Otherwise** rung 1 is absent: rules decide what they can, and the rest goes to a turn on the agent's own runtime. When credits drop out mid-day (refused, killed, unlinked), the switch is recorded once (`heartbeat.triage_source_changed`) and the page shows the live state, never the configured one.
- **The cost is shown.** The Heartbeat page says where checks run ("Checks run on DorkOS credits." or "Checks run on {runtime}."), how many ran today and their tokens. A dollar figure appears only when the endpoint reports one; this repo holds no prices. Each beat's row carries its triage and turn usage, the cost-per-beat line canon §6.2 asks for.
- **A fuse,** not a cap (canon decision 4): at most 2,000 rung-1 calls per server per UTC day (`DailyCallCounter`); past it the ladder is unsure and a turn decides.
- `AGENTS.md`'s money table row for DorkOS credits is updated in PR 5 to name triage as a second thing credits can pay for, under the same "a person picked them" rule. ADR `261010-092116` amends `261001-000811` accordingly.
- A follow-up `cloud-contract` issue asks the model catalog for a model recommended for decisions, so triage stops using the general recommendation.

## 7. The turn

### 7.1 Where and how

- **The beat chat:** one per agent per local day in its chain person's zone, titled "Heartbeat · {weekday} {date}". A beat that starts before midnight finishes in its own chat; the next beat opens the new day's. The (agent, date) → chat id mapping is `heartbeat_state.beat_chat_id` / `beat_chat_date` (§11). It is a normal chat a person can open and type in, with a "Heartbeat" origin label. A new chat each day keeps a beat from reloading a long history (canon §7, "Beats run light").
- **Starting it:** `dispatchSessionMessage({ sessionId, origin: { kind: 'heartbeat' }, request, onSettled, unattended: true, countsTowardLaunchCap: true })`. `unattended` keeps an approval card from holding the turn with nobody there (an "Ask" area resolves the way it does for a schedule); `countsTowardLaunchCap` keeps forty agents inside the machine's live-launch cap. A `LAUNCH_CAP_FULL` refusal is recorded `refused` and retried at 1, 2 then 5 minutes, then dropped to the next beat. The agent's own runtime, model and account, as its other chats.
- **A busy agent.** If its beat chat is mid-turn (a person typing in it, or the last beat still working), the beat does not queue a second turn; it sets `wake_again`.

### 7.2 The `heartbeat` origin and the live beat-turn registry

- `TurnOrigin` gains `{ kind: 'heartbeat' }`. `permissionSeedForOrigin` → `'configured-stop-on-insert'` (the operator's configured stop on a chat nobody started, as a room turn gets: trusted by default). `sessionVisibilityForOrigin` (audit PR 4) → `space`, which §5's "no DM bodies" rule makes safe. Whichever of this PR and audit PR 4 lands second adds that case; the `never` makes forgetting a build failure.
- **The origin seeds the session row once; it says nothing about a later turn.** So `services/heartbeats/beat-turns.ts` keeps a live registry keyed by session id and turn, on the pattern of `chat-messages/chat-started-turns.ts`: registered just before dispatch, cleared in `onSettled`. `end_beat`'s check (§8), notification suppression (§7.4) and the `bypass` count (§8) read it, so a person typing in the beat chat is an ordinary turn, not a beat.

### 7.3 The prompt

Canon §7.2 filled in by `buildBeatPrompt()`: the gathered changes, open commitments, the open raises it is waiting on (§9.2), `HEARTBEAT.md`, the beat kind, and `newManager` when set. With no `HEARTBEAT.md`, the built-in checklist is canon §5.4's seven steps. The prompt states P6's definition of urgent and ends with the instruction to finish with `end_beat`.

### 7.4 Notifications

`turn.completed` and `session.error` do not fire for a turn in the beat-turn registry: a beat finishing is not news, and its errors feed `health` and the record. `account.limited` still fires: an account hitting its limit is news whichever turn found it. Only what the agent raises reaches a person.

### 7.5 Failure storms

A beat turn that fails increments `heartbeat_state.consecutive_failures`. At 3, the agent drops to a 2-hour rhythm (§3.2), failure-derived changes stop triggering turns, and the runner itself raises once to the chain person through the outbox: "{agent}'s beats are failing: {error}." (`urgent: false`, key `beat-failing:<agent>`). The first successful beat turn resets it. A run of one schedule failing every hour wakes the agent once a day (§3.3), not once an hour.

### 7.6 The Heartbeat section of the profile

PR 3 adds a "Heartbeat" page to the agent's profile: how it wakes (with the next beat), its `HEARTBEAT.md` in the convention editor, and its last beats from the record. PR 5 adds where checks run and the credits offer; PR 6 adds the measures.

## 8. `end_beat`

A capability in a new `heartbeat` domain, tier `act`, `in-session` only, in **no permission area**: it can be neither blocked nor set to ask, the same carve-out the emergency levers use, verified against `permission-enforcement.ts` with a test (a beat that cannot end would read as `no-end-beat` and corrupt the measures). **The caller must be a turn in the beat-turn registry;** anywhere else it refuses (`NOT_A_BEAT`). It is the only way a beat's words reach a person: free text in the beat chat goes nowhere (canon §7, "A beat ends with a tool call, not a magic word").

```ts
end_beat({
  summary: string,               // ≤ 200 chars: the record line ("Sent Acme's second reminder.")
  raises?: Array<{
    text: string,                // markdown, ≤ 2,000 chars, written for a busy reader
    to?: string,                 // an account id; absent = its manager (§4.1)
    rung: 'report' | 'room' | 'dm' | 'note',   // P5 rungs 2–5; rung 1 (the record) is the summary
    roomId?: string,             // required for 'room'
    urgent?: boolean,            // a person must act now (P6); default false
    about?: string[],            // the gathered Change keys this raise is about (§5)
    key?: string,                // stable id; absent = about's keys sorted, else a hash of text
  }>,                            // at most 10
  resolved?: string[],           // keys of earlier raises that are settled
  report?: string | null,        // report beats only: the report, or null to skip
  pace?: { everyMinutes: number, untilIso: string, why: string },   // 5–60 min, ≤ 12 h
})
```

- Calling it ends the beat's bookkeeping; the turn may finish its sentence. A second call in the same turn refuses (`ALREADY_ENDED`).
- **A turn that ends without `end_beat`** is recorded `no-end-beat`, treated as quiet, and counted. Nothing is delivered.
- Talking to another agent stays `chat_send` (no hours between agents). A raise whose `to` is an agent becomes a `report`-kind chat message to it at once.
- An agent may still post to a room or call `relay_notify_user` directly during a beat; trusted by default blocks neither. The prompt asks it to raise through `end_beat` so the manners apply, and direct posts from a registered beat turn are counted as `bypass`.

## 9. Manners: how a raise reaches a person

`services/heartbeats/outbox.ts`, table `heartbeat_outbox` (§11).

### 9.1 Rungs

| Rung     | To a person                                                                                                  | Lands in |
| -------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| `report` | queued for the next report from this agent (§9.3)                                                            | PR 4     |
| `room`   | posted now as the agent through `RoomService.post`; room etiquette applies in full                           | PR 3     |
| `dm`     | the agent's in-app DM with the person (`notify-dm.ts`), **held** for their hours (§9.2)                      | PR 3     |
| `note`   | `relay_notify_user`'s resolution (a bound Telegram or Slack chat, else the in-app DM), **held** the same way | PR 3     |

In PR 3, before the report exists, a `report` raise is delivered as a held `dm`, so nothing a beat raises is lost.

### 9.2 Holding, batching, raise-once, away

- **Hours (PR 3).** A `dm` or `note` to a person outside their working hours, or while they are away, waits until the next start of their hours unless `urgent`. This is the agent's judgment carried out by the runner, not a cap: `urgent` always goes now (P6: nothing in DorkOS blocks an agent from reaching a person), and every urgent raise is recorded with its text so a person can see whether it was.
- **What a held message looks like (PR 3).** It is a `heartbeat.held` record row, and the agent's Heartbeat page shows "Held for your hours: 2" with the texts. Nothing is hidden. This answers Q8 of `specs/proactive-agent-dms` for beat raises.
- **Batching per agent (PR 3).** When a person's held messages come due, everything due to them from the same agent becomes one message. Several agents' messages due at the same moment arrive in the same minute, one per agent. A single roll-up across agents is a follow-up (canon §9.3: a lead agent rolls up); docs must not claim it.
- **Away (PR 4).** A raise to an away manager goes one step up the chain when there is someone above (P4: "an away manager is skipped, not waited on"); routine report lines wait for their return. At the top of the chain, an urgent raise to an away person is delivered now and a non-urgent one waits.
- **De-duplication across agents (PR 4).** A raise to a person whose `about` keys overlap one already delivered or queued to the same person within 7 days, from any agent, is dropped and the drop recorded ("Already raised by Otto."). Gathered keys are shared facts (`run:<id>`, `commitment:<id>`), which is what makes two agents' raises comparable.
- **Raise once, then track (PR 4).** An open raise (delivered, not resolved) with the same key from the same agent is not re-sent; it moves to the `report` rung marked "still open". Open raises appear in every beat prompt. They close by `end_beat.resolved`, by a reply from the person in that DM, or after 14 days.
- Delivery runs on a one-minute tick that reads due rows only. Held rows survive a restart (they are rows).

**Scope against `specs/proactive-agent-dms` (DOR-1209).** Heartbeats hold and batch **beat raises** only. A schedule's completion note (`TaskCompletionNotifier`) and an agent's deliberate `relay_notify_user` outside a beat report work a person started or a call the agent made, and are unchanged. Folding them into the same delivery service stays that spec's work; this spec answers its Q4 (the person's own zone), Q5 (held messages are rows) and Q8 (above) for beats.

### 9.3 The report (PR 4)

Each agent has a report queue: `report`-rung raises, `c3` triage results (PR 5), raises moved there by raise-once, reports-to changes, and the summaries of its beat turns since the last report. On a report beat its turn writes one message (finished, in progress, at risk, needed; `HEARTBEAT.md` may set the shape) and passes it as `end_beat.report`. To a person: their in-app DM at the start of their hours. To an agent manager: `chat_send`, kind `report`. `report: null` skips it and the queue carries over. The app's existing daily Shift Report (`notifications/shift-report.ts`) is unchanged: it summarises the app's events, not an agent's work.

## 10. PR split (landing order)

Each PR: its own worktree from `origin/main`, an independent adversarial review before opening, `pnpm verify`, Prettier, a changelog fragment, armed with `gh pr merge --auto`. Shared files are checked against open PRs first; DOR-2738's audit files are read, never edited.

### PR 1 — Reports-to and your hours

§4 and §3.5: `reportsTo`, `createdBy`, mirror columns, chain resolution with cycle refusal, `update_agent` support, the audit row, the profile picker; `profile.timezone`, `workingHours`, `away` with the migration and the browser seeding; Settings → "Your hours". **Ships:** set who an agent reports to, and tell DorkOS your hours.

**Tests:** chain resolution (unset → creator → owner; a missing manager skipped; a hand-made cycle stops at the owner); cycles refused at every write surface; migration on a stored config; zone seeded from the browser once and never overwritten; picker renders and saves; `createdBy` written by `create_agent` and never by `update_agent`.

### PR 2 — Commitments

§12. **Ships:** agents record what they promised; anyone can read every agent's list on its profile and on the Team page.

**Tests:** tools with caller identity; only the promising agent or a person may change one; due and overdue computed; audit rows; another agent can read the list.

### PR 3 — The beat runner

`services/heartbeats/`: who beats (§3.1), timed beats and event wakes (§3.2–3.3), pulse and sweep beats, the gatherers (§5), the rules rung (§6.1), the beat chat, the `heartbeat` origin and beat-turn registry, the prompt, notification suppression, failure storms (§7), `end_beat` (§8) with rungs `room`, `dm`, `note` and agent recipients, holding for hours and per-agent batching (§9.2 PR 3 items), `HEARTBEAT.md` (schema, cap, parser, editor), the three templates, `heartbeats.enabled`, the pause seam, `heartbeat_state`, `heartbeat_beats`, `heartbeat_outbox`, the record line, the Heartbeat profile page (§7.6). **Ships:** agents wake on a beat or an event, look around for free, work when there is work, tell people at a decent hour, and every beat leaves a line in the record.

**Tests:** a quiet beat runs no model and writes one record row; a local message triggers a turn through a `FakeAgentRuntime`; a stranger's message triggers nothing; an unregistered runtime never beats; a turn without `end_beat` delivers nothing; `end_beat` outside a beat refuses, and a person's turn in the beat chat is not a beat; `end_beat` cannot be blocked by an area setting; each cadence row with a fake clock; coalescing; restart stagger; `heartbeats.enabled=false` leaves no timer; the pause seam true → no beats; no `turn.completed` for a beat turn; a non-urgent `dm` at 23:00 arrives at 09:00 on the next working day and an urgent one at once; two raises from one agent due together arrive as one message; three failed beat turns raise once and slow down; `HEARTBEAT.md` edits apply next beat; invalid frontmatter keeps the last good one and records once; `LAUNCH_CAP_FULL` is retried and recorded.

### PR 4 — The report, away, raise-once and de-duplication

§9.2 PR 4 items and §9.3, the `report` beat kind, reports-to change lines. **Ships:** agents report up on their manager's rhythm and never nag.

**Tests:** an empty queue skips the report turn; a report reaches a person at the start of their hours and an agent manager as a `report`-kind chat message; an away manager is skipped one step up, and at the top urgent goes now; overlapping `about` keys from two agents arrive once with a record line; a re-raise of an open key moves to the report; a reply closes a raise.

### PR 5 — Triage on a decision model

`services/decisions/` (the server's first decision-model wiring), `triageBeat`, the credits bridge and the two `packages/decisions` options, the daily fuse, `heartbeats.triageOnCredits` with the offer, the live "Checks run on…" line, the `AGENTS.md` money-table edit. **Ships:** most beats with changes end at a cheap check instead of a full turn, once the person says yes.

**Tests:** nothing spends while `triageOnCredits` is `null` or `false`; the bridge exists only with a live token serving `openaiChat` and never with the kill switch off; the token never reaches a log or a record; a `touches` change is never dismissed without probabilities at ≥ 0.9; `review` and `unsure` go to a turn; the fuse falls back; the verdict mapping; a re-minted token is picked up; the source change is recorded once; `decision-narrow-only.test.ts` passes unchanged.

### PR 6 — Measures, docs and the claim gate

§13 measures, `GET /api/agents/:id/heartbeat` (state, next beat, last 50 beats, held messages, measures) and capability `heartbeat.status` (tier `observe`; any agent may read any agent's, so a lead reads its reports'); the measures on the Heartbeat page; operating skill `working-on-a-heartbeat`; `docs/concepts/heartbeats.mdx` (no "equal accounts", no cross-agent roll-up claim); PROACTIVE-AGENTS status, `ROADMAP.md`'s demo-claim gate and `PRINCIPLES.md` §2 status move what shipped to built. Evals in `packages/evals` for canon §6.3's four seeded situations. **Ships:** a person can see what their agents did on their own and whether it helped.

**Tests:** each measure from a seeded record; the page renders every state including "no beats yet"; the skill passes the operating-skills pack tests; the claim-gate check.

## 11. The record and the tables

- **The record line is an audit row.** One per beat, quiet ones included, through `recordAudit()`: `action: 'heartbeat.beat'`, `operation: 'execute'`, actor and target the agent, `source: { surface: 'system', sessionId? }` (the beat chat when a turn ran), `outcome` `ok` / `failed` / `refused`, `summary` the one line ("Checked 4 things. Nothing new." or `end_beat.summary`; never message bodies), `links.causedBy` the waking event's id when there is one, `visibility: 'space'`. Further rows link back to the beat's row: `heartbeat.raised`, `heartbeat.held`, `heartbeat.delivered`, `heartbeat.deduplicated`, `heartbeat.skipped`, `heartbeat.config_changed`, `heartbeat.config_invalid`, `heartbeat.chain_cycle`, `heartbeat.triage_source_changed`, `agent.reports_to_changed`, `commitment.*`.
- **`heartbeat_beats`** (packages/db; the measures' store, pruned after 90 days while the audit rows stay forever): `id` ULID, `agent_id`, `started_at`, `ended_at`, `kind` (`pulse | sweep | report`), `wake` (`timer | event:<type> | startup`), `changes` (counts by gatherer, JSON), `triage` (JSON: rung, model id, verdict, confidence, usage), `turn_session_id`, `turn_usage` (JSON, as the runtime reported it), `outcome` (`quiet | queued | worked | no-end-beat | failed | refused | skipped`), `raises` (count), `audit_seq`. Indexed `(agent_id, started_at)`.
- **`heartbeat_state`**, one row per agent: `agent_id` PK, `last_beat_at`, `last_change_at`, `pace` (JSON or null), `wake_again`, `consecutive_failures`, `beat_chat_id`, `beat_chat_date`, `frontmatter_hash`, `last_valid_frontmatter` (JSON), `last_report_at`, `new_manager`.
- **`heartbeat_outbox`**: `id`, `agent_id`, `beat_id`, `to_account`, `rung`, `text`, `key`, `about` (JSON), `urgent`, `deliver_after`, `state` (`held | delivered | dropped | resolved`), `delivered_entry_id`, `created_at`, `closed_at`. Indexed `(to_account, state, deliver_after)` and `(key)`.
- **The loop watcher seam.** `heartbeatRunner.observe(fn)` emits every finished beat (agent, wake, outcome, raises, the chat sends made during its turn), so DOR-2745 can count a beat that answers another agent's beat like any other exchange without this domain knowing it exists.

## 12. Commitments

Table `commitments`: `id` ULID, `agent_id` (who promised), `to_account` (to whom: a person, an agent, or `external:<label>` for an outsider), `what` (≤ 300 chars), `due_at` (ISO or null), `state` (`open | kept | missed | dropped`), `source_session_id`, `source_room_entry_id`, `created_at`, `closed_at`, `note`. Overdue is computed (`open` and `due_at < now`), never stored.

Capabilities in a `commitments` domain:

- `commitment_add({ what, to?, dueAt?, sourceEntryId? })`, tier `act`: the calling agent's own. A person adds one for an agent in the app.
- `commitment_update({ id, state, dueAt?, note? })`, tier `act`: the promising agent, or a person. Another agent may not close someone else's promise.
- `commitments_list({ agentId?, state?, to? })`, tier `observe`: **anyone in the space reads every agent's list** (canon §5.5).

Every change is an audit row (`commitment.created`, `.kept`, `.missed`, `.dropped`, `.moved`). Due timers are rebuilt from the table at startup. A commitment going overdue wakes its agent (§3.3); an hour past due it is marked `missed` unless the agent kept it or moved the date. HTTP: `GET /api/commitments`, `POST /api/agents/:id/commitments`, `PATCH /api/commitments/:id`. App: a "Commitments" section on the agent's profile and on the Team page (open first, overdue marked), copy per `writing-app-copy`.

A promise to an outsider is an ask (P3): the beat prompt and the operating skill say ask first, then record it once made.

## 13. Measures

Computed on read from `heartbeat_beats`, `heartbeat_outbox`, `commitments` and audit rows, over a window (default 7 days). Every number names its source; none comes from the agent's account of itself.

| Measure                              | v1 definition                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kept rate**                        | Beat turns that acted with no undo signal within 7 days ÷ beat turns that acted. Undo signals in v1: a person stopped that turn, paused the agent within an hour of it, or reacted 👎 to its raise; a revert of a commit it made, when `workspace` sees one. More signals arrive as the audit read side grows; the page says what is counted. |
| **Useful-raise rate**                | Raises delivered to a person that got a reply or a non-👎 reaction within 48 h ÷ raises delivered to a person.                                                                                                                                                                                                                                |
| **Interruptions per useful outcome** | Messages that reached a person (`dm`, `note` and `room` deliveries, and reports) ÷ (kept actions + useful raises).                                                                                                                                                                                                                            |
| **Surprises**                        | Not computed in v1: it needs the manager to say so. Listed as "not measured yet".                                                                                                                                                                                                                                                             |
| **Mutes and pauses**                 | Pauses of the agent, `wake` set to `off` by a person, and the agent's DM muted, in the window.                                                                                                                                                                                                                                                |
| Supporting                           | quiet-beat share; commitments kept on time; beats with no `end_beat`; triage checks and tokens; turn usage per beat; `bypass` posts; held messages.                                                                                                                                                                                           |

Targets are canon §6.1's, shown beside each number as "target", never as a grade.

## 14. Copy

UI strings follow `writing-app-copy` (chat, never session; at most 15 words per block; no "we"). Examples: "Wakes every 30 minutes in your hours." · "Wakes when something happens." · "Heartbeat off." · "Checks run on DorkOS credits. 41 today." · "Run cheap checks on DorkOS credits?" · "Reports to you." · "Held for your hours: 2." · "Promised Acme a reply by Friday." Docs and release notes follow `writing-for-humans`. Public copy keeps the demo-claim gate: nothing says an agent checks in on its own until PR 3 ships, and PR 6 moves the gate.

## 15. Open questions

1. ~~Fresh chat per beat, or one long chat?~~ (RESOLVED) **Answer:** one beat chat per agent per local day. **Rationale:** fresh-per-beat floods the chat list; one forever-chat reloads history (100k against 2–5k tokens a beat, research §1.1).
2. ~~Do existing agents start timed beats on upgrade?~~ (RESOLVED) **Answer:** no; with no `HEARTBEAT.md` they wake on events only, and only on a registered runtime. New agents get their type's template; with no type, only Doe agents get timed beats. **Rationale:** a timed beat on a bring-your-own plan used most of a weekly Claude limit in a role-play (canon §5.3).
3. ~~Does `end_beat` deliver raises, or does the agent post?~~ (RESOLVED) **Answer:** `end_beat` hands raises to the runner. **Rationale:** hours, batching, de-duplication and raise-once are the runner's job (canon §5.7).
4. ~~Where do a person's hours live before more people join a server?~~ (RESOLVED) **Answer:** in `profile` in the owner's config, keyed by account so DOR-2743 can move them onto each person. **Rationale:** one person per server today; `profile` is the person's own, agent-writable section.
5. ~~Is triage on credits a new money path?~~ (RESOLVED) **Answer:** yes. It spends only after the person says **Use credits**, is shown live on every agent's Heartbeat page, and amends ADR `261001-000811`. **Rationale:** approved by Dorian 2026-10-07; that ADR requires a person's choice or a told default, and a linked computer alone is not a choice.
6. ~~Does holding a message for someone's hours break "nothing blocks an agent from reaching a person"?~~ (RESOLVED) **Answer:** no. `urgent` always goes now; holding is the runner carrying out the agent's own judgment about non-urgent news (P6). **Rationale:** P6 frames hours as judgment, not a cap; the escape is the agent's, and every urgent raise is in the record.
7. ~~Can a stranger trigger a full-power beat?~~ (RESOLVED) **Answer:** no. Outsiders' messages are excluded from wakes and gatherers. **Rationale:** the room path runs them under the binding's grant; trust never extends to strangers (PRINCIPLES §1).
