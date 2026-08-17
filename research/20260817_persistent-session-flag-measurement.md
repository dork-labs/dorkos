---
title: 'Persistent session runtime: flag-off vs flag-on measurement (P5.1)'
date: 2026-08-17
type: measurement
status: current
linear: DOR-1289
project: Persistent session runtime
spec: specs/persistent-session-runtime
tags: [persistent-session, performance, ttft, prompt-cache, phantom-cancellations, measurement]
---

# Persistent session runtime: flag-off vs flag-on measurement

**What this is.** The numbers spec `persistent-session-runtime` task 5.1 asks for: the same workload run twice on one machine, once with `runtimes.claudeCode.persistentSession` off (how it ships today) and once with it on. The performance claim is the justification for the whole programme and neither the ideation nor the spec ever measured it. This pays that debt.

**What this is not.** A decision. The recommendation at the end is a recommendation, and task 5.3 — flipping the default — is the human's call.

**Headline.** Time to first token from turn two onward is **4.4× faster** with the flag on (median 970 ms vs 4,261 ms; n=16 per arm). The cache-read ratio is **identical** on both arms — that expectation is refuted. The process ceiling holds **exactly** at twelve. Phantom cancellations were **zero on both arms**, so the DOR-1087 hypothesis is untested rather than confirmed. And one arm-B run in three **wedged a session permanently** on a bug the flag-off path cannot reach.

---

## 1. Method

### Host and conditions

|                 |                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Machine         | Apple `Mac16,8`, 14 CPUs, macOS (Darwin 25.6.0)                                                                         |
| Load at start   | `load average 9.45` over 14 CPUs — **this machine was running other agents throughout**                                 |
| Node            | v24.14.1                                                                                                                |
| Claude Code CLI | 2.1.231                                                                                                                 |
| Repo            | worktree of `origin/main` @ `465782196` (includes P5.2's tripwire, PR #1066)                                            |
| Model           | `claude-haiku-4-5`, pinned via `ANTHROPIC_MODEL` on the server process, confirmed in every turn's `status_change.model` |
| Credential      | the operator's local `claude` sign-in (no `ANTHROPIC_API_KEY`, no `CLAUDE_CODE_OAUTH_TOKEN` in the environment)         |
| Date            | 2026-08-17 (UTC)                                                                                                        |

The host was **not** quiet. Other agents were working on this machine during both arms. Both arms ran sequentially on the same host within the same hour, never in parallel, so the noise applies to both — but the absolute numbers are noisier than a dedicated box would give.

### Harness

A throwaway Node driver (session scratchpad, not committed) that for each arm:

1. Creates a fresh scratch sandbox — `<tmp>/sandbox-<arm>/.dork` as `DORK_HOME`, `<tmp>/sandbox-<arm>/project` as the turn cwd, `DORKOS_BOUNDARY` pinned to the sandbox root. **The operator's real `~/.dork` was never touched.**
2. Spawns `apps/server/src/index.ts` under `tsx` as a detached process group on a dedicated port (4642–4648; nothing in the 6xxx dev range or the 4242/4241 test range), capturing stdout+stderr to a per-arm log at debug level.
3. Sets the arm's flag with one `PATCH /api/config` **before any session exists**, and asserts the returned config carries it. Arm A = `false`, arm B = `true`. Each arm gets its own server boot, so no session ever carries warmth across the flip.
4. Drives turns over the product API: subscribe to `GET /api/sessions/:id/events` first, then `POST /api/sessions/:id/messages` (202), collect frames to `turn_end`. Every SSE frame is stamped with its arrival time. Tool approvals are auto-approved by POSTing `/approve` from a caller presenting no agent identity — the same `local-trust` path the cockpit takes.
5. Samples `ps -eo pid,ppid,rss,command` every 2 s and walks the process tree from the server's pid, counting descendants and `claude`-matching processes.
6. Reads `GET /api/debug/phantom-cancellations` at the end.

### Workload

**Workload 1 — representative session.** One session, five turns, real tool use, a subagent, and a mid-turn message:

1. write `notes.md`
2. read it and append a line
3. **launch one subagent via the `Task` tool** — and eight seconds in, while it works, the driver sends a second message with `disposition: 'steer'` (the historical phantom trigger)
4. create three files and list the directory
5. read two files and summarise

Run three times per arm (R1 as part of the full run, R2 and R3 as standalone repeats).

**Workload 2 — soak.** 16 fresh sessions, two cheap no-tool turns each (32 turns), run back to back so warm processes accumulate faster than the 5-minute idle reaper can retire them. `MAX_WARM_SESSIONS` is 12, so 17 sessions (16 soak + 1 main) exercise the ceiling. Run once per arm.

### Totals

98 real turns across 7 server boots (4 smoke, 37 arm A full, 37 arm B full, 5×4 repeats). Reported `total_cost_usd` summed to **≈ $1.28** — the API-equivalent figure; the run billed the operator's subscription sign-in, not a card.

### Two corrections to the brief

- **`SESSION_TURN` does not carry time-to-first-token.** The span at `trigger-turn.ts:604` starts before the detached turn and ends in its `finally`, and the only attribute it records is `dorkos.event_count` (`observability/attributes.ts`). It measures whole-turn duration. The `firstEvent` promise beside it gates the canonical-id race and is never timed. **TTFT here is therefore wall-clock at the client**: from the trigger POST leaving the driver to the first `text_delta` / `thinking_delta` / `tool_call` frame arriving on the durable stream. That is the user-visible number and needs no debug tracing turned on. If the spec wants TTFT off a span, the span has to start recording it.
- **`session_status` is not what reaches the client.** The result mapper emits `session_status` with `cacheReadTokens`, but `session-event-normalizer.ts` folds it into a `status_change` SessionEvent carrying `status.cacheStats.{cacheReadTokens,cacheCreationTokens}` and `status.contextUsage.totalTokens`. Those are the fields read here.

---

## 2. Time to first token

`turn 2 and later`, in milliseconds. Lower is better.

### Soak sessions — the clean comparison (n=16 per arm)

Two turns per session, no tools, identical prompts, same order, same host.

|                          | Arm A (flag off) | Arm B (flag on) | Change                 |
| ------------------------ | ---------------- | --------------- | ---------------------- |
| **Turn 2 median**        | **4,261**        | **970**         | **−77% (4.4× faster)** |
| Turn 2 mean              | 4,875            | 1,002           | −79%                   |
| Turn 2 min               | 2,881            | 732             |                        |
| Turn 2 p90               | 6,504            | 1,206           |                        |
| Turn 2 max               | 11,381           | 1,706           |                        |
| Turn 2 whole-turn median | 6,028            | 2,398           | −60%                   |
| Turn 1 median (cold)     | 2,009            | 2,359           | **+17% slower**        |

Two things stand out.

**The persistent arm is faster on turn two and slower on turn one.** Arm A's turn 2 is _slower than its own turn 1_ (4,261 vs 2,009) — the resume path pays to replay the transcript into a fresh process. Arm B inverts that (2,359 cold, then 970) because the second message reaches a process that is already running. Arm B's cold turn costs ~350 ms more than arm A's, which is the pump's setup showing up where it should.

**Arm B's spread is far tighter.** Arm A ranges 2,881–11,381 ms; arm B ranges 732–1,706 ms. On a machine already running other agents, the flag-off path's worst case is 6.7× its best. The warm path barely moves.

### Main workload turns 2–5 (n=12 arm A, n=10 arm B)

|                         | Arm A  | Arm B |
| ----------------------- | ------ | ----- |
| median                  | 7,157  | 2,057 |
| mean                    | 12,933 | 2,517 |
| max                     | 31,936 | 6,165 |
| median excluding turn 4 | 6,242  | 2,185 |

**Turn 4 is an artifact and must be discounted.** In all three arm-A runs turn 4's TTFT was 31,7xx–31,9xx ms with zero tool calls. The cause is not spawn overhead: on the flag-off path the steer sent during turn 3 is **downgraded to a queued message** (see §5), so it runs as its own extra turn, and turn 4's POST queues behind it. The 32 seconds is queue wait, not launch cost. Excluding it, arm A's median is 6,242 ms against arm B's 2,185 ms — still ~2.9× faster on the warm path.

**Turn 2 of a brand-new session shows no benefit** (arm A 3,752/5,667/7,265; arm B 3,962/4,599/6,165). The logs say why: exactly once per server boot, on the first session's second message, the persistent path logs

```
[persistent-dispatch] replacing a warm process
  reason: 'relaunching: effort changed since this process was launched'
```

The effort setting resolves after the first turn of the first session, which invalidates the process that was just warmed, and that session pays a relaunch it would not otherwise pay. It happened in all three arm-B runs and never again within a run — no later session was affected. Small, but it means the very first conversation after a server start gets no warm hit on its second message.

**Verdict: CONFIRMED.** TTFT from turn two on is materially lower on the persistent arm — 4.4× on the clean n=16 comparison, ~2.9× on the tool-heavy workload.

---

## 3. Cache-read token ratio

`cacheReadTokens / contextUsage.totalTokens`, from the last `status_change` of each turn.

|                                      | Arm A      | Arm B      |
| ------------------------------------ | ---------- | ---------- |
| Soak turn 1 median                   | 99.97%     | 99.97%     |
| **Soak turn 2 median**               | **99.86%** | **99.86%** |
| Soak turn 2 `cacheReadTokens` median | 33,658     | 33,659     |
| Soak turn 2 `contextTokens` median   | 33,704     | 33,705     |
| Main turns 2–5 median                | 98.99%     | 99.00%     |
| Main turns 2–5 min                   | 74.15%     | 96.39%     |

The two arms are indistinguishable — within single-digit tokens of each other on a ~33,700-token context.

**Verdict: REFUTED.** The cache-read ratio is not materially higher with the flag on. It was already at ceiling with the flag off.

This is not a surprise once stated plainly, and it should re-anchor how the programme is described. **Anthropic's prompt cache lives on the server, not in the subprocess.** A resumed session replays the same prefix and gets the same cache hits; keeping the process alive does not add a caching layer that was missing. What persistence removes is _local_ work — process spawn, MCP handshakes, transcript replay, tool/command discovery — which is exactly what §2 measured. The gain is real; the _mechanism_ asserted in the spec is wrong, and the "materially higher cache-read ratio" line should be struck rather than restated.

One weaker signal worth naming: on the tool-heavy main workload arm A dipped to 74.15% on a single turn while arm B's floor was 96.39%. That is one sample against one sample, and the arms' medians are equal. Do not build anything on it.

---

## 4. Resident subprocess count

Sampled every 2 s from the server's own process tree. The soak drove 17 sessions past a ceiling of 12.

|                                             | Arm A  | Arm B       |
| ------------------------------------------- | ------ | ----------- |
| Peak `claude` processes, soak               | 5      | **13**      |
| Peak descendants (all children), soak       | 15     | 61          |
| Peak resident memory, all descendants       | 2.0 GB | **12.4 GB** |
| `claude` processes 60 s after the last turn | 0      | **12**      |
| Memory 60 s after the last turn             | 23 MB  | 11.9 GB     |

The "13" is 12 real ones plus one false positive: the count matches any command containing `claude`, and the worktree path is `…/.claude/worktrees/…`, so an `esbuild` helper matched too. Enumerating the settle sample's commands gives exactly **twelve** `…/bin/claude --output-format stream-json` processes and one esbuild binary. Arm A's settle sample contains that same esbuild binary and **zero** `claude` processes.

The registry logged **5 LRU reclaims** across the run — 17 sessions asking, 12 slots, 5 evictions — each naming the reaped session and the asker, always the least recently used. Nothing was refused.

**Verdict: CONFIRMED, exactly.** The count is bounded by `MAX_WARM_SESSIONS`, and the LRU behaves as documented.

**But the number under the bound is the news.** Twelve warm sessions on this workload held **~12 GB of resident memory** and 61 processes, against ~2 GB peak and nothing at rest on the flag-off path. This is a laptop-class cost that lands on every operator the moment the default flips, and it is not in the spec's expectations at all. The ceiling holds; whether twelve is the right ceiling for a default is a separate question this measurement now forces.

### Reap-then-rewarm thrash

**Zero observed — and the workload cannot detect it.** Each soak session was finished when it was reaped and never came back, so the five reclaims were all clean evictions, never a reap followed by a rewarm of the same session. Measuring thrash honestly needs a workload that revisits sessions after eviction (say 20 sessions round-robined for four turns each). That was not run.

Two things can still be said. First, on this shape of load the ceiling was reached with 17 sessions and evicted the genuinely-oldest, which is the intended behaviour. Second, the spec's own guidance holds and the memory figure sharpens it: **if thrash ever shows up, raise the ceiling rather than lengthen the idle timer** — but raising the ceiling from 12 costs roughly a further gigabyte per slot, so the ceiling is a memory dial, not a free one. Recommendation on the ceiling: **leave `MAX_WARM_SESSIONS` at 12 and do not raise it without a thrash measurement that justifies the memory.**

---

## 5. Phantom-cancellation rate

From `GET /api/debug/phantom-cancellations` at the end of each arm, and confirmed against every server log (`grep '[phantom-cancellation]'` matched nothing but my own GET request line).

|                                 | Arm A     | Arm B     |
| ------------------------------- | --------- | --------- |
| `byPath.turn` (resume path)     | 0         | 0         |
| `byPath.pump` (persistent path) | 0         | 0         |
| total / batches / sessions      | 0 / 0 / 0 | 0 / 0 / 0 |

**Verdict: NOT TESTED.** The persistent arm's pump count is zero, which is what the hypothesis predicts — but the flag-off arm is _also_ zero, so the run has no discriminating power. A control that produced no events cannot validate a treatment that produced no events either. The 2026-08-09 incident (eight phantoms in one session) was on a long, heavy, tool-dense session on the operator's real project; 98 short turns on a cheap model in a nearly-empty sandbox did not reproduce the conditions.

The tripwire itself is verified working end to end: the endpoint answers, the counter is wired, both paths are represented in `byPath`. What is missing is a workload that produces phantoms at all. **DOR-1087 remains unverified**, and the honest next step is to leave the tripwire running on a real dogfood session rather than try to manufacture phantoms in a sandbox.

---

## 6. The finding that was not on the list: a persistent-path session can wedge permanently

**One arm-B run in three (n=3) left a session permanently unusable. It never happened on arm A (n=3).**

In run R1, turn 3 (the subagent turn with the mid-turn steer) ended after 13.9 s having spawned **no** subagent, where the two clean runs took 19–25 s and reported 3–4 subagent updates. Then turns 4 and 5 never produced a `turn_end` at all — both hit the driver's 180-second ceiling — and the session was dead for the rest of the run.

The server log gives the whole chain:

```
[SessionTurnWindows] a result answered a message this session never sent
  { answered: '432da3cd…' (the STEER), open: [ '3e2eba39…' ] (the turn) }
[persistent-dispatch] dropped a turn nobody asked for { dropped: 1 }
[POST /messages] queued behind the running turn { queuePosition: 1 }
[POST /messages] detached turn error
  IllegalPumpTransitionError: SessionPump cannot go from running to running
    at SessionTurnWindows.dispatch (session-turn-windows.ts:427)
    at PersistentDispatch.dispatch (persistent-dispatch.ts:343)
```

Line 427 is the guard `if (this.current !== undefined) throw new IllegalPumpTransitionError('running','running')`. The steer's `result` closed the wrong window's accounting, the real window's record was never cleared, and from that moment **every** subsequent dispatch on that session throws. The turn errors out detached, so no `turn_end` reaches the stream and the client just watches a session that never answers.

Why the flag-off path cannot hit it: on the resume path there is no held input stream, so `PersistentDispatch.steer` reports "no open turn" and the message is **downgraded to `queue`** (`applied: 'queue'`, receipt confirmed in all three arm-A runs). Native steering only exists when the flag is on — which is a genuine feature of the persistent path, and also the thing that broke.

**Rate: 1 in 3 identical runs.** It is a race, not a determinism, which makes it worse to ship, not better: it will be rare, hard to reproduce from a bug report, and total when it lands.

---

## 7. Expectations, settled

| Spec expectation                                               | Verdict                 | Evidence                                                                          |
| -------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| TTFT materially lower from turn 2 (no spawn, no MCP reconnect) | **Confirmed**           | 970 ms vs 4,261 ms median, n=16/arm; 2,185 vs 6,242 on the main workload          |
| Cache-read ratio materially higher                             | **Refuted**             | 99.86% on both arms, within 1 token of each other                                 |
| Subprocess count bounded by `MAX_WARM_SESSIONS`                | **Confirmed exactly**   | 12 `claude` processes at rest with 17 sessions driven; 5 clean LRU reclaims       |
| Phantom rate zero on the pump path                             | **Not tested**          | 0 on both arms — the control produced no phantoms either                          |
| Reap-then-rewarm thrash                                        | **Not measurable here** | no session was revisited after eviction                                           |
| _(unlisted)_ Session stability under a mid-turn steer          | **Failed**              | 1 of 3 runs wedged on `IllegalPumpTransitionError`; unreachable with the flag off |
| _(unlisted)_ Memory cost at the ceiling                        | **New**                 | ~12 GB resident vs ~0 at rest                                                     |

---

## 8. Limitations

Read these before quoting any number.

1. **Busy host.** Load average was ~9 on 14 CPUs and other agents ran throughout. Both arms share the noise and ran sequentially, so the _ratio_ is more trustworthy than the absolutes.
2. **One model, and a cheap one.** Everything ran on `claude-haiku-4-5` to keep spend sane. TTFT includes the model's own latency, so a slower model would compress the _relative_ gap (the saved work is local and roughly constant) while widening it in absolute ms.
3. **Small n on the main workload.** Three runs per arm, five turns each. The soak comparison (n=16 per arm) is the number to lean on; the main-workload figures are directional.
4. **An empty sandbox is not a real project.** Every session started in a directory holding one seed file. Transcript replay on the resume path — the thing persistence avoids — grows with conversation length, so a long real session should show a _larger_ gap than measured here, not a smaller one. Untested.
5. **The soak cannot see thrash.** Sessions were never revisited after eviction (§4).
6. **The phantom result is a null, not a zero.** §5.
7. **`costUsd` is API-equivalent, not billed.** The run went through a subscription sign-in.
8. **The driver auto-approved every tool prompt** with `alwaysAllow: true`. A person clicking approvals would add human latency to both arms equally, but the persisted permission rules are a small extra state change the real path would not always make.
9. **The wedge is n=3.** One failure in three runs is enough to take seriously and not enough to characterise. It should be reproduced deliberately before or after any flip decision.
10. **Session-id remapping.** claude-code re-mints its internal session id, so the driver re-subscribes between turns when the canonical id changes. Re-subscription always happens _before_ a turn's POST, never during, so no TTFT sample spans a re-subscribe. Turn-1 numbers are otherwise unaffected.

---

## 9. Recommendation for the 5.3 gate

**This is a recommendation, not a decision.**

**Do not flip the default yet — fix the wedge first, then flip.** The performance case is made and it is a good one: a person's second and subsequent messages start answering in about one second instead of four, and the variance collapses, which is the difference between "responsive" and "is it stuck?" on a busy laptop. That alone justifies the programme. But two things stand between the measurement and a default. The first is disqualifying on its own: one run in three left a session permanently unable to answer, on a code path (`IllegalPumpTransitionError` after a mid-turn steer) that the flag-off default cannot reach — a rare, total, hard-to-report failure is exactly the kind a default must not introduce, and it needs a fix plus a regression test before anything else matters. The second is a scoping question rather than a blocker: twelve warm sessions held roughly twelve gigabytes at rest where the current default holds nothing, and that cost lands on every operator silently. Neither needs new measurement to act on. Separately, two claims in the spec should be corrected regardless of the flip: the cache-read-ratio expectation is refuted and should be struck rather than softened (the win is avoided local work, not better caching), and the phantom-cancellation hypothesis is still untested and should not be described as validated — leave P5.2's tripwire running on real dogfood sessions until it has something to count.

---

## Appendix A — main workload, every turn

TTFT and duration in ms. `sub` = subagent update events.

### Arm A (`persistentSession: false`)

| run | turn | ttft  | duration | tools | sub | cacheRead | context | outcome |
| --- | ---- | ----- | -------- | ----- | --- | --------- | ------- | ------- |
| R1  | 1    | 2379  | 7570     | 7     | 0   | 33616     | 34098   | done    |
| R1  | 2    | 5667  | 12080    | 13    | 0   | 34392     | 34731   | done    |
| R1  | 3    | 3905  | 43514    | 35    | 5   | 38950     | 52526   | done    |
| R1  | 4    | 31936 | 34549    | 0     | 0   | 52518     | 52921   | done    |
| R1  | 5    | 5398  | 14522    | 27    | 0   | 53069     | 54082   | done    |
| R2  | 1    | 2140  | 8938     | 7     | 0   | 33628     | 34135   | done    |
| R2  | 2    | 7265  | 13831    | 13    | 0   | 34429     | 34779   | done    |
| R2  | 3    | 7157  | 23398    | 20    | 3   | 35779     | 36434   | done    |
| R2  | 4    | 31894 | 35039    | 0     | 0   | 36522     | 36571   | done    |
| R2  | 5    | 6242  | 17064    | 28    | 0   | 37709     | 37942   | done    |
| R3  | 1    | 2132  | 9518     | 6     | 0   | 33628     | 34138   | done    |
| R3  | 2    | 3752  | 9869     | 13    | 0   | 34424     | 34777   | done    |
| R3  | 3    | 7134  | 27550    | 17    | 3   | 35770     | 36487   | done    |
| R3  | 4    | 31733 | 35921    | 0     | 0   | 36558     | 36607   | done    |
| R3  | 5    | 13117 | 23224    | 26    | 0   | 36990     | 38052   | done    |

### Arm B (`persistentSession: true`)

| run | turn | ttft | duration | tools | sub | cacheRead | context | outcome     |
| --- | ---- | ---- | -------- | ----- | --- | --------- | ------- | ----------- |
| R1  | 1    | 2082 | 7459     | 7     | 0   | 33616     | 34093   | done        |
| R1  | 2    | 6165 | 13077    | 14    | 0   | 34382     | 34730   | done        |
| R1  | 3    | 2057 | 13943    | 6     | 0   | 34826     | 36132   | done        |
| R1  | 4    | _13_ | 180517   | 36    | 3   | —         | —       | **timeout** |
| R1  | 5    | —    | 180510   | 0     | 0   | —         | —       | **timeout** |
| R2  | 1    | 2797 | 6689     | 5     | 0   | 33622     | 34024   | done        |
| R2  | 2    | 4599 | 10715    | 12    | 0   | 34307     | 34644   | done        |
| R2  | 3    | 2185 | 24696    | 17    | 4   | 35625     | 36817   | done        |
| R2  | 4    | 1764 | 9945     | 24    | 0   | 37930     | 38156   | done        |
| R2  | 5    | 1080 | 4635     | 9     | 0   | 38355     | 38716   | done        |
| R3  | 1    | 2044 | 7733     | 7     | 0   | 33622     | 34115   | done        |
| R3  | 2    | 3962 | 10660    | 13    | 0   | 34412     | 34764   | done        |
| R3  | 3    | 1946 | 19399    | 14    | 3   | 35833     | 36713   | done        |
| R3  | 4    | 702  | 7745     | 26    | 0   | 36851     | 37979   | done        |
| R3  | 5    | 708  | 5242     | 10    | 0   | 38149     | 38504   | done        |

R1 turn 4's 13 ms is not a TTFT: it is a trailing frame from the wedged turn 3 arriving just after the POST. Excluded from every statistic. R1 turns 4–5 are the wedge described in §6.

## Appendix B — soak TTFT, raw (ms)

**Arm A, turn 1 (cold):** 1834, 2258, 1859, 2084, 2714, 2152, 2009, 1948, 2029, 1945, 2505, 1840, 1859, 2866, 1897, 1880
**Arm A, turn 2:** 4261, 6049, 4016, 3800, 4652, 2881, 4002, 6504, 4368, 4718, 5205, 3849, 11381, 4067, 4067, 4187

**Arm B, turn 1 (cold):** 2456, 2325, 2775, 2391, 2953, 3078, 2090, 1936, 1906, 2104, 2054, 2832, 2351, 2287, 2359, 2442
**Arm B, turn 2:** 970, 1046, 1199, 847, 790, 1706, 1206, 937, 732, 1068, 1004, 838, 866, 1163, 795, 862

Every arm-B turn-2 sample is faster than every arm-A turn-2 sample. The distributions do not overlap.

## Appendix C — server-log markers per run

Counts of the lines the pump and dispatcher write.

| run               | LRU reclaim | warm process replaced | window done | IllegalPumpTransition | result answered a message never sent | dropped a turn | queued behind running turn |
| ----------------- | ----------- | --------------------- | ----------- | --------------------- | ------------------------------------ | -------------- | -------------------------- |
| A full (37 turns) | 0           | 0                     | 0           | 0                     | 0                                    | 0              | 21                         |
| A repeat 1        | 0           | 0                     | 0           | 0                     | 0                                    | 0              | 5                          |
| A repeat 2        | 0           | 0                     | 0           | 0                     | 0                                    | 0              | 5                          |
| B full (37 turns) | 5           | 1                     | 35          | **1**                 | **1**                                | **1**          | 1                          |
| B repeat 1        | 0           | 1                     | 5           | 0                     | 0                                    | 0              | 0                          |
| B repeat 2        | 0           | 1                     | 5           | 0                     | 0                                    | 0              | 0                          |

Arm A's high "queued behind the running turn" count is the steer downgrade plus the driver's next message queueing behind it — the §2 turn-4 artifact. Arm B's single "warm process replaced" per run is the once-per-boot effort relaunch (§2). Every `window done` is a persistent-path turn window closing cleanly; arm A has none because it has no windows.

## Appendix D — reproducing this

The driver is deliberately not in the repo. To repeat the measurement:

1. Boot `apps/server/src/index.ts` twice on a scratch `DORK_HOME` + `DORKOS_BOUNDARY`, once per arm, on a port outside 6xxx/4242/4241.
2. `PATCH /api/config` with `{"runtimes":{"claudeCode":{"persistentSession":<bool>}}}` before the first session — a session that is already warm keeps its path when the flag flips, so the flag must be set on a fresh boot.
3. Drive turns subscribe-first over `/events` + `/messages`, stamping frame arrival times; TTFT is POST→first `text_delta`/`thinking_delta`/`tool_call`.
4. Read cache figures off the last `status_change`'s `status.cacheStats` and `status.contextUsage.totalTokens`.
5. Walk the server's process tree with `ps` on an interval; count `bin/claude --output-format stream-json` and ignore path-matched false positives.
6. Read `GET /api/debug/phantom-cancellations` at the end and grep the log for `[phantom-cancellation]`.
