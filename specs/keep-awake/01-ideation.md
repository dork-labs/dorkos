---
slug: keep-awake
number: 261005-120219
created: 2026-10-05
status: ideation
---

# Keep the computer awake while agents work, and wake it for scheduled runs

**Slug:** keep-awake
**Author:** Claude (IDEATE for Dorian Collier)
**Date:** 2026-10-05
**Linear:** DOR-2718

---

## 1) Intent & Assumptions

- **Task brief (verbatim, Dorian in #dorkos, 2026-10-05):** "build something that keeps the mac awake while any chat, background job or scheduled run is active, and lets it sleep when idle. I also like the optional setting, wake the Mac for scheduled tasks … a MAJOR quality of life improvement … not urgent, but we should do it soon."
- **What the issue asks for:**
  1. Keep awake while active (default on): one reference-counted power assertion held while any agent turn, live background task or approved scheduled run is active; released when idle. macOS `caffeinate -i -w <serverPid>` restarted on a timer, Windows `SetThreadExecutionState`, Linux `systemd-inhibit`. Also set Codex's `prevent_idle_sleep` as a second layer.
  2. Optional, off by default: wake for scheduled tasks. Schedule a system wake shortly before the next approved run (`pmset schedule wake`, Windows wake timers, Linux `rtcwake`); admin once, said plainly; re-arm after each run.
  3. Late runs are honest: record the intended tick and that it ran late; drop runs too stale to matter; verify and fix the suspected dedupe-key bug (`currentRun()` is the actual fire time, not the intended tick).
  4. Settings toggles ("Keep this computer awake while agents work", "Wake for scheduled tasks") and a small indicator "Keeping awake: 2 chats running" linking to the setting.
  5. Plain caveats: a closed lid on battery always sleeps; low-battery sleep can't be stopped; keeping awake costs battery.
- **Done when:** a real Mac stays awake through a long turn with the display off and sleeps within its normal idle time after; a scheduled run fires on time after the Mac was asleep (wake option on); tests cover the reference counting and the late-run record.
- **Operator decisions already made (settled):**
  - Split in two: `packages/keep-awake` (`@dorkos/keep-awake`, private) knows nothing about DorkOS: reference-counted `hold(reason)`/`release()`, one adapter per OS, a no-op adapter that says why, and `scheduleWake(at)`. The server keeps the DorkOS part as a small service inside an EXISTING domain (`services/core/`), never a new domain (the census test in `scripts/__tests__/agents-service-census.test.ts` would red).
  - Desktop and CLI share one mechanism, built once in the server. No Electron `powerSaveBlocker`. OS tools spawned from the server, no native modules. A missing tool is logged once and the server carries on. Docker/headless is skipped and the status says so.
  - Wake needs admin. Desktop asks once with the system password prompt; the CLI prints one command, or `dorkos power setup` asks for sudo; the setting shows whether it is set up.
  - The indicator and the settings live in the web app.
- **Assumptions:**
  - The server process is the right owner of the assertion: under the CLI the server runs in the CLI's own process (`packages/cli/src/cli.ts:880` imports the server in-process), and under the desktop app it is an Electron `utilityProcess` child (`apps/desktop/src/main/server-spawn.ts:416`). Either way `process.pid` inside the server is the process whose death must end the assertion.
  - "Idle" means no agent turn in flight, no task run in flight, and no pre-run wake window open. A turn parked waiting for a person's approval is still a turn in flight.
  - macOS is the verified target. Windows (desktop is an unsigned alpha) and Linux ship best-effort and must not be claimed as working in copy until a real install confirms them (AGENTS.md demo-claim gate).
- **Out of scope:**
  - Preventing display sleep, or preventing sleep on lid close (clamshell on battery always sleeps; macOS gives apps no way to stop it).
  - Catch-up of every tick missed while the server process was not running at all. The scheduler's "a tick that is missed is missed" rule stays (`apps/server/src/services/tasks/task-scheduler-service.ts:975-983`); this work only makes the one late fire croner does produce honest.
  - Electron `powerSaveBlocker` / `powerMonitor` (rejected by the operator: one mechanism, one truth).
  - Waking for anything other than approved scheduled task runs (relay deliveries, Telegram messages, extension timers).

## 2) Pre-reading Log

- `AGENTS.md`: hard rules (no stash, no pkill, `os.homedir()` banned in server), service-domain census, demo-claim gate, `writing-app-copy` (≤15 words a block, no "we").
- `research/`: nothing on power, sleep, caffeinate or wake. Scheduler reports (`research/pulse-scheduler-design.md`, `research/scheduler-comparison.md`, `research/scheduling-approaches-analysis.md`) predate this and say nothing about missed ticks on sleep.
- `apps/server/src/services/core/runtime-registry.ts:237-249`: `register()` wraps every runtime once, `watchRuntimeSignin(traceRuntime(runtime))`; its comment names it "the one seam every turn passes through — the interactive composer, a room reply, a scheduled run and a relay delivery all resolve their runtime from here (DOR-1654)".
- `apps/server/src/services/observability/trace-runtime.ts:31-50` and `apps/server/src/services/observability/runtime-signin-watch.ts:627-690`: the established Proxy-over-`sendMessage` pattern, with `watchTurn` as an `async function*` wrapper around the runtime's generator.
- `apps/server/src/index.ts:2895-2915`: the relay's runtime map is resolved back through the registry precisely so relay turns get the wrapped proxy.
- `apps/server/src/services/session/trigger-turn.ts:971-993`: the interactive/room turn settles in one `.finally()`. Good, but task runs bypass it: `task-scheduler-service.ts:1531` calls `agentManager.sendMessage` directly.
- `apps/server/src/services/runtimes/claude-code/messaging/turn-liveness.ts:21-31`: live background subagents (`local_agent`) hold the turn's stream open, so they are inside the turn; background shells (`local_bash`) are killed by the CLI shortly after stdin ends.
- `packages/shared/src/agent-runtime.ts:1630-1645`: `isHelperWorking?(sessionId)`, a bounded per-session "a helper is still working" answer.
- `apps/server/src/services/tasks/task-scheduler-service.ts:117-139` (`scheduledTickKey`), `:736-743` (croner registration), `:999-1066` (dispatch + claim), `:1107` (`executeRun`), `:1531-1546` (direct run turn), `:872-876` (`getNextRun`).
- `apps/server/src/services/tasks/task-store.ts:808-842` (`claimScheduledRun`), `packages/db/src/schema/tasks.ts:191-229` (`pulse_runs`), `:285` (`pulse_dispatch_log`), `packages/shared/src/schemas.ts:5244` (`TaskRunSchema`).
- `node_modules/.pnpm/croner@10.0.1/.../dist/croner.js` (read prettified): `_trigger` sets `currentRun = new CronDate(undefined)` (now), `_checkTrigger(target)` fires when `now >= target` and then `schedule()` computes the next run from now; the timer is chunked at `W = 30 * 1e3` ms.
- `packages/shared/src/config-schema.ts:2415-2432` (`scheduler` section, the declared-twice defaults), `apps/server/src/services/core/config-manager.ts:4785` (newest migration key `0.98.0`; newest tag `v0.97.0`), `.claude/skills/adding-config-fields/SKILL.md`.
- `apps/server/src/services/runtimes/codex/codex-options.ts:66-99`: `buildCodexOptions` sets only `config.mcp_servers` today. `@openai/codex-sdk@0.154.0` types (`dist/index.d.ts:214-234`) accept arbitrary nested `config`.
- Codex binary 0.154.0 (`codex features list`): `prevent_idle_sleep  experimental  false`; strings show `utils/sleep-inhibitor/src/macos.rs`, assertion `PreventUserIdleSystemSleep` named "Codex is running an active turn".
- Claude Agent SDK 0.3.280: the bundled `claude` binary contains `caffeinate`, `systemd-inhibit`, "Started … to prevent sleep", "Stopped sleep inhibitor, allowing sleep"; flags and whether it runs headless are not recoverable from the stripped binary. DorkOS does not rely on it.
- `apps/client/src/layers/features/status/model/status-bar-registry.ts:76-79, 404-620`: the status line is per chat session; two machine-wide switches were removed from it because they "read as per-session but weren't".
- `apps/client/src/AppShell.tsx:851-862`: the persistent top-bar cluster holding `<ControlCenter />` and `<RemoteAccessBeacon />` (present only while a tunnel is doing something).
- `apps/client/src/layers/widgets/remote-access/ui/RemoteAccessBeacon.tsx`, `apps/client/src/layers/widgets/control-center/ui/ControlCenterBody.tsx:17-54` (`UnattendedLine`), `apps/client/src/layers/widgets/control-center/ui/RemoteAccessRow.tsx`.
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx:61-87`, `apps/client/src/layers/features/settings/ui/tools/SchedulerSettings.tsx`, `ToolsTab.tsx:34-51`, `apps/client/src/layers/shared/model/use-dialog-deep-link.ts:42` (`?settings=<tab>&settingsSection=<anchor>`).
- `apps/server/src/routes/events.ts:51-97` + `apps/server/src/services/core/event-fan-out.ts`; `apps/server/src/index.ts:6209` (`eventFanOut.broadcast('tunnel_status', status)`); `apps/client/src/layers/shared/model/event-stream-context.tsx:197` (`useEventSubscription(KnownEvent, handler)`).
- `packages/cli/src/cli.ts:40-67` (`knownCommands`), `:362-367` (telemetry wiring), `packages/cli/src/commands/telemetry/telemetry.ts` (model subcommand with injected deps).
- `apps/desktop/src/main/admin/index.ts:34, 39-51, 207-215` and `apps/desktop/src/preload/index.ts`: the IPC pattern (channel constant, `isCockpitSender` gate, discriminated result).
- `apps/server/src/services/runtimes/opencode/server-manager.ts:450, 642-654`: spawn + SIGTERM→SIGKILL teardown of a long-lived OS child; `apps/server/src/index.ts:6277-6413` (`shutdownServices`, signal handlers).
- No existing Docker/container/headless detection anywhere in `apps/server/src`, `packages/cli/src`, `packages/shared/src`.

## 3) Codebase Map

- **Primary components/modules:**
  - New `packages/keep-awake/`: OS adapters, reference counting, wake scheduling, environment detection.
  - New `apps/server/src/services/core/keep-awake/`: the DorkOS service (when to hold, status, config), the runtime wrapper, wake arming.
  - `apps/server/src/services/core/runtime-registry.ts:248`: the turn chokepoint.
  - `apps/server/src/services/tasks/task-scheduler-service.ts`: task-run holds, late-run honesty, dedupe key, next-wake source.
  - `apps/server/src/services/runtimes/codex/codex-options.ts`: the `prevent_idle_sleep` second layer.
  - Client: a top-bar beacon widget, a Settings card in the Tools tab, a Control Center line, run-history copy for late/stale runs.
  - `packages/cli`: `dorkos power setup|status|remove`.
  - `apps/desktop`: one IPC handler that runs the wake setup with the system password prompt.
- **Shared dependencies:** `eventFanOut`, `useEventSubscription`, `useConfig`/`PATCH /api/config`, the settings deep link, croner.
- **Data flow:** runtime `sendMessage` generator starts → keep-awake service `hold()` → package adapter spawns `caffeinate` → status change → `eventFanOut.broadcast('keep_awake_status')` → client query cache → beacon. Generator settles → `release()` → linger → adapter stops the holder.
- **Feature flags/config:** new `keepAwake` config section (two booleans). No env kill switch needed; the config and the environment detection cover headless deployments.
- **Potential blast radius:** every agent turn passes the new wrapper (must be structurally unable to break a turn); the dispatch dedupe key (on-time fires must produce the identical key); the `pulse_runs` table (two nullable columns); the runtime tool-census guards are not touched (no new capability or MCP tool).

## 4) Root Cause Analysis (the dedupe-key part only)

- **Repro:** the script reproduced in `02-specification.md` Part C, run with `node` from `apps/server`. A `* * * * * *` croner job; after fire 2, the event loop is blocked for 3.6 s while croner's timer is pending, which is exactly what a sleeping machine does to a `setTimeout`.
- **Observed (2026-10-05, croner 10.0.1):**

  ```
  fire 2: intendedTick 12:01:40.000  currentRun 12:01:40.002  scheduledTickKey 12:01:40.000
  --- loop blocked 3.6s with croner timer pending (simulated sleep) ---
  fire 3: intendedTick 12:01:41.000  currentRun 12:01:43.908  scheduledTickKey 12:01:43.000
  fire 4: intendedTick 12:01:44.000  currentRun 12:01:44.000  scheduledTickKey 12:01:44.000
  ```

  The 12:01:41 occurrence fired at 12:01:43.908; `currentRun()` returned the wall clock; the key floored to 12:01:43, a different occurrence; 12:01:42 and 12:01:43 never fired.

- **Evidence in croner source:** `_trigger` sets `this._states.currentRun = new CronDate(undefined, tz)`, i.e. now, never the target it was scheduled for; `_checkTrigger(target)` only checks `now >= target`, then `schedule()` computes the next run from now, which is why every other missed tick is dropped.
- **Decision (verdict): the bug is real.** `scheduledTickKey` floors `currentRun()` (`task-scheduler-service.ts:139`) and is the dispatch dedupe key (`:1044-1050`). The doc at `:121-131` already states correctly that `currentRun()` is wall-clock; the inline comment at `:737-738` ("Pass the cron's intended tick (not wall-clock)") is wrong. On an on-time fire the floor equals the occurrence, so nothing visible breaks today. On a late fire the key names the minute the machine woke, not an occurrence: (a) the run row cannot say which occurrence it was or how late it ran; (b) two processes firing the same late occurrence on either side of a minute boundary (a leader handoff during wake) get different keys and both run it, which is exactly what the dedupe exists to stop. Severity is low (the leader lock makes (b) rare) but the key is not what the code says it is.

## 5) Research

- **Turn chokepoint options:**
  1. `triggerTurn` `.finally()` (`trigger-turn.ts:971-993`). Pro: one settle path, already has `onTurnStart`/`onSettled`. Con: task runs (`task-scheduler-service.ts:1531`) and relay deliveries (`packages/relay/src/adapters/claude-code/agent-handler.ts:580`, `task-handler.ts:442`) bypass it; two or three more sites needed.
  2. `SessionStateProjector` lifecycle (`'streaming'`). Pro: one place, event-derived. Con: a missed `turn_end` leaves a hold stuck, and task runs attach a projector only for display.
  3. **A Proxy at `runtimeRegistry.register()` (`runtime-registry.ts:248`)**, wrapping `sendMessage`'s async generator, beside the trace and sign-in wrappers. Pro: the one seam every caller already goes through (interactive, room, scheduled, relay; DOR-1654 made sure of the relay); `try/finally` in an `async function*` runs on completion, throw and `return()` (a `for await` break or an interrupt). Con: a consumer that drops the generator without `return()` never reaches `finally`; bounded by an idle ceiling.
  - **Recommendation:** option 3 for turns, plus one explicit task-run hold around `executeRun` (`task-scheduler-service.ts:1107`) so the pre-turn setup of a run (placement, provisioning) is covered and the status can say "task".
- **"Live background task" here means:** (a) Claude Code background subagents and other process-holding tasks, which keep the turn's generator open (`turn-liveness.ts`), so the turn hold covers them; (b) DorkOS task runs, covered by the run hold. Background shells die with the turn's stdin, so nothing outlives the turn to hold for.
- **macOS keep-awake:** `caffeinate -i -w <pid> -t 300`, renewed every 240 s by spawning the new holder before killing the old one (no gap). `-i` stops idle system sleep and lets the display sleep (the "display off" in the done-when). `-w` ends the assertion the moment the server dies; `-t` bounds any orphan. Lid-closed on battery still sleeps: no user-space tool can stop it.
- **Linux:** `systemd-inhibit --what=idle:sleep --who=DorkOS --why="Agents are working" --mode=block tail --pid=<pid> -f /dev/null`. `tail --pid` exits when the server dies. Polkit allows an active local session; over SSH it may be refused, which the status reports.
- **Windows:** a PowerShell holder that P/Invokes `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` (`0x80000001`) and then `Wait-Process -Id <pid>`; killing it (or the server dying) clears the state. No native module.
- **Codex second layer:** `buildCodexOptions` passes `config: { features: { prevent_idle_sleep: true } }` when keep-awake is on. The SDK flattens nested `config` into `--config features.prevent_idle_sleep=true`.
- **Wake, macOS:** `pmset schedule wake "MM/dd/yy HH:mm:ss" DorkOS` and `pmset schedule cancel wake "<same>" DorkOS` (the optional owner argument scopes our events; `man pmset`). Root only. Options for the one-time grant:
  1. Sudoers rule on `/usr/bin/pmset` with wildcards: rejected, `*` matches arbitrary trailing arguments.
  2. Sudoers rule with a `^…$` regex (sudo ≥ 1.9.10; this Mac has 1.9.17p2): narrowest, but Linux distributions still ship older sudo (Ubuntu 22.04: 1.9.9), so it cannot be the one approach.
  3. A root LaunchDaemon: a permanently running root process; rejected as far more privilege than needed.
  4. `SMAppService` privileged helper: desktop-only, needs a signed XPC helper; rejected (CLI parity).
  5. **A tiny root-owned helper plus a sudoers drop-in that allows exactly that helper for exactly this user, with no password.** The helper validates its arguments (a fixed verb and an integer epoch within 31 days) and only ever calls `pmset schedule [cancel] wake … DorkOS` (macOS) or `rtcwake -m no -t <epoch>` (Linux). Works with any sudo, reviewable in one screen, removable with one command. **Recommended.**
- **Wake, Windows:** a Task Scheduler task for the current user with `WakeToRun`, a one-time trigger and a no-op action, re-registered on re-arm. No admin. Honours the "Allow wake timers" power option, which is often off on battery and limited on Modern Standby machines; best effort.
- **Wake, Linux:** `rtcwake -m no -t <epoch>` sets the RTC alarm without suspending; root, through the same helper.
- **Desktop admin prompt:** `osascript -e 'do shell script "<install>" with administrator privileges'` from the Electron main process shows the standard macOS password dialog.
- **Docker/headless detection:** `/.dockerenv` exists, `/proc/1/cgroup` names docker/containerd/kubepods/lxc, or `container` is set in the environment (podman, systemd-nspawn) → `container`. Linux with neither `systemd-inhibit` nor a reachable logind → `tool-missing`.
- **Prior art:** KeepingYouAwake (MIT, a menu-bar wrapper over the same IOKit assertion `caffeinate` uses), Electron `powerSaveBlocker` docs (`prevent-app-suspension` = `-i`), Claude Code's caffeinate helper (`-i`, short `-t`, restarted on a timer), Codex `utils/sleep-inhibitor` (IOKit `PreventUserIdleSystemSleep` per active turn).

## 6) Decisions

| #   | Decision                  | Choice                                                                                                                      | Rationale                                                                                                                                                      |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Package/server split      | `@dorkos/keep-awake` + a service in `services/core/keep-awake/`                                                             | Operator, settled.                                                                                                                                             |
| 2   | Mechanism                 | OS tools spawned by the server, desktop and CLI alike; no `powerSaveBlocker`, no native modules                             | Operator, settled.                                                                                                                                             |
| 3   | Turn chokepoint           | Proxy at `runtimeRegistry.register()` + a run hold around `executeRun`                                                      | The one seam every caller already uses (DOR-1654); the run hold adds pre-turn setup and the "task" label.                                                      |
| 4   | Release timing            | 30 s linger after the last hold ends                                                                                        | Back-to-back turns (room bursts, task chains) must not flap the assertion.                                                                                     |
| 5   | Admin grant for wake      | Root-owned validating helper + per-user sudoers drop-in                                                                     | Least privilege that works on every sudo and on Linux too.                                                                                                     |
| 6   | Late-run policy           | Key and record the intended occurrence; run late only when under one hour late and less than halfway to the next occurrence | Fixes the dedupe key with no data migration (on-time keys are identical) and drops runs that would act on a world that moved on. Threshold flagged for Dorian. |
| 7   | Where the indicator lives | Top-bar beacon beside remote access + a Control Center line, not the per-chat status line                                   | The status line is per session and machine-wide items were removed from it for that reason. Flagged for Dorian.                                                |

Next step: SPECIFY (`02-specification.md`).
