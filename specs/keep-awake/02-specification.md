---
slug: keep-awake
number: 261005-120219
created: 2026-10-05
status: specified
---

# Keep the computer awake while agents work, and wake it for scheduled runs

**Status:** Draft
**Author:** Claude (SPECIFY for Dorian Collier)
**Date:** 2026-10-05
**Linear:** DOR-2718
**Ideation:** [`01-ideation.md`](./01-ideation.md)

## Overview

DorkOS holds one reference-counted "don't idle-sleep" assertion while any agent is working on this computer (a chat turn, a room reply, a relay delivery, a task run, or a background subagent inside a turn) and lets the computer sleep normally once everything is idle. Optionally, it wakes the computer a minute before the next approved scheduled run. A scheduled run that fires late after sleep records which occurrence it was and how late it ran, and a run too stale to matter is skipped on the record instead of run. The suspected dedupe-key bug is real and is fixed on the way.

The work splits in two (operator decision): `@dorkos/keep-awake`, a private package that knows nothing about DorkOS and owns the OS mechanics, and a small DorkOS service in `apps/server/src/services/core/keep-awake/` that decides when to hold, reads the two settings and reports status to the app.

## Background / Problem Statement

- Nothing in DorkOS holds a sleep assertion today. A Mac left alone mid-turn idle-sleeps after its energy-saver timeout (often 10-30 minutes on battery, 1-3 hours on power) and the turn stalls until someone opens the lid. Claude Code's own caffeinate helper is not something DorkOS can rely on: its strings are present in the bundled `claude` binary of `@anthropic-ai/claude-agent-sdk@0.3.280`, but its flags and whether it runs under the SDK are not observable. Codex has the same feature as an experimental flag, `prevent_idle_sleep`, default off (`codex features list` on 0.154.0), which DorkOS never sets.
- Scheduled tasks run on croner timers inside the server (`task-scheduler-service.ts:736`). A sleeping computer is never woken, and on wake croner fires exactly one late run and silently drops every other missed tick (proved below). That one late run is recorded as if it were an on-time run of a different occurrence.
- `scheduledTickKey` keys the cross-process dedupe on `currentRun()`, which is the wall-clock fire instant, not the intended occurrence (proved below). On a late fire the key names no occurrence at all.

Measurable outcome: a real Mac stays awake through a long turn with the display off and sleeps within its normal idle time after; with the wake option on, a scheduled run fires on time after the Mac was asleep; tests cover the reference counting and the late-run record.

## Goals

- One assertion, reference-counted, held exactly while agents work and released within 30 s of the last one ending, on every exit path (success, error, interrupt, stall, server crash).
- Every turn counted exactly once regardless of who started it, through one chokepoint.
- Settings: "Keep this computer awake while agents work" (on by default) and "Wake for scheduled tasks" (off by default), with a plain set-up state for the one-time admin grant.
- A top-bar indicator present only while DorkOS is keeping the computer awake, saying why, linking to the setting.
- Honest late runs: each scheduled run records its intended occurrence; late runs say how late; stale runs are skipped on the record; the dedupe key is the occurrence.
- Wake for scheduled tasks on macOS, verified on a real Mac; Windows and Linux best effort, labeled as such.
- Graceful degradation: a container, a headless box or a missing tool is detected, logged once and shown in status. The server never fails to start or run a turn because of this feature.

## Non-Goals

- Preventing display sleep or lid-close sleep. A closed lid on battery always sleeps; low-battery sleep cannot be stopped.
- Electron `powerSaveBlocker` or `powerMonitor` (operator: one mechanism, one truth).
- Catch-up of ticks missed while the server was not running, or replaying every tick missed during sleep. One occurrence at most runs late; the rest are counted as missed.
- Waking for anything except approved scheduled task runs.
- A new server service domain (`services/core/` hosts it; the census in `scripts/__tests__/agents-service-census.test.ts` stays as is).
- Native modules of any kind.

## Technical Dependencies

- macOS: `/usr/bin/caffeinate` (`-i -w <pid> -t <s>`), `/usr/bin/pmset` (`schedule [cancel] wake "MM/dd/yy HH:mm:ss" [owner]`), `/usr/bin/sudo`, `/usr/sbin/visudo`, `/usr/bin/osascript` (desktop prompt only). All ship with macOS.
- Linux: `systemd-inhibit` (systemd ≥ 183), `tail` with `--pid` (GNU coreutils), `rtcwake` (util-linux), `sudo`.
- Windows: `powershell.exe` 5.1 (ships with Windows 10/11), `Register-ScheduledTask` / `New-ScheduledTaskSettingsSet -WakeToRun` (ScheduledTasks module).
- `croner@10.0.1` (already a server dependency): `nextRun`, `nextRuns`, `previousRuns`, `currentRun`.
- `@openai/codex-sdk@0.154.0`: `CodexOptions.config` accepts arbitrary nested config (`dist/index.d.ts:214-234`), flattened to `--config key=value`. Codex 0.154.0 knows `features.prevent_idle_sleep` (experimental, default false).
- No new npm dependencies.

## Detailed Design

### Part A: `@dorkos/keep-awake` (new package, private)

`packages/keep-awake/`, name `@dorkos/keep-awake`, `"private": true`, ESM, built with `tsc` like `packages/memory`. Depends on nothing but Node built-ins. Registered in the root `vitest.config.ts` projects list (`scripts/__tests__/vitest-projects.test.ts` fails otherwise), in `apps/server/package.json` dependencies, and in AGENTS.md's monorepo tree. The CLI bundle inlines it with the server (`packages/cli/scripts/build.ts:319-366` bundles `apps/server/src/index.ts` through `dorkosSourcePlugin()` and externalizes only the listed third-party modules), so no CLI dependency entry is needed.

```
packages/keep-awake/src/
  index.ts                 # public barrel
  keep-awake.ts            # createKeepAwake: ref counting, linger, renewal, status
  environment.ts           # detectEnvironment: platform, container, tool presence
  holders/
    types.ts               # Holder port: start(), stop(), describe
    macos-caffeinate.ts
    linux-systemd-inhibit.ts
    windows-execution-state.ts
    noop.ts                # carries the reason it is a no-op
  wake/
    types.ts
    wake-scheduler.ts      # createWakeScheduler: picks the platform adapter
    macos-pmset.ts
    linux-rtcwake.ts
    windows-task-scheduler.ts
    privileged-helper.ts   # helper script source, install/remove commands, setup probe
  __tests__/
```

**Public API (exported from `index.ts`, every export TSDoc'd):**

```ts
/** Why keep-awake cannot hold the computer awake here. */
export type UnsupportedReason =
  | 'container' // /.dockerenv, container cgroup, or $container set
  | 'tool-missing' // caffeinate / systemd-inhibit / powershell not found
  | 'denied' // the tool ran and refused (e.g. polkit over SSH)
  | 'platform'; // an OS with no adapter

export type Mechanism = 'caffeinate' | 'systemd-inhibit' | 'windows-execution-state' | 'none';

export interface KeepAwakeStatus {
  supported: boolean;
  reason?: UnsupportedReason;
  mechanism: Mechanism;
  /** Holds currently open (counted, even while disabled or unsupported). */
  holds: number;
  /** Whether the OS assertion is actually in force right now. */
  asserted: boolean;
  /** Open hold reasons, in acquisition order. Duplicates allowed. */
  reasons: string[];
}

/** One open hold. `release()` is idempotent; a second call is a no-op. */
export interface Hold {
  readonly reason: string;
  release(): void;
}

export interface KeepAwake {
  /** Open a hold. The first open hold starts the OS assertion (when enabled). */
  hold(reason: string): Hold;
  /** Turn the OS assertion on or off without losing the count. */
  setEnabled(enabled: boolean): void;
  status(): KeepAwakeStatus;
  /** Called after every status change (hold count, asserted, supported). */
  onChange(listener: (status: KeepAwakeStatus) => void): () => void;
  /** Release the assertion and stop the holder process. Idempotent. */
  dispose(): Promise<void>;
}

export interface KeepAwakeOptions {
  /** The process whose death must end the assertion. Defaults to process.pid. */
  watchPid?: number;
  /** Delay between the last release and dropping the assertion. Default 30_000. */
  lingerMs?: number;
  /** caffeinate only: holder lifetime (-t) and renewal period. Defaults 300 s / 240 s. */
  holderTtlSec?: number;
  renewEveryMs?: number;
  enabled?: boolean; // default true
  /** Injection seams for tests. */
  platform?: NodeJS.Platform;
  spawn?: SpawnLike;
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string | null;
  env?: NodeJS.ProcessEnv;
  logger?: { info(msg: string): void; warn(msg: string): void };
  timers?: TimerLike;
}

export function createKeepAwake(options?: KeepAwakeOptions): KeepAwake;

export interface EnvironmentReport {
  platform: NodeJS.Platform;
  container: boolean;
  mechanism: Mechanism;
  reason?: UnsupportedReason;
}
export function detectEnvironment(
  options?: Pick<KeepAwakeOptions, 'platform' | 'fileExists' | 'readFile' | 'env'>
): EnvironmentReport;

export type WakeSetupState = 'ready' | 'needed' | 'unsupported';

export interface WakeScheduler {
  /** Replace DorkOS's one pending wake with one at `at`. Cancels the previous one first. */
  scheduleWake(at: Date): Promise<WakeResult>;
  /** Cancel DorkOS's pending wake, if any. Never touches anyone else's. */
  cancelWake(): Promise<void>;
  /** Whether the one-time admin grant is in place (non-interactive probe). */
  setupState(): Promise<WakeSetupState>;
  /** The exact commands `dorkos power setup` / the desktop prompt run, for display and execution. */
  setupPlan(): WakeSetupPlan;
}
export type WakeResult =
  | { ok: true; at: Date }
  | { ok: false; reason: 'setup-needed' | 'unsupported' | 'failed'; detail?: string };
export interface WakeSetupPlan {
  /** Shell script run as root to install the grant. Null when no grant is needed (Windows). */
  installScript: string | null;
  removeScript: string | null;
  /** One line a person can paste into a terminal. */
  oneLiner: string | null;
}
export function createWakeScheduler(
  options?: { user?: string } & Pick<KeepAwakeOptions, 'platform' | 'spawn' | 'env' | 'logger'>
): WakeScheduler;
```

**Reference counting (`keep-awake.ts`):**

- `hold()` increments the count and returns a `Hold` whose `release()` decrements once. Release twice is a no-op (a closure flag), so a caller can release in more than one `finally` safely.
- 0 → 1 while enabled and supported: cancel any pending linger timer; if no holder is running, start one.
- 1 → 0: start the linger timer (`lingerMs`, default 30 s). When it fires with the count still 0, stop the holder. A hold arriving during the linger cancels it and keeps the existing holder.
- `setEnabled(false)` stops the holder at once (no linger) but keeps counting; `setEnabled(true)` with count > 0 starts it at once.
- `onChange` fires on: count change, `asserted` change, `supported` change. Listeners are called in a `try/catch` (a throwing listener is logged, never propagated).
- Holder failures: a holder that fails to start (ENOENT, non-zero exit within 1 s) marks the status `supported: false` with its reason, logs ONE warn per process for that reason, and leaves counting intact. A holder that exits unexpectedly later is restarted once; a second unexpected exit within 60 s marks it unsupported for the life of the process (no restart storms).
- Never throws out of `hold`, `release`, `setEnabled`. This is what makes it safe to put in every turn's path.

**Holders (the OS adapters), all watching `watchPid` so a server crash ends the assertion:**

| OS                | Process                                                                                                                | Notes                                                                                                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS             | `caffeinate -i -w <pid> -t 300`                                                                                        | `-i` prevents idle system sleep only; the display still sleeps. Renewed every 240 s: spawn the new holder, then SIGTERM the old one, so coverage never gaps. `-w` ends it with the server; `-t` bounds an orphan to 5 minutes. This mirrors Claude Code's short-`-t`-renewed approach.          |
| Linux             | `systemd-inhibit --what=idle:sleep --who=DorkOS --why="Agents are working" --mode=block tail --pid=<pid> -f /dev/null` | `tail --pid` exits when the server dies, which drops the inhibitor lock. Exit code non-zero within 1 s → `denied` (polkit refusal, typical over SSH). No renewal needed.                                                                                                                        |
| Windows           | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <script>`                                  | Script: `Add-Type` a P/Invoke of `kernel32!SetThreadExecutionState`, call it with `0x80000001` (`ES_CONTINUOUS \| ES_SYSTEM_REQUIRED`), then `Wait-Process -Id <pid>`. The execution state belongs to the holder's thread and is cleared when the holder exits or is killed. No renewal needed. |
| Container / other | `noop`                                                                                                                 | `supported: false`, reason `container` or `platform`. Counting still works so status stays truthful.                                                                                                                                                                                            |

Stopping a holder: SIGTERM, then SIGKILL after 2 s if it has not exited (the `server-manager.ts:642-654` pattern). Holders are spawned with `stdio: 'ignore'`, `detached: false`, and never through a shell (argument arrays only; the Windows script is a fixed string with the pid interpolated as an integer).

**Environment detection (`environment.ts`):** container when `/.dockerenv` exists, or `/proc/1/cgroup` contains `docker`, `containerd`, `kubepods` or `lxc`, or `env.container` is non-empty. Otherwise the platform picks the holder; tool presence is learned by trying (ENOENT on spawn → `tool-missing`), not by `which`, so there is one truth. `os.homedir()` is never used (package is outside `apps/server/src`, but keep the rule anyway).

**Wake scheduling (`wake/`):**

- Exactly one DorkOS-owned pending wake at a time. The scheduler remembers the instant it last set and cancels exactly that one before setting the next; it never calls `pmset schedule cancelall`.
- macOS: `sudo -n <helper> set <epochSeconds>` / `sudo -n <helper> cancel <epochSeconds>`; the helper runs `/usr/bin/pmset schedule wake "<MM/dd/yy HH:mm:ss local>" DorkOS` / `/usr/bin/pmset schedule cancel wake "<same>" DorkOS`.
- Linux: `sudo -n <helper> set <epoch>` runs `/usr/sbin/rtcwake -m no -t <epoch>` (sets the RTC alarm without suspending); `cancel` runs `rtcwake -m disable`. The RTC holds one alarm, so cancel-before-set is natural.
- Windows: no admin. `Register-ScheduledTask -TaskName "DorkOS wake" -Trigger (New-ScheduledTaskTrigger -Once -At <local time>) -Settings (New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable) -Action (New-ScheduledTaskAction -Execute cmd.exe -Argument "/c exit 0") -Force` for the current user; cancel = `Unregister-ScheduledTask -TaskName "DorkOS wake" -Confirm:$false`. `setupState()` is `ready`. Honours the "Allow wake timers" power option, which is off on battery by default and limited on Modern Standby machines; status copy says best effort.
- `setupState()` (macOS/Linux): `sudo -n -l <helper>` exits 0 when the grant is in place → `ready`; non-zero → `needed`; helper or sudo missing → `needed`; container/other → `unsupported`. Cached by the server (see Part B), never prompts.

**The one-time admin grant (macOS and Linux): a validating helper plus a scoped sudoers drop-in.**

- Helper path: macOS `/Library/PrivilegedHelperTools/ai.dorkos.wake`, Linux `/usr/local/libexec/dorkos-wake`. Owner `root:wheel` (Linux `root:root`), mode `0755`, in a root-owned directory, so the user cannot replace it.
- Helper source is a fixed POSIX `sh` script in `privileged-helper.ts` (embedded as a string, versioned with a `# dorkos-wake v1` header line). It: `set -eu`; sets `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; accepts exactly `set <epoch>`, `cancel <epoch>` or `version`; requires `<epoch>` to match `^[0-9]{10}$` and lie between now and now + 31 days (cancel accepts any past-or-future epoch in that format); formats the date itself with `date -r <epoch> "+%m/%d/%y %H:%M:%S"` (macOS) and calls only the absolute-path tool. Any other input exits 64 with no side effect.
- Sudoers drop-in: `/etc/sudoers.d/dorkos-wake`, mode `0440`, content exactly one rule: `<username> ALL=(root) NOPASSWD: <helperPath>`. Written to a temp file and checked with `visudo -cf` before being moved into place; never edits `/etc/sudoers`.
- Install script = write helper, chown/chmod, write + validate + move the drop-in, then run `<helper> version` to prove it. Remove script deletes both files. Both are generated by `setupPlan()` so the CLI and the desktop run the same bytes.
- Why this and not the alternatives (full comparison in ideation §5): a wildcard sudoers rule on `pmset` admits arbitrary trailing arguments; a `^…$` regex rule is narrower but needs sudo ≥ 1.9.10, which Linux LTS releases do not all ship; a root LaunchDaemon is a permanently running root process; an `SMAppService` helper is desktop-only. The helper grant gives the user's account the power to set or cancel one wake event, nothing more, and is removed with one command.

### Part B: the DorkOS service (`apps/server/src/services/core/keep-awake/`)

```
apps/server/src/services/core/keep-awake/
  index.ts                     # barrel: keepAwakeService singleton, types
  keep-awake-service.ts        # owns KeepAwake + WakeScheduler, config, status, labels
  hold-during-turn.ts          # holdAwakeDuringTurns(runtime): the registry Proxy
  wake-arming.ts               # PR3: next approved run → scheduleWake, pre-run hold
  __tests__/
apps/server/src/routes/keep-awake.ts
```

**Service (`keep-awake-service.ts`):**

- A module-level singleton `keepAwakeService`, constructed eagerly with counting only (no holder) so the registry wrapper can count turns registered before boot finishes. `start({ config, eventFanOut, scheduler })` is called from `apps/server/src/index.ts` after the config manager and the scheduler exist; it reads `keepAwake.whileAgentsWork`, creates the package `KeepAwake` with `watchPid: process.pid`, and subscribes to config changes (`setEnabled` on toggle, no restart needed). `stop()` joins `shutdownServices()` (`index.ts:6277-6396`) and disposes the holder and cancels a pending wake.
- Hold kinds: `turn` (from the registry wrapper, carries `sessionId` and whether `opts.roomTurn` was set), `task` (from the scheduler, carries `runId` and `sessionId` once known), `wake` (PR3 pre-run window). Each is a package `Hold` plus a small record kept by the service for labeling.
- Status the server exposes (`KeepAwakeStatusSchema` in `packages/shared/src/schemas.ts`, exported through an existing `@dorkos/shared` subpath):

  ```ts
  {
    enabled: boolean; // keepAwake.whileAgentsWork
    supported: boolean;
    reason: 'container' | 'tool-missing' | 'denied' | 'platform' | null;
    asserted: boolean; // OS assertion in force right now
    working: {
      chats: number;
      rooms: number;
      tasks: number;
      waking: boolean;
    }
    wake: {
      // PR3; PR1 always { enabled:false, setup:'unsupported', nextWakeAt:null }
      enabled: boolean;
      setup: 'ready' | 'needed' | 'unsupported';
      nextWakeAt: string | null; // ISO
      setupCommand: string | null; // e.g. "dorkos power setup"
    }
  }
  ```

- **Counting invariant (the property, tested):** every unit of work appears in `working` exactly once. A task run counts as one task even while its turn is in flight; a turn whose session belongs to a held task run is not also a chat; a room turn (`opts.roomTurn` present) is a room; every other turn is a chat (interactive, relay delivery, agent-to-agent). A relay-dispatched task run must also count once (pin it with a test; if the run's session id is not known to the scheduler until the relay answers, the task hold records it when it learns it, and until then the label may briefly lag but the assertion is already held).
- **Idle ceiling (leak bound):** a `turn` hold whose generator has yielded nothing for 2 hours and whose runtime answers `isHelperWorking?.(sessionId) !== true` (`packages/shared/src/agent-runtime.ts:1645`) is released by a once-a-minute sweep with a `warn` log naming the session. This bounds the one leak the wrapper cannot see (a consumer that abandons the generator without `return()`). A ceiling release in production is a bug report, not a feature.
- Broadcasts `keep_awake_status` through `eventFanOut.broadcast` (the `tunnel_status` precedent at `index.ts:6209`) on every status change, coalesced to at most one event per 500 ms.

**The turn chokepoint: `holdAwakeDuringTurns` at `runtimeRegistry.register()`.**

- `apps/server/src/services/core/runtime-registry.ts:248` becomes `this.runtimes.set(runtime.type, holdAwakeDuringTurns(watchRuntimeSignin(traceRuntime(runtime))))`, outermost so the hold covers everything inside it. The comment above it already names this "the one seam every turn passes through — the interactive composer, a room reply, a scheduled run and a relay delivery" (DOR-1654), and `index.ts:2895-2915` routes the relay's runtimes back through the registry for exactly this reason.
- Same Proxy shape as `trace-runtime.ts:31-50`: intercept only `sendMessage`, pass every other member through bound to the real target. The wrapper is an `async function*`:

  ```ts
  async function* holdDuring(sessionId, opts, source) {
    const hold = keepAwakeService.holdTurn({ sessionId, room: opts?.roomTurn !== undefined });
    try {
      for await (const event of source) {
        hold.touch(); // feeds the idle ceiling
        yield event;
      }
    } finally {
      hold.release(); // completion, throw, return() (break / interrupt)
    }
  }
  ```

  The hold opens on the first `next()` (an async generator's body does not run before it), so a stream that is created and never consumed opens nothing. `holdTurn` and `touch` never throw (contained like `onSettled` at `trigger-turn.ts:986`), so the wrapper cannot break a turn.

- Background work: Claude Code background subagents keep the turn's stream open (`turn-liveness.ts:21-31`, `local_agent` holds the stdin), so they are inside this hold with no extra signal; background shells die with the turn's stdin. Nothing outlives the turn that needs holding.
- Rejected chokepoints and why: `triggerTurn`'s `.finally()` (`trigger-turn.ts:971-993`) misses task runs (`task-scheduler-service.ts:1531`) and relay deliveries (`packages/relay/src/adapters/claude-code/agent-handler.ts:580`, `task-handler.ts:442`); the projector lifecycle depends on an event that a crash or bug can drop.

**The task-run hold.** `TaskSchedulerService.executeRun` (`task-scheduler-service.ts:1107`) opens a `task` hold first thing and releases it in a `finally` around the whole body, so placement, provisioning and the relay or direct dispatch are all covered. The service learns the run's session id via `hold.attachSession(sessionId)` where the run gets one. The scheduler receives the service through its constructor deps (`index.ts:4210`), optional so existing tests need no change; absent means no hold.

**Codex second layer.** `buildCodexOptions` (`apps/server/src/services/runtimes/codex/codex-options.ts:66-99`) adds `features: { prevent_idle_sleep: true }` beside `mcp_servers` in `config` when `keepAwake.whileAgentsWork` is on and the environment is supported. It applies to Codex instances created after the setting changes (the setting takes effect for new conversations; the DorkOS hold covers the rest). A test pins the flattened flag the SDK emits. Verified on the installed binary (2026-10-05): `codex --config features.prevent_idle_sleep=true features list` reports `prevent_idle_sleep  experimental  true` (default `false`), and an unknown `features.*` key is accepted silently, so a future rename degrades to "no second layer" rather than a failed turn.

**Config (`packages/shared/src/config-schema.ts`, new top-level section beside `scheduler` at `:2415`):**

```ts
keepAwake: z
  .object({
    /** Hold the computer awake while any agent works; release when idle. */
    whileAgentsWork: z.boolean().default(true),
    /** Wake the computer shortly before each approved scheduled run (needs one-time admin setup on macOS and Linux). */
    wakeForScheduledTasks: z.boolean().default(false),
  })
  .default(() => ({ whileAgentsWork: true, wakeForScheduledTasks: false })),
```

- Both fields ship in PR1 as one whole top-level section. Per `adding-config-fields` ("Does conf cover your new field on its own? Only if it is a whole top-level section"), conf's top-level default merge writes a new section to every stored config, so **no `CONFIG_MIGRATIONS` entry is written**: an absence-guarded body would be unreachable. Adding `wakeForScheduledTasks` later as a nested leaf would need a migration whose key must be ≤ the version that ships it, while `0.98.0` already exists unreleased above `v0.97.0`; shipping the section whole avoids that trap. `wakeForScheduledTasks` is read by nothing until PR3; its TSDoc says so, and the Settings toggle for it appears only in PR3.
- Both defaults are declared twice (field and section literal) and must agree (the declared-twice rule at `:2421`).
- `CONFIG_DISCLOSURE`: both `expose` (an agent may know the computer stays awake). `CONFIG_WRITE_POLICY`: both `operator-only` (whether a machine sleeps or wakes itself is the person's call; the drift guard requires a verdict either way). Not an experiment: `wakeForScheduledTasks` defaults off because it needs admin and powers the machine up, not because it is unproven, so it does not go in `EXPERIMENTS`.
- Docs: `contributing/configuration.md` Settings Reference rows and `docs/getting-started/configuration.mdx`.

**HTTP and SSE surface:**

- `GET /api/keep-awake` → `KeepAwakeStatus` (above). Read-only, no auth beyond the app's normal session.
- `POST /api/keep-awake/wake/recheck` (PR3) → re-probes `setupState()` (bypassing the 60 s cache) and returns the status. Called by the client after the desktop setup completes or when the person says they ran the command.
- Settings writes use the existing `PATCH /api/config`.
- `keep_awake_status` event on `GET /api/events` (and its WebSocket mirror) with the same payload; add `'keep_awake_status'` to the client's `KnownEvent` union (`apps/client/src/layers/shared/model/event-stream-context.tsx`).
- Regenerate and commit the OpenAPI docs for the new route (the `openapi-fresh` check).

### Part C: late runs are honest, and the dedupe key is the occurrence (PR2)

**Proof of the bug (croner 10.0.1, run 2026-10-05 from `apps/server`):**

```js
// A blocked event loop stands in for a sleeping machine: croner's pending
// setTimeout cannot fire until the loop is free, exactly as after a wake.
const { Cron } = require('croner');
let fires = 0,
  expected = null;
const job = new Cron('* * * * * *', { protect: true }, (self) => {
  fires++;
  const cur = self.currentRun();
  console.log({
    fire: fires,
    intendedTick: expected,
    currentRun: cur,
    scheduledTickKey: new Date(Math.floor(cur.getTime() / 1000) * 1000),
  });
  expected = self.nextRun();
  if (fires === 2)
    setTimeout(() => {
      const t = Date.now() + 3600;
      while (Date.now() < t) {}
    }, 300);
  if (fires === 4) job.stop();
});
expected = job.nextRun();
```

```
fire 2: intendedTick 12:01:40.000  currentRun 12:01:40.002  scheduledTickKey 12:01:40.000
--- loop blocked 3.6s with croner timer pending (simulated sleep) ---
fire 3: intendedTick 12:01:41.000  currentRun 12:01:43.908  scheduledTickKey 12:01:43.000
fire 4: intendedTick 12:01:44.000  currentRun 12:01:44.000  scheduledTickKey 12:01:44.000
```

Croner source agrees: `_trigger` sets `currentRun = new CronDate(undefined, tz)` (now), and `_checkTrigger(target)` only checks `now >= target` before `schedule()` recomputes from now, so all but one missed tick vanish. Note `previousRuns(1, ref)` strips milliseconds and is strictly-before (at `12:01:40.003` it returned `12:01:39`), so it must be called with a reference rounded up, never with the raw fire instant.

**Verdict:** the key is the wall-clock minute (or second) of the fire, which equals the occurrence only on an on-time fire. The comment at `task-scheduler-service.ts:737-738` is wrong; the doc at `:121-131` is right about `currentRun()` but wrong to call the result "schedule-aligned". Consequences: late runs are recorded against a non-occurrence, and two processes firing the same late occurrence across a minute boundary claim different keys and both run.

**Design.** A pure module `apps/server/src/services/tasks/occurrence.ts`:

```ts
export interface Occurrence {
  /** The scheduled occurrence this fire stands for: the latest boundary at or before the fire instant. */
  intendedFor: Date;
  /** firedAt - intendedFor, ms. */
  lateByMs: number;
  /** Occurrences after the one croner was waiting for and before intendedFor that never fired. */
  missed: number;
  /** True when the run is too late to be worth running (policy below). */
  stale: boolean;
}
export function resolveOccurrence(
  job: Pick<Cron, 'nextRuns' | 'previousRuns' | 'nextRun'>,
  expected: Date | null,
  firedAt: Date
): Occurrence;
```

- `intendedFor` = `job.previousRuns(1, ceilToSecond(firedAt) + 1s)[0]`: the latest boundary at or before `firedAt`, computed in the job's own timezone by croner. On an on-time fire this is exactly `floor(firedAt)` at the cron's resolution, so **the dedupe key is byte-identical to today's for every on-time fire, and no `pulse_dispatch_log` migration is needed.**
- `expected` is the `nextRun()` the scheduler captured for that job at registration and after every fire (a per-job field next to `cronJobs`). `missed` = the number of boundaries in `[expected, intendedFor)`, counted with `nextRuns` and capped at 1000 (a per-second cron asleep for a day reports "1000+").
- **Staleness policy (recommended; Dorian may adjust, see Open Questions):** a fire is `stale` when `lateByMs > min(60 min, (nextBoundaryAfter(intendedFor) - intendedFor) / 2)`. Examples: every minute → stale after 30 s late; hourly → after 30 min; daily 09:00 → after 1 hour (opening the laptop at 09:40 runs it, at 11:00 records it as skipped). A fire is "late" (not stale) when `lateByMs >= 60 s`; below that it is on time (normal timer jitter is milliseconds).
- `dispatch(task, firedAt)` (`task-scheduler-service.ts:999`) calls `resolveOccurrence`, claims with `tickKey = intendedFor.getTime()` (`scheduledTickKey` is replaced by this; its doc moves to `occurrence.ts`), and records:
  - stale → a `skipped` run, `error` = the stale reason text, through the same claim path the cap skip uses (so it stays idempotent across processes).
  - otherwise → the usual `running` claim.
  - both carry `scheduledFor = intendedFor` and `missedTicks = missed`.
- The registration callback passes `new Date()` honestly named `firedAt` (`currentRun()` is the same value, but the name stops lying). The comment at `:737-738` and the "a tick that is missed is missed" doc at `:975-983` are rewritten to describe the new record.
- Manual and agent-triggered runs carry `scheduledFor = null`.

**Data model.** `pulse_runs` (`packages/db/src/schema/tasks.ts:191`) gains two nullable columns: `scheduled_for TEXT` (ISO 8601) and `missed_ticks INTEGER`. One drizzle SQL migration (`packages/db/drizzle/`), generated, not hand-written. `TaskRunSchema` (`packages/shared/src/schemas.ts:5244`) gains `scheduledFor: z.string().nullable().default(null)` and `missedTicks: z.number().int().nullable().default(null)` (the `resolvedRuntime` precedent). `claimScheduledRun` (`task-store.ts:808`) takes them in its outcome argument; `task-row-mappers.ts` maps them. Old rows read as null and render as before.

**UI (run history, `apps/client/src/layers/features/tasks/ui/TaskRunHistoryPanel.tsx`):** a late run shows "Ran 12m late" beside its start time; a stale skip shows "Skipped: this computer was asleep when it was due."; a run with `missedTicks > 0` shows "Missed 3 earlier runs while asleep." (pluralized; "1000+" when capped). No new activity-feed events (the existing "one record of a non-event is enough" rule at `:1068-1074` stands).

### Part D: wake for scheduled tasks (PR3)

**Which runs.** Only the scheduler leader arms wakes (`isLeader`, followers no-op, as `dispatch` does at `:1010`). The next wake target is the earliest `getNextRun(taskId)` (`task-scheduler-service.ts:872-876`) over tasks that are enabled, `status === 'active'` (approved), have a cron, with firing allowed (`mayFire`) and `scheduler.enabled` on.

**Arming (`wake-arming.ts`).** Wake at `nextRun - 60 s` (lead). Re-arm, debounced 1 s, on: server start; any task registered, unregistered or updated (the scheduler's existing register/unregister paths); every fire; `keepAwake.wakeForScheduledTasks` or `scheduler.enabled` changing; a detected wall-clock jump (a 30 s interval whose observed gap exceeds 90 s means the machine slept; re-arm). Skip arming when the target is more than 31 days out (the helper refuses it) and re-arm daily instead. On graceful shutdown cancel the pending wake: waking a computer whose DorkOS is not running does nothing useful.

**The pre-run window.** A `wake` hold opens at `nextRun - lead` (the server's own timer, which fires as soon as the machine wakes) and closes when that run's `task` hold opens or after 3 minutes, whichever is first. Without it a scheduled wake can fall back to sleep before croner's timer (chunked at 30 s, `W = 30 * 1e3` in croner) fires. While `wakeForScheduledTasks` is on, the `wake` and `task` holds for scheduled runs assert even if `whileAgentsWork` is off: waking the computer only to let it sleep mid-run is not a choice anyone makes.

**Setup state and flows.**

- Status `wake.setup`: `ready` / `needed` / `unsupported`, probed at start, on toggle, on `recheck`, and cached 60 s.
- Toggling "Wake for scheduled tasks" on when setup is `needed` saves the setting and shows the set-up row; nothing is armed until setup is `ready`.
- **Desktop (macOS):** the Set up button calls a new `setupWake()` method on the existing preload bridge (`contextBridge.exposeInMainWorld('electronAPI', …)`, `apps/desktop/src/preload/index.ts:77`; the button renders only when that method exists) → main-process IPC `power:setup-wake` (registered like `admin:restart-server` in `apps/desktop/src/main/admin/index.ts:34, 207-215`, gated by `isCockpitSender`, returning `{ ok: true } | { ok: false; message }`). Main imports `@dorkos/keep-awake` directly (Node-only, dependency-free), builds `createWakeScheduler({ user: os.userInfo().username }).setupPlan()`, and runs `osascript -e 'do shell script "<installScript>" with administrator privileges'`, which shows the standard macOS password dialog once. Cancel in the dialog returns `{ ok:false, message:'cancelled' }` and changes nothing. Then the client calls `POST /api/keep-awake/wake/recheck`.
- **CLI / browser:** the row shows the one command, `dorkos power setup`, with a copy button.
- **Windows:** no setup; `ready` as soon as the toggle is on.

**`dorkos power` (packages/cli).** Modeled on `packages/cli/src/commands/telemetry/telemetry.ts` (pure handlers with injected `{ io, spawn, env }`, a dispatcher, its own help text), added to `knownCommands` (`cli.ts:40-67`), intercepted before top-level `parseArgs` like `telemetry` (`cli.ts:362-367`), plus a help line.

- `dorkos power status`: prints the environment report, the wake setup state and the two settings. No server needed; reads config through the CLI's config store.
- `dorkos power setup`: prints what it will install and why (one paragraph), then runs `sudo sh -c '<installScript>'` with inherited stdio so sudo asks for the password in the terminal. Prints "Done." and the probe result. On Windows prints that no setup is needed. In a container prints why it cannot.
- `dorkos power setup --remove`: runs the remove script the same way.
- When the server starts with `wakeForScheduledTasks` on and setup `needed`, it logs one `info` line: "Wake for scheduled tasks needs one-time setup. Run: dorkos power setup".

### Part E: the app (client)

**Where it lives.** The per-chat status line is the wrong home: `status-bar-registry.ts:76-79` records that two machine-wide switches were removed from it because they "read as per-session but weren't", and keep-awake is machine-wide. It goes where the other machine-wide signals already live: the persistent top-bar cluster beside `<RemoteAccessBeacon />` (`AppShell.tsx:851-862`), and a line in the Control Center beside `UnattendedLine` (`ControlCenterBody.tsx:17-54`). (Flagged for Dorian, Open Questions.)

- New entity `apps/client/src/layers/entities/keep-awake/` (`api` via `transport`, `model/use-keep-awake.ts`: TanStack Query on `GET /api/keep-awake`, kept current by `useEventSubscription('keep_awake_status', …)` → `queryClient.setQueryData`). Add `getKeepAwake()` (and `recheckWake()` in PR3) to the `Transport` interface (`packages/shared/src/transport.ts`), `HttpTransport` and the mock transports.
- New widget `apps/client/src/layers/widgets/keep-awake/`: `KeepAwakeBeacon` (icon `Coffee` from lucide, same size and popover pattern as `RemoteAccessBeacon`, drawn only while `asserted` is true), mounted in `AppShell.tsx` after `<RemoteAccessBeacon />`. Its popover shows the status line, the caveat line and a "Sleep settings" link.
- Control Center: a `KeepAwakeLine` in `ControlCenterBody` after `UnattendedLine`, shown only while `asserted`.
- Settings: a `SleepSettings` card in the Tools tab next to `SchedulerSettings` (`apps/client/src/layers/features/settings/ui/tools/`), section anchor `sleep`, so links use `?settings=tools&settingsSection=sleep` (`use-dialog-deep-link.ts:42`). Writes through `transport.updateConfig({ keepAwake: { ...current, whileAgentsWork } })` like `ToolsTab.tsx:34-51`.
- Dev Playground: add the beacon (holding, waking, unsupported) and the Sleep card (each setup state) per the `maintaining-dev-playground` skill.

**Copy (every block ≤ 15 words, no "we", passes `pnpm check:copy-length`):**

| Where                          | Text                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| Settings card title            | Sleep                                                                         |
| Toggle 1 label                 | Keep this computer awake while agents work                                    |
| Toggle 1 description           | Stays awake during chats, rooms and tasks. Sleeps as usual when idle.         |
| Toggle 2 label (PR3)           | Wake for scheduled tasks                                                      |
| Toggle 2 description           | Wakes this computer a minute before each scheduled run.                       |
| Setup needed, desktop          | Needs your password once. · button: Set up                                    |
| Setup needed, browser/CLI      | Run this once in a terminal: `dorkos power setup`                             |
| Setup ready                    | Set up. · link: Remove (opens the `dorkos power setup --remove` instructions) |
| Wake, Windows                  | Best effort. Some laptops ignore wake timers on battery.                      |
| Caveat (under toggle 1)        | A closed lid on battery, or a low battery, still sleeps. Uses more battery.   |
| Unsupported: container         | Not available in a container.                                                 |
| Unsupported: tool missing      | Not available: this computer has no sleep control tool.                       |
| Unsupported: denied            | This computer refused the request to stay awake.                              |
| Beacon label / popover title   | Keeping awake: 2 chats running                                                |
| Mixed                          | Keeping awake: 1 chat, 1 room, 1 task                                         |
| Pre-run window (PR3)           | Awake for a scheduled run                                                     |
| Beacon link                    | Sleep settings                                                                |
| Control Center line            | Keeping this computer awake: 2 chats running.                                 |
| Run history, late (PR2)        | Ran 12m late                                                                  |
| Run history, stale (PR2)       | Skipped: this computer was asleep when it was due.                            |
| Run history, missed (PR2)      | Missed 3 earlier runs while asleep.                                           |
| Desktop prompt cancelled (PR3) | Setup cancelled. Nothing changed.                                             |
| Desktop prompt failed (PR3)    | Couldn't finish setup. · Details toggle with the raw message                  |

The beacon's accessible name: "Keeping this computer awake: 2 chats running. Open sleep settings". Counts pluralize ("1 chat", "2 chats"); zero-count kinds are omitted.

### Part F: docs

- New guide `docs/guides/keep-awake.mdx` ("Sleep and wake"), registered in `docs/guides/meta.json` under "Daily driving" after `operating-dorkos`. Written with `writing-for-humans`. Covers: what stays awake and when it sleeps again; the caveats (lid closed on battery, low battery, battery cost); containers and headless servers; wake for scheduled tasks, the one-time setup on Mac (password once in the desktop app, or `dorkos power setup`), what the setup installs and how to remove it; Windows and Linux are best effort (no claim that they work until verified on real installs, per the demo-claim gate).
- `docs/guides/task-scheduler.mdx`: a "Late and missed runs" section (the staleness rule in one sentence, what the run history shows) linking to the new guide.
- `docs/guides/cli-usage.mdx`: `dorkos power status|setup|setup --remove`.
- `docs/getting-started/configuration.mdx` + `contributing/configuration.md`: the two `keepAwake` rows.
- `packages/keep-awake/README.md` is not created (internal package; the TSDoc is the reference). AGENTS.md monorepo tree gains the package line.
- One changelog fragment per PR in `changelog/unreleased/`.

## User Experience

1. **Default, nothing to do.** Dorian starts a long refactor in a chat and walks away. The top bar shows a small cup; hovering says "Keeping awake: 1 chat running". The display sleeps on its normal timer; the Mac does not. When the turn ends, the cup disappears within 30 s and the Mac sleeps on its normal idle timer.
2. **A busy afternoon.** Two chats and a scheduled task run: "Keeping awake: 2 chats, 1 task". The Control Center shows the same line.
3. **Turning it off.** Settings → Tools → Sleep → off. The cup disappears at once; the count keeps running underneath, so turning it back on mid-turn takes effect immediately.
4. **Wake for scheduled tasks (desktop).** Toggle on → "Needs your password once." → Set up → the macOS password dialog → "Set up." From now on a 07:00 task runs at 07:00 with the lid open on power, even though the Mac was asleep at 06:59. Cancelling the dialog leaves everything as it was.
5. **Wake for scheduled tasks (CLI/browser).** Toggle on → "Run this once in a terminal: dorkos power setup" → Dorian runs it, types his password → the row turns to "Set up." after recheck.
6. **Waking late without the wake option.** Dorian opens the laptop at 09:40; the 09:00 daily report runs now and its history row says "Ran 40m late". Opening it at 11:00 instead records "Skipped: this computer was asleep when it was due."
7. **In Docker.** The Sleep card says "Not available in a container." and the toggles are disabled; the server logs one line at start.
8. **Error and exit paths.** Tool missing → card shows why, turns still run. Holder crashes → restarted once, then marked unsupported for this run of the server. Server crashes → the OS holder exits with it (`-w` / `--pid` / `Wait-Process`), so the computer is never held awake by a dead DorkOS.

## Testing Strategy

Each test carries a purpose comment and must be shown to fail when its subject is broken (delete or invert the guarded line and watch it go red, per `.claude/rules/testing.md`).

- **Unit, `packages/keep-awake` (PR1):**
  - Reference counting with an injected fake `spawn` and fake timers: two holds start exactly one holder; releasing one keeps it; releasing both starts the linger; a hold during the linger keeps the same holder (no second spawn); the holder stops only after `lingerMs`.
  - `release()` twice decrements once.
  - `setEnabled(false)` stops at once with count > 0; `setEnabled(true)` restarts at once.
  - caffeinate renewal spawns the new holder before killing the old one (assert ordering of fake spawn/kill calls), with `-i -w <pid> -t 300`.
  - Argument vectors for each platform holder (pid interpolated, no shell), Windows script contains `0x80000001` and `Wait-Process -Id <pid>`.
  - ENOENT → `supported:false, reason:'tool-missing'`, exactly one warn across many holds; early non-zero exit on Linux → `denied`; restart once, then give up within 60 s.
  - `detectEnvironment`: `/.dockerenv`, each cgroup marker, `env.container`, none.
  - `onChange` listener throwing does not break `hold`.
  - Wake: macOS `set`/`cancel` invoke `sudo -n <helper> set <epoch>`; a second `scheduleWake` cancels the first instant before setting; `setupState` maps `sudo -n -l` exit codes; Windows command strings; Linux `rtcwake` via helper.
  - Helper script (PR3): copy the generated script to a temp dir, rewrite its absolute tool path to a recording stub, run it under `sh`, and assert it rejects `set abc`, `set 1`, a past epoch, an epoch 32 days out, extra arguments, and accepts a valid one, formatting the date exactly `MM/dd/yy HH:mm:ss`.
  - Real-OS smoke, opt-in (`DORKOS_KEEP_AWAKE_LIVE=1`, macOS only, never in CI): hold, then assert `pmset -g assertions` lists a `PreventUserIdleSystemSleep` from caffeinate; release, wait past linger, assert it is gone.
- **Unit/integration, server (PR1):**
  - `holdAwakeDuringTurns`: hold opens on first `next()`, not on call; released on completion, on a thrown source, on consumer `return()` (break), and when the runtime's interrupt ends the generator; never-consumed stream opens nothing; a throwing service does not break the turn (events still flow).
  - Registry: `runtimeRegistry.register(fake)` then `get(type).sendMessage(...)` holds; prove each caller class goes through it: a `triggerTurn` turn, a room turn (`roomTurn` → counted as room), a scheduler direct run, and a relay `agent-handler` delivery with the registry-resolved runtime (fake runtimes from `@dorkos/test-utils`).
  - Counting invariant: a direct task run with an in-flight turn counts as 1 task, 0 chats; a relay-dispatched task run counts once.
  - Idle ceiling: fake timers; a hold idle for 2 h with `isHelperWorking` false is released with a warn; with `isHelperWorking` true it is kept.
  - Config toggle flips `setEnabled`; `GET /api/keep-awake` shape; `keep_awake_status` broadcast on change and coalesced.
  - Codex options: `buildCodexOptions` includes `features.prevent_idle_sleep: true` only when enabled and supported.
  - Config: `USER_CONFIG_DEFAULTS` includes the section; disclosure and write-policy guards green; the conf top-level merge writes the section into a stored config that lacks it (the skill's measured behaviour, asserted against the real store).
- **Unit, server (PR2):** `resolveOccurrence` table tests: on-time minute cron → `intendedFor === floor(firedAt)` and key identical to the old `scheduledTickKey` (backward-compat test across 5-field, 6-field, `@hourly`, and a non-UTC timezone across a DST change); late hourly fire 12 min late → late not stale, `missed` counted; 45 min late → stale; daily 09:00 at 09:40 → runs, at 11:00 → stale; per-second cron asleep a day → missed capped at 1000. Dispatch tests with fake timers jumping the system clock (croner reads `Date` and `setTimeout`): one late fire produces one row with `scheduledFor`, `missedTicks`; a stale fire produces a `skipped` row with the reason; two scheduler instances sharing one DB firing the same late occurrence at `hh:mm:59.9` and `hh:(mm+1):00.1` claim once (the regression test for the bug; it fails on today's code). Migration test: the new columns exist and old rows read null.
- **Unit, client:** beacon renders nothing when not asserted, renders the pluralized line, omits zero kinds, link sets `?settings=tools&settingsSection=sleep`; SSE event updates the cache; Sleep card toggles PATCH config, disabled with the right reason line when unsupported; each PR3 setup state renders its row; run-history copy for late, stale and missed.
- **CLI (PR3):** `dorkos power status|setup|setup --remove` with injected `spawn`/`io`: help text, container refusal, Windows "no setup needed", the exact `sudo sh -c` invocation.
- **Desktop (PR3):** the IPC handler rejects non-cockpit senders, maps an osascript cancel (exit 1, "User canceled") to `cancelled`, and passes the plan's install script verbatim.
- **E2E:** none required for PR1/PR2 (no user flow a unit test cannot reach). PR3 adds no browser test either: the password prompt cannot be driven headlessly.
- **Manual verification on a real Mac (the done-when, recorded in the PR):**
  - PR1: `pmset -g assertions` during a long turn shows caffeinate's `PreventUserIdleSystemSleep`; set the energy-saver idle sleep to 1 minute, start a 10-minute turn, let the display sleep, confirm in `pmset -g log | grep -E "Sleep|Wake"` that no idle sleep happened during the turn and that one did within the idle time after it ended.
  - PR3: with wake on and set up, schedule a task 10 minutes out, sleep the Mac (Apple menu → Sleep), leave it; `pmset -g log` shows the DorkOS wake, the run history shows the run on time with no "late" marker.
- **Mocking strategy:** OS tools only through the package's injected `spawn`; never spawn a real `caffeinate`, `pmset` or `sudo` in the default suite. Croner is real (it is the subject). Runtimes via `FakeAgentRuntime`.

## Performance Considerations

- The registry wrapper adds one generator hop per event and one `Date.now()` store; negligible next to the trace and sign-in wrappers already there.
- One holder process while working, renewed every 4 minutes on macOS (a ~5 ms spawn). Linger avoids spawn churn on back-to-back turns.
- Status broadcast coalesced to ≤ 2 per second.
- Wake arming: an O(tasks) scan, debounced, on change only; one `sudo -n` spawn per re-arm.
- Battery: holding the computer awake costs battery by design; the caveat line says so, and the setting is one click away from the beacon.

## Security Considerations

- **The admin grant is the sensitive part.** It lets the user's account set or cancel one wake event through a root-owned helper that validates every argument and calls one absolute-path tool. No shell interpolation of untrusted input anywhere: the epoch is digits-only and range-checked, the date is formatted by the helper itself, the sudoers rule names the helper path exactly and one user. `visudo -cf` validates before install; `/etc/sudoers` is never edited. Removal is one command. The helper and drop-in are root-owned in root-owned directories, so a process running as the user cannot swap the helper for something else.
- Holder processes run as the user, with argument vectors (no shell), `stdio: 'ignore'`, and are tied to the server's pid.
- Config writes are `operator-only`: an agent cannot turn wake on or keep-awake off through `config_patch`.
- The desktop IPC handler is gated by `isCockpitSender` like every admin channel, so only the app's own window can trigger the password prompt.
- The status endpoint exposes counts and a next-wake time, nothing about session content. The remote (tunnel) client sees the same status as the local one, which is fine; a remote client cannot trigger the desktop prompt (it is not the desktop window).

## Documentation

See Part F. Plus: TSDoc on every export (hard rule 4), comments explaining why the wrapper sits outermost in `register()`, why the hold opens on first `next()`, and why the dedupe key is the occurrence.

## Implementation Phases

Three PRs, each shipping something whole. PR2 does not depend on PR1 and may land first or in parallel; PR3 depends on both.

- **PR1: keep awake while agents work.** `packages/keep-awake` (holders, ref counting, environment detection, no wake), the server service and registry wrapper, the task-run hold, Codex `prevent_idle_sleep`, the `keepAwake` config section (both fields; only `whileAgentsWork` is read), `GET /api/keep-awake` + `keep_awake_status`, the top-bar beacon, the Control Center line, the Sleep card with toggle 1 and its caveat, the `docs/guides/keep-awake.mdx` guide (keep-awake half), config docs, a changelog fragment. Done when the PR1 real-Mac check passes.
- **PR2: late runs are honest.** `occurrence.ts`, the dedupe-key fix, the stale skip, the two `pulse_runs` columns + drizzle migration, `TaskRunSchema` fields, run-history copy, the scheduler comments rewritten, `task-scheduler.mdx` "Late and missed runs", a changelog fragment. Done when the cross-boundary double-claim regression test fails on `main` and passes on the branch.
- **PR3: wake for scheduled tasks.** Package `wake/` adapters + helper + setup plan, `wake-arming.ts` with the pre-run window and clock-jump re-arm, `POST /api/keep-awake/wake/recheck`, toggle 2 and its setup rows, `dorkos power status|setup|setup --remove`, the desktop `power:setup-wake` IPC + preload method, the guide's wake half, CLI docs, a changelog fragment. Done when the PR3 real-Mac check passes. Windows and Linux wake ship labeled best effort.

## Open Questions

1. **Staleness threshold for late runs (needs Dorian).** (A) Run late only when under one hour late and less than halfway to the next occurrence (a daily 09:00 report runs if the laptop opens by 10:00) — **recommended**: simple to explain, never doubles up with the next run, and never acts on a world that moved on hours ago. (B) Halfway to the next occurrence with no cap (a daily 09:00 report still runs at 20:59). The constant lives in `occurrence.ts` either way; this is a one-line change.
2. **Where the indicator lives (needs Dorian).** The issue says "status-bar indicator", but the chat status line is per session and machine-wide switches were deliberately removed from it (`status-bar-registry.ts:76-79`). (A) A top-bar cup beside the remote-access globe, drawn only while holding, plus a Control Center line — **recommended**: visible on every route, machine-wide by placement. (B) A `diagnostics` item in each chat's status line: shows only inside a chat and repeats the same machine-wide fact in every one.
3. ~~Which turns count, and where is the chokepoint?~~ (RESOLVED) **Answer:** a Proxy at `runtimeRegistry.register()` (`runtime-registry.ts:248`) plus a task-run hold in `executeRun`. **Rationale:** the registry is already the seam every caller uses (DOR-1654), including the scheduler and the relay, which bypass `triggerTurn`.
4. ~~Does a turn waiting on a person's approval keep the computer awake?~~ (RESOLVED) **Answer:** yes, it is a turn in flight; bounded by the approval timeouts that already exist and by the 2-hour idle ceiling. **Rationale:** with remote access on, the person may approve from a phone, which needs the computer awake.
5. ~~Release immediately or linger?~~ (RESOLVED) **Answer:** 30 s linger. **Rationale:** room bursts and task chains start a new turn within seconds; flapping the assertion buys nothing.
6. ~~How is the one-time admin grant done?~~ (RESOLVED) **Answer:** a root-owned validating helper plus a one-rule sudoers drop-in, installed via the desktop password prompt or `dorkos power setup`. **Rationale:** least privilege that works on every sudo and on Linux; alternatives compared in Part A.
7. ~~Is a config migration needed?~~ (RESOLVED) **Answer:** no; `keepAwake` is a whole new top-level section, which conf writes on its own. **Rationale:** the `adding-config-fields` skill measured this; an absence-guarded body would be unreachable.
8. ~~Should wake runs hold the computer awake when "keep awake" is off?~~ (RESOLVED) **Answer:** yes, scheduled runs hold while wake is on. **Rationale:** waking a computer only to let it sleep mid-run is not a choice anyone would make.
9. ~~Does `missed` need a row per missed tick?~~ (RESOLVED) **Answer:** no, one count on the run that did fire. **Rationale:** one record of a non-event is enough (the existing rule at `task-scheduler-service.ts:1068-1074`); a per-second cron would otherwise write thousands of rows after a night asleep.
10. ~~Rely on Claude Code's own caffeinate helper?~~ (RESOLVED) **Answer:** no. **Rationale:** its flags and whether it runs under the SDK are not observable from the stripped binary; DorkOS's own hold covers every runtime the same way.

## Related ADRs

- ADR-285 (scheduler leader lock and dispatch idempotency): PR2 changes what the idempotency key is, not the mechanism.
- ADR-0255 / ADR-0310 (runtime registry and per-runtime sessions): the chokepoint sits at the registry's registration seam.
- ADR `260728-112203` (merge queue) and the `adding-config-fields` rules govern landing.
- ADR candidates for `/adr:from-spec` after implementation (not written in this stage): (1) keep-awake is one server-owned OS-tool mechanism for desktop and CLI, no `powerSaveBlocker`; (2) the wake admin grant is a validating root helper plus a per-user sudoers rule; (3) scheduled-run identity is the intended occurrence, with a staleness rule for late fires.

## References

- Linear DOR-2718.
- croner 10.0.1 source: `node_modules/.pnpm/croner@10.0.1/node_modules/croner/dist/croner.js` (`_trigger`, `_checkTrigger`, `schedule`, `W = 30 * 1e3`).
- `man pmset` (SCHEDULED EVENT ARGUMENTS: `pmset schedule [cancel | cancelall] type date+time [owner]`, date `"MM/dd/yy HH:mm:ss"`), `man caffeinate`, `man sudoers`, `man visudo`.
- `systemd-inhibit(1)`, `rtcwake(8)`.
- Microsoft: `SetThreadExecutionState` (ES_CONTINUOUS 0x80000000, ES_SYSTEM_REQUIRED 0x00000001), `New-ScheduledTaskSettingsSet -WakeToRun`.
- Electron `powerSaveBlocker` docs (considered and rejected); KeepingYouAwake (MIT); Codex `utils/sleep-inhibitor` (`features.prevent_idle_sleep`, experimental in 0.154.0).
