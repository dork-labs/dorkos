# Testing keep-awake on a real Mac

`@dorkos/keep-awake` (`packages/keep-awake/`) holds the computer awake while agents work. On macOS the holder is one `/usr/bin/caffeinate -i -w <server pid> -t 300` process, replaced every 240 seconds, stopped 30 seconds after the last hold is released. The server wires it up in `apps/server/src/services/core/keep-awake/`; the user-facing story is `docs/guides/keep-awake.mdx`.

The unit tests drive the engine with a fake spawner, so they prove the bookkeeping, never that macOS agrees. This guide covers the two checks that do: an automated smoke you can run in seconds, and four scenarios a person runs by hand.

## Before you start: other apps mask the result

`pmset` reports every assertion on the machine, not only ours. ChatGPT holds its own idle-sleep assertion for hours, video calls and media players hold theirs, and `powerd` prevents idle sleep while the display is on. Any of them can keep the Mac awake when DorkOS has let go, which looks like DorkOS working when it is not.

Quit ChatGPT and anything playing media before a manual scenario, then list what is left:

```bash
pmset -g assertions | grep -E 'PreventUserIdleSystemSleep|NoIdleSleepAssertion'
```

Only `powerd`'s "Prevent sleep while display is on" should remain, and that one goes away when the display sleeps.

## The automated smoke

```bash
pnpm --filter @dorkos/keep-awake smoke
```

`src/__tests__/caffeinate.smoke.test.ts` starts a throwaway owner process, takes a hold through the real package API with the owner as the watched pid, and reads `pmset -g assertions`:

1. **Hold:** a `PreventUserIdleSystemSleep` assertion appears, held by the caffeinate pid the engine spawned, on behalf of the owner pid.
2. **Release:** after the linger (50 ms in the test) the holder exits and the assertion is gone.
3. **Owner dies:** a second hold, then `SIGKILL` on the owner. `caffeinate -w` ends the assertion within milliseconds.

It only looks at assertions made on behalf of its own owner pid, so other apps cannot mask it. It kills every pid it started, pass or fail. Expected output, about half a second end to end:

```text
[smoke] hold → asserted by caffeinate pid 69587 in 14 ms
[smoke] release → assertion gone in 130 ms
[smoke] owner killed → assertion gone in 13 ms; holders spawned after the kill: 31
```

The last number is not a failure. A dead owner makes each new caffeinate exit 0 at once, and the engine reads exit 0 as its `-t` running out and starts another, until `dispose`. In DorkOS the server watches its own pid, so the engine dies with the owner and this never happens. The count is printed so it stays visible.

The test is gated on `DORKOS_KEEP_AWAKE_SMOKE=1` and `process.platform === 'darwin'`. Everywhere else, `pnpm test` included, it is collected and skipped. No turbo task passes the variable through, so CI cannot arm it.

**Why it is not in CI.** The only macOS jobs are `desktop-smoke.yml` and the release workflows. `desktop-smoke.yml` rebuilds native modules for Electron's ABI and says in its header never to add a test step to that job, and a new macOS job would spend the scarcest runner minutes on a check that changes only when `packages/keep-awake/` does. Run it by hand when you change the holder or the engine's lifecycle.

## Manual scenarios

Run these against a real install (`dorkos` or the desktop app), with the computer's own sleep settings untouched. Each one needs two terminal windows.

**Watch window** — what DorkOS holds and what it says about it:

```bash
PORT=${DORKOS_PORT:-4242}
watch -n5 "pmset -g assertions | grep -A2 caffeinate; curl -s localhost:$PORT/api/keep-awake"
```

No `watch`? `while true; do clear; pmset -g assertions | grep -A2 caffeinate; curl -s localhost:$PORT/api/keep-awake; sleep 5; done`.

**After the fact** — sleep and wake events, and every holder caffeinate started:

```bash
pmset -g log | grep -E '^\S+ \S+ \S+ +(Sleep|Wake|DarkWake) '
pmset -g log | grep caffeinate
```

Note your sleep timers first (`pmset -g custom`): the `sleep` value for battery and for power tells you when the Mac should sleep once DorkOS lets go.

### A. Plain turn on battery

1. Unplug. Ask an agent to run `sleep 900` in Bash (a 15-minute turn).
2. Walk away; do not touch the keyboard or trackpad.
3. Come back after 20 minutes and read the sleep log.

Expect no `Sleep` line while the turn ran, and one about the battery `sleep` timer after it ended (plus the 30-second linger). The watch window shows `"asserted":true` during the turn.

### B. Background helper outlives its turn

1. On power, ask an agent to start a 10-minute background helper (a subagent that runs `sleep 600`) and end its reply.
2. Watch the status.

Today this shows `"asserted":false` about 30 seconds after the reply ends, while the helper is still working: background helpers are not held yet. When that is fixed, the assertion should stay until the helper finishes.

### C. Closed lid

1. On power, no external display. Start a 5-minute turn.
2. Close the lid for one minute, then open it.

Expect a `Sleep` line at the moment the lid closed. `caffeinate -i` prevents idle sleep only; it cannot stop lid sleep. Clamshell mode (power, external display and keyboard) is the one case where the Mac stays awake with the lid closed, and that is macOS, not DorkOS.

### D. Recovering from "denied"

1. Start a long turn so a holder is running.
2. Kill the holder twice within a minute, by its pid only:

   ```bash
   SERVER=$(lsof -ti :$PORT -sTCP:LISTEN)        # the DorkOS server's pid
   kill $(pgrep -f "/usr/bin/caffeinate -i -w $SERVER") # its holder, nobody else's
   # wait for the replacement to show in the watch window, then run the kill line again
   ```

Today the second unexpected exit marks keep-awake unsupported (`"supported":false,"reason":"denied"`) for the life of the server: the setting greys out and only a restart brings it back. Note what the status and the Settings switch show, and whether a restart clears it.
