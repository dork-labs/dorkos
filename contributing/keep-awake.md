# Testing keep-awake on a real Mac

`@dorkos/keep-awake` (`packages/keep-awake/`) holds the computer awake while agents work. On macOS the holder is one `/usr/bin/caffeinate -i -w <server pid> -t 300` process, replaced every 240 seconds, stopped 30 seconds after the last hold is released. The server wires it up in `apps/server/src/services/core/keep-awake/`; the user-facing story is `docs/guides/keep-awake.mdx`.

The unit tests drive the engine with a fake spawner, so they prove the bookkeeping, never that macOS agrees. This guide covers the two checks that do: an automated smoke you can run in seconds, and four scenarios a person runs by hand.

## Before you start: other apps mask the result

`pmset` reports every assertion on the machine, not only ours. ChatGPT holds its own idle-sleep assertion for hours, video calls and media players hold theirs, and `powerd` prevents idle sleep while the display is on. Any of them can keep the Mac awake when DorkOS has let go, which looks like DorkOS working when it is not.

Quit ChatGPT and anything playing media before a manual scenario, then list what is left:

```bash
pmset -g assertions | grep -E 'PreventUserIdleSystemSleep|NoIdleSleepAssertion'
```

You should see nothing but `powerd`'s display assertion ("Prevent sleep while display is on", which goes away when the display sleeps), the count line at the top, and holders you know about.

## The automated smoke

```bash
pnpm --filter @dorkos/keep-awake smoke
```

`src/__tests__/caffeinate.smoke.test.ts` starts a throwaway owner process, takes a hold through the real package API with the owner as the watched pid, and reads `pmset -g assertions`:

1. **Hold:** a `PreventUserIdleSystemSleep` assertion appears, held by the caffeinate pid the engine spawned, on behalf of the owner pid.
2. **Release:** after the linger (50 ms in the test) the holder exits and the assertion is gone.
3. **Owner dies:** a second hold, then `SIGKILL` on the owner. `caffeinate -w` ends the assertion within milliseconds.

It only looks at assertions made on behalf of its own owner pid, so other apps cannot mask it. Cleanup kills every process it started that has not ended, through the handle that started it, pass or fail. The owner also exits on its own within a second of its parent dying, so even a killed test run leaves nothing holding the Mac. Expected output, about half a second end to end:

```text
[smoke] hold → asserted by caffeinate pid 69587 in 14 ms
[smoke] release → assertion gone in 130 ms
[smoke] owner killed → assertion gone in 13 ms; holders spawned after the kill: 31
```

The last number is a known engine quirk, not a test failure. A dead owner makes each new caffeinate exit 0 at once, and the engine reads exit 0 as its `-t` running out and starts another, until `dispose`. DOR-2919 fixes the engine to treat an early exit 0 as "owner gone"; once it lands, the count should be 0. In DorkOS the server watches its own pid, so the engine dies with the owner and this never happens either way.

The script refuses to run anywhere but macOS. The test itself is gated on `DORKOS_KEEP_AWAKE_SMOKE=1` and `process.platform === 'darwin'`; everywhere else, `pnpm test` included, it is collected and skipped. No turbo task passes the variable through, so CI cannot arm it.

**Why it is not in CI.** The only macOS jobs are `desktop-smoke.yml` and the release workflows. `desktop-smoke.yml` rebuilds native modules for Electron's ABI and says in its header never to add a test step to that job, and a new macOS job would spend the scarcest runner minutes on a check that changes only when `packages/keep-awake/` does. Run it by hand when you change the holder or the engine's lifecycle.

## Manual scenarios

Run these against a real install (`dorkos` or the desktop app) that only you are using, with the computer's own sleep settings untouched. Each one needs two terminal windows.

**Setup** — name the server's port explicitly (no default: the operator's own app may be on 4242), and find its pid:

```bash
export DORKOS_PORT=<the port of the server you are testing>
SERVER=$(lsof -ti :$DORKOS_PORT -sTCP:LISTEN)
[ -n "$SERVER" ] && echo "server pid $SERVER" || echo "no server on :$DORKOS_PORT; stop here"
```

**Watch window** — this server's holder and what the server says about it:

```bash
watch -n5 "pmset -g assertions | grep -B1 'Process ID $SERVER '; curl -s localhost:$DORKOS_PORT/api/keep-awake"
```

No `watch`? `while true; do clear; pmset -g assertions | grep -B1 "Process ID $SERVER "; curl -s localhost:$DORKOS_PORT/api/keep-awake; sleep 5; done`.

**After the fact** — sleep and wake events, and every holder caffeinate started:

```bash
pmset -g log | grep -E '^\S+ \S+ \S+ +(Sleep|Wake|DarkWake) ' | grep -v 'Wake Requests'
pmset -g log | grep caffeinate
```

Note your sleep timers first (`pmset -g custom`): the `sleep` value for battery and for power tells you when the Mac should sleep once DorkOS lets go.

**A long turn.** Claude Code's Bash tool stops a command after 2 minutes by default and 10 at most, so `sleep 900` would end the turn early. Ask instead: "Keep working for 15 minutes: run `sleep 540` with a 10-minute timeout, twice, then reply." Scenarios A and C use this.

### A. Plain turn on battery

1. Unplug. Start a long turn.
2. Walk away; do not touch the keyboard or trackpad.
3. Come back after 20 minutes and read the sleep log.

Expect no `Sleep` line while the turn ran, and one about the battery `sleep` timer after it ended (plus the 30-second linger). Glance at the watch window before you leave and when you return: `"asserted":true` should hold for the whole turn, across the gap between the two `sleep` commands.

### B. Background helper outlives its turn

1. On power, ask an agent to start a 10-minute background helper (a subagent that runs `sleep 540` with a 10-minute timeout) and end its reply.
2. Watch the status.

Today this shows `"asserted":false` about 30 seconds after the reply ends, while the helper is still working: background helpers are not held yet. When that is fixed, `"asserted":true` should stay until the helper finishes.

### C. Closed lid

1. On power, no external display. Start a long turn and confirm `"asserted":true` in the watch window.
2. Close the lid for one minute, then open it.

Expect a `Sleep` line at the moment the lid closed. `caffeinate -i` prevents idle sleep only; it cannot stop lid sleep. Clamshell mode (power, external display and keyboard) is the one case where the Mac stays awake with the lid closed, and that is macOS, not DorkOS.

### D. Recovering from "denied"

This leaves the server unable to keep the Mac awake until it recovers or restarts. Never point it at a server someone else is using.

1. Start a long turn so a holder is running.
2. Kill this server's holder twice within a minute, by its pid only (the `${SERVER:?…}` refuses to run when no server was found):

   ```bash
   kill $(pgrep -f "^/usr/bin/caffeinate -i -w ${SERVER:?no server on this port} -t ")
   # wait for the replacement to show in the watch window, then run the kill line again
   ```

Today the second unexpected exit marks keep-awake unsupported (`"supported":false,"reason":"denied"`) for the life of the server: the setting greys out and only a restart brings it back. A fix in flight makes it retry with backoff instead. Note what the status and the Settings switch show, and whether it recovers on its own or only after a restart.
