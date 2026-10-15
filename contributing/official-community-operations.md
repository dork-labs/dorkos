# Official Community Space: Soft-Launch and Monitoring Runbook

## Overview

The DorkOS Community Space is one official space, run on the shared Community server, that every new DorkOS account joins automatically (D1-D3 in `specs/official-community-space/02-specification.md`). This guide is the operational runbook for its two-week soft launch (D14): the alerts to wire from the server's own `/metrics` and `/health/ready`, what to check every day while it runs, the bar that must be cleared before the public date, the freeze around that date, and what to do when something goes wrong. It assumes the admission, moderation and streaming work in `apps/community/` is already deployed; the day-to-day mechanics of running that server (backups, exports, erasure, takedowns) are `apps/community/OPERATIONS.md` — this guide only adds what is specific to the official space and its launch.

No part of this guide claims the Community Space is live to the public: it describes the plan for turning it on. The feature itself stays off (`spaces.official.url` empty) until Dorian sets the link (see "What only Dorian can decide" below).

## Key Files

| Concept                                                                                               | Location                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Day-to-day Community server operations (backups, mail, host keys, holds, takedowns, exports, erasure) | `apps/community/OPERATIONS.md`                                                                                                                                                                                                             |
| `/health/ready` and `/metrics` implementation                                                         | `apps/community/src/live/monitoring.ts`                                                                                                                                                                                                    |
| Live-stream fan-out and access caching                                                                | `apps/community/src/live/hub.ts` and `live/feed.ts` (a per-channel shared feed and cached access checks, PR #2753, DOR-2830)                                                                                                               |
| Load test tool and its target                                                                         | `apps/community/load/`; "Load testing" in `apps/community/OPERATIONS.md` states the D12 target and the commands — recorded runs are in its table, and how to split the production run across load machines is under "The production check" |
| Official-space config (the app side)                                                                  | `spaces.official.url` in app config; env override `DORKOS_OFFICIAL_SPACE_URL`                                                                                                                                                              |
| Open admission, auto-join, bans                                                                       | `apps/community/src/routes/community/open-admission.ts`, `apps/community/src/config.ts`                                                                                                                                                    |
| Moderation (mute, slow mode, reports, rules, display name)                                            | `apps/community/src/schema.ts`, `apps/community/src/http.ts` (moderation routes)                                                                                                                                                           |
| The spec these decisions come from                                                                    | `specs/official-community-space/02-specification.md` (D12 scale, D13 monitoring, D14 soft launch)                                                                                                                                          |

## When to Use What

| Scenario                                                | Approach                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Setting up alerting before the soft launch starts       | Wire the four alerts below from `/metrics` and `/health/ready` |
| Running the daily soft-launch check                     | Follow "Daily checks during the soft launch"                   |
| Deciding whether the space can go public                | Check every row of "The launch bar"                            |
| A deploy is scheduled near the launch date              | Follow "The upgrade freeze around launch"                      |
| Something is actively wrong (outage, abuse, data issue) | Follow "Incident steps"                                        |
| A day-to-day moderation or data-recovery question       | `apps/community/OPERATIONS.md`, not this guide                 |

## Alerts to wire from `/metrics` and `/health/ready`

`GET /metrics` (Prometheus text, needs a host API key with `communities:read` or a signed-in server admin) and `GET /health/ready` (no auth; `200` when the database and the live-notice listener both answer, `503` otherwise) are the only signals the server exposes about its own health. Point your monitoring at both before the soft launch starts. `/health` only proves the process is running — it answers `200` long after the server has stopped being useful, so it is not an alert source on its own.

| Alert               | Condition                                                                                                       | Why it matters                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listener down       | `community_live_listener_up == 0` for any scrape                                                                | Live delivery stops: posts still save, but nobody's open channel updates until the listener reconnects. This is the single most important Community alert.                                  |
| Pool saturation     | `community_db_pool_waiting > 0` sustained for several minutes                                                   | Requests are queueing behind the database pool; posts and reads are slowing down for everyone, not just one space.                                                                          |
| Readiness failing   | `/health/ready` returns `503`                                                                                   | The database or the listener has failed its own check. Treat any `503` lasting more than one scrape interval as an incident (see "Incident steps").                                         |
| Streams refused     | `community_live_streams_refused_total` increasing                                                               | A host, per-community or per-member stream cap was hit. During the soft launch this should never fire for the official space — investigate whether it is a real spike or a cap set too low. |
| Delivery lag        | `community_live_delivery_lag_seconds` (the histogram's p95/p99) climbing well past the D12 target of one second | Early warning that the server is falling behind, before readiness or refusals show it.                                                                                                      |
| Listener reconnects | `community_live_listener_reconnects_total` increasing abnormally fast                                           | Each reconnect re-reads every open channel once; frequent reconnects mean repeated extra load on top of whatever is causing them.                                                           |

None of these metrics identify a person or a message; `/metrics` reports stream counts, rates and pool state only, by community ID where it is scoped per community.

## Daily checks during the soft launch

Run these once a day for the full two weeks (D14), by whoever is on point for the launch that day:

1. **Read the alerts above.** No unacknowledged firing alert from the day before.
2. **`/metrics` by hand**: open stream count, posts/minute, joins/minute, `community_live_listener_up` is `1`, `community_db_pool_waiting` is at or near zero.
3. **The moderation queue** (reports from D6/D7): every open report is either resolved or has an owner/admin actively on it — none sitting unanswered.
4. **The report channel for bugs**: every report from a soft-launch member gets a reply within one business day (D14's own bar; this is the same standard as `meta/user-care.md`), even if the reply is "still looking."
5. **Disk and storage headroom** on the Community host, per the "Monitor the deployment" section of `apps/community/OPERATIONS.md` — a soft launch that fills disk is still an incident.
6. **Erasure and takedown queues are current** — nothing sitting in a failed or overdue state (`apps/community/OPERATIONS.md`, "Erasure requests" and "Taking down illegal content").
7. **One real post and one real read** through the public address, by a person, not just the health check — proves the actual path a member uses still works.

Keep a short daily log (date, who checked, anything notable) somewhere durable — a Linear comment on DOR-2764 is sufficient. The log is what later tells you whether the launch bar's "two weeks of current users" was actually two clean weeks.

## The launch bar

All of these must be true before the official space's link is set to a real value and the public date arrives (D14):

- [ ] **The production-size load run meets D12**: 20,000 open streams, 50 posts a second for one minute, 95% of messages delivered within one second, no refused posts, no stream that fails to open, drops, or misses a message — run on production-size hardware with a separate load machine, per "The production check" in `apps/community/OPERATIONS.md`. **Not yet met as of this writing.** Laptop runs (load machine, server and database on one M4 Pro) now meet D12 at 1,000 streams and, in one of two runs, at 5,000 (p95 0.80 s; the other 1.6 s). Posts no longer queue on their channel: since DOR-2837 a post holds its channel's next number only inside its own commit, and at 10,000 streams almost no database sample waits on a lock. 10,000 streams still could not be measured conclusively, because the laptop's load generator saturates there. The 20,000-stream target has not been demonstrated on any hardware yet; the production-size run is still required.
- [ ] **Moderation is staffed**: owners/admins are actively watching the reports queue every day the space is open, not only during the daily check above.
- [ ] **Rules and code of conduct are approved by Dorian** (D7) — the current text is a draft until he signs off.
- [ ] **The official space link is configured** (`spaces.official.url` / `DORKOS_OFFICIAL_SPACE_URL`) pointing at the real space, not a placeholder.
- [ ] **No data-loss incident** during the soft-launch window (D14).
- [ ] **No stranger-power regression** found during the soft launch — a stranger's message never raised an agent above the stranger ceiling (D10); this is normally proven by the existing automated stranger-safety suite, but the soft launch is real-world confirmation.
- [ ] **Every reported bug answered within one business day**, for the whole two weeks (tracked in the daily log above).

A red item on this list blocks the public date. None of these may be waived to hit a calendar date; move the date instead.

## The upgrade freeze around launch

Treat the two weeks of the soft launch, and the days immediately before the public date, as a change freeze on the Community server and on anything the official space depends on (admission, moderation, the app's `spaces.official` config):

- **No schema or infrastructure changes** land during the freeze except a fix for an active incident or a security fix. Ordinary feature work queues until after the public date.
- **Every change that does land** during the freeze follows "Upgrade and roll back" in `apps/community/OPERATIONS.md` in full: record the running image and source revision, take and verify a database-and-file backup first, and confirm `/health/ready`, sign-in, posting, live updates and one attachment afterward.
- **Roll back, don't patch forward, under time pressure.** There is no automatic reverse migration (`apps/community/OPERATIONS.md`), so a bad change during the freeze is reverted by restoring the prior image, database and files together, not by rushing a fix.
- **The freeze lifts** once the launch bar above is fully green and the public date has passed; normal deploy cadence resumes.

## Incident steps

For anything that fires one of the alerts above, or that a daily check surfaces:

1. **Confirm it's real.** Re-check `/metrics` and `/health/ready` directly; one bad scrape is not an incident.
2. **Scope it.** Is it the whole server (listener down, pool saturated) or one community? `community_live_streams_by_community` and the per-community rows in `/metrics` tell you whether the official space alone is affected.
3. **Contain it without destroying anything.** If a specific community (not necessarily the official space) is the source of a load spike or abuse, **hold** it (`apps/community/OPERATIONS.md`, "Holding and deleting a community") — a hold stops posting and joining without revoking anyone's connection, so it is reversible. Reach for **suspend** only when access itself must be cut. Never delete anything to stop an incident.
4. **If it's a safety or legal issue**, follow "Taking down illegal content" in `apps/community/OPERATIONS.md` — take down by ID, never read the content to decide, and use `notify: false` where the reasons there call for it.
5. **If it's a capacity issue** (pool saturation, growing delivery lag, refused streams), check `COMMUNITY_DATABASE_POOL_SIZE` against what "Database connections and live streams" in `apps/community/OPERATIONS.md` recommends before changing anything else — raising the pool size is the documented first lever.
6. **If it's a data-loss risk**, stop the app before anything else makes it worse, per "Back up both the database and files" in `apps/community/OPERATIONS.md`, then follow "Rehearse a restore" against a separate host — never restore onto the live database as a first attempt.
7. **Write it down.** Every incident during the soft launch goes in the daily log, including ones that resolved on their own, so the launch-bar review has a complete picture.
8. **Decide whether it resets the soft-launch clock.** A data-loss incident or a stranger-power regression found during the window means the two weeks start over once fixed; a contained, correctly-handled moderation action does not.

## What only Dorian can decide

These choices are the operator's alone — nobody else sets them, and none of them name a specific supplier:

- Creating the official space on the host and setting its admission policy to `open`.
- How the Community host machine is sized for the production load target.
- Which monitoring service receives the alerts above.
- Whether there is a public status page, and which service runs it.
- The official space's member cap.
- Who may join the official space (whether it is open outside the US, and to whom by age).
- Final approval of the rules and code of conduct text (D7).
- The soft-launch start date and the public launch date.
- The value of `spaces.official.url` once the space is ready to go live.
