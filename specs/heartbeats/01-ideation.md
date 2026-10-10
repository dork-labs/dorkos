# Heartbeats — ideation

**Linear:** DOR-2788. **Design (canon):** [`meta/PROACTIVE-AGENTS.md`](../../meta/PROACTIVE-AGENTS.md). **Evidence:** [`research/20261007_proactive-persistent-agents.md`](../../research/20261007_proactive-persistent-agents.md), [`research/20261007_agent-teams-role-play.md`](../../research/20261007_agent-teams-role-play.md) §3.3.

This is short on purpose. The design was decided with Dorian on 2026-10-07 (ticket comments, PROACTIVE-AGENTS §5.7, §9, §10) and confirmed again on 2026-10-10: heartbeats ship before launch. Maturity: a detailed design, so this adapts it into a spec rather than re-ideating.

## Intent

Agents that keep working when nobody is talking to them: they wake on a beat or an event, look at what changed with plain code, let a cheap decision model end most beats, run a real turn only when there is work, say things the quietest way that works, and leave one line in the record for every beat. Proactive in work, quiet in speech.

## What exists (2026-10-10, `main` at `80941b2ccf`)

| Piece                                                             | State                                            | Where                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Audit trail writer, hash chain, `recordAudit()`                   | merged (DOR-2738 parts 1-3)                      | `services/audit/audit-trail.ts`, `audit-log.ts`; `action` is a free `domain.verb` string                               |
| Audit read side (part 4) and pause everywhere (part 5)            | in flight in another chat                        | spec `audit-trail` PR4/PR5; `isPaused()` will live in `services/mesh/agent-pause.ts`                                   |
| Decision model port + ladder + bridges                            | merged (DOR-2778), **not wired into the server** | `@dorkos/shared/decision-model`, `packages/decisions` (`runLadder`, `createRulesModel`, `createOpenAiCompatibleModel`) |
| DorkOS credits token (anthropicMessages, openaiChat endpoints)    | merged                                           | `services/core/cloud/credits-inference.ts` (`heldCreditsToken`, `awaitCreditsToken`)                                   |
| Start a turn server-side, with a settle callback                  | merged                                           | `dispatchSessionMessage({ origin, onSettled })`, `services/session/launch/launch-session.ts:241`                       |
| Exhaustive turn origins                                           | merged                                           | `services/session/origin/turn-origin.ts` (`permissionSeedForOrigin`)                                                   |
| `chat_send` / `chat_read`, report-back                            | merged (DOR-2790)                                | `services/session/chat-messages/`                                                                                      |
| In-app DM from an agent to the person                             | merged                                           | `services/relay/notify-dm.ts` (through `RoomService.post`)                                                             |
| Notifications (`turn.completed`, `session.error`, `report.daily`) | merged                                           | `services/notifications/notification-registry.ts`                                                                      |
| Convention files SOUL / NOPE / MEMORY, prompt injection           | merged                                           | `@dorkos/shared/convention-files`, `runtimes/shared/agent-context.ts`                                                  |
| Agent manifest                                                    | merged; **no `reportsTo`, `createdBy`, `role`**  | `AgentManifestSchema`, `packages/shared/src/mesh-schemas.ts:408`                                                       |
| A person's hours, time zone, away                                 | **none anywhere**                                | only schedule time zones exist                                                                                         |
| Commitments                                                       | **none**                                         | —                                                                                                                      |
| Loop watcher v2                                                   | not built (DOR-2745)                             | leave a seam                                                                                                           |
| Role and responsibilities, tiered goals                           | not built (DOR-2743, DOR-2755)                   | the beat reads them once they exist                                                                                    |

## Assumptions

- One person per server today (the owner). "A person's hours" means the owner's until equal accounts (DOR-2743) add more people; the shapes take an account id so they do not change then.
- Doe (DOR-2782) is not required: a beat's turn goes through the same session API on every runtime.
- A beat never needs a new permission system: under trusted by default it runs with the agent's power, and the record is the safety net.

## Out of scope

- The loop watcher (DOR-2745). Beats expose an observer it can subscribe to.
- Role, responsibilities and goals as profile fields (DOR-2743, DOR-2755). Until then `HEARTBEAT.md` carries what to watch.
- The health check (DOR-2756) and weekly review page; measures ship as numbers on the agent's profile and through a tool.
- Card spending; no caps (decision 10.4).
- A cheap-model role in the Cloud model catalog: a `cloud-contract` follow-up. Until then triage on credits uses the catalog's recommended model with a tiny output budget.

## Recommended direction

Adopt PROACTIVE-AGENTS §5 as written, built as a new server domain `services/heartbeats/` (the beat runner) plus a skill-shaped `HEARTBEAT.md` convention file, reports-to on the manifest, the person's hours on their profile, a commitments table, and measures computed from the record. Six build PRs, each shipping something a person can use. Next: [`02-specification.md`](02-specification.md).
