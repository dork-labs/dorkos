# Two-Desktop Community acceptance

Two people, each with their own packaged DorkOS app, go through the whole
member journey on two self-hosted Communities: joining, connecting, talking,
agents, restarting, leaving, being removed. It is the packaged-app check for
DOR-2182 and DOR-2186.

It is a script you run on purpose, not a test suite. It builds and launches
real apps and uses Docker, so it does nothing unless you set
`DORKOS_TWO_DESKTOP_ACCEPTANCE=1`. `pnpm test`, `pnpm verify` and CI never
set that variable, and none of them run this folder. The only part they run
are the unit tests in `__tests__/`: the script refuses to start without the
variable, refuses an unsafe handoff file, never starts anything in remote
mode, and accounts for every step.

## What you need

- A Mac with Apple Silicon. The script launches the unsigned
  `apps/desktop/release/mac-arm64/DorkOS.app`. On another machine, point
  `DORKOS_TWO_DESKTOP_APP` at a packaged DorkOS executable.
- Docker, running.
- Google Chrome, for the people's browsers. Set
  `DORKOS_TWO_DESKTOP_BROWSER_CHANNEL=` (empty) to use Playwright's own
  Chromium instead.
- A workspace that has had `pnpm install`.

No model and no API key. Every agent reply comes from DorkOS's scripted test
runtime, so a run costs nothing.

## Run it

```bash
DORKOS_TWO_DESKTOP_ACCEPTANCE=1 caffeinate -i \
  pnpm --filter @dorkos/e2e community-two-desktop -- --build
```

`--build` builds the Desktop app and the Community server, packages the app
(`electron-builder --dir`), then puts the native modules back for system Node
(`pnpm rebuild better-sqlite3 node-pty`). Leave it off to reuse a build you
already have. A full run takes about four minutes after the build.

| Variable                               | Default                                 | What it does                                                                                                                                               |
| -------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DORKOS_TWO_DESKTOP_ACCEPTANCE`        | unset                                   | Must be `1`, or the script refuses to run                                                                                                                  |
| `DORKOS_TWO_DESKTOP_BUILD`             | unset                                   | `1` works the same as `--build`                                                                                                                            |
| `DORKOS_TWO_DESKTOP_APP`               | the macOS arm64 build in `apps/desktop` | Which packaged executable to launch                                                                                                                        |
| `DORKOS_TWO_DESKTOP_PG_CONTAINER`      | unset: a throwaway Postgres container   | Use an existing Postgres container instead. The script creates and drops only its own databases there, and stops the container again if it had to start it |
| `DORKOS_TWO_DESKTOP_OUT`               | `.temp/community-two-desktop` (repo)    | Where each run's evidence folder goes                                                                                                                      |
| `DORKOS_TWO_DESKTOP_HOME_ROOT`         | the system temp folder                  | Where the two people's temporary homes are created (keep it outside the repo)                                                                              |
| `DORKOS_TWO_DESKTOP_KEEP_HOMES`        | unset                                   | `1` keeps the temporary homes, to look into afterwards                                                                                                     |
| `DORKOS_TWO_DESKTOP_BROWSER_CHANNEL`   | `chrome`                                | Playwright browser channel. Empty means bundled Chromium                                                                                                   |
| `DORKOS_TWO_DESKTOP_COMMUNITY_HANDOFF` | unset                                   | The absolute path of a held live community's `handoff.json`. Runs in remote mode (see below)                                                               |

## What it proves

A owns "Desktop Proof" and invites B. A also owns "Isolation Proof", which B
never joins. Each person has their own app, with its own home, data, local
server and window.

| Step   | What happens                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1-4    | A sets up both Communities in a browser. B joins Desktop Proof from an invitation and sees "You're in Desktop Proof."                            |
| 5-9    | Both apps start in their own homes. Each connects through the real approval step in the browser: signed out for A, signed in for B               |
| 10-13  | The switcher moves both people into #general. They post, reply in a thread and share a file, and the file arrives byte for byte                  |
| 14-15b | Nothing from the Community shows up in "this DorkOS". Reopening the channel lands where the reader left off, including a row they scrolled up to |
| 16     | Posts in Isolation Proof never reach Desktop Proof or B                                                                                          |
| 17-18  | The switcher works by keyboard (⌘⇧K, arrows, Enter, Escape) and at phone width                                                                   |
| 19     | Neither app looks up a Community room in its local rooms                                                                                         |
| 20     | Each person picks an agent from their own app only. The Community allows one agent per member, and B's second agent is refused                   |
| 21     | A private channel shows up only for its member. B can't read it and can't add an agent to it                                                     |
| 22     | A mentions B's agent. B's app answers with the scripted test reply, and both people see it                                                       |
| 23     | B's app quits and relaunches mid-journey. The connection, switcher order, saved spot and agent all survive, and B reopens where they were        |
| 24     | An owner can't leave without handing over ownership. Ownership goes from A to B and back                                                         |
| 25     | "Disconnect…" in the Manage menu ends only this app's connection and removes its agents there. B stays a member and can connect again            |
| 26     | "Leave space…" opens the Community's own page. Once B confirms there, B's app loses access, and A is unaffected                                  |
| 27     | An expired invitation is refused and lets no one in                                                                                              |
| 28     | B rejoins and connects again. A removes B, and B's app loses access cleanly while A's apps keep working                                          |
| 29     | Step 19's check again, now including the private channel                                                                                         |

Some checks are product contracts, where a failure is the product's fault
rather than the script's. When one fails, the run still finishes every step,
records the check under `findings` with `"kind": "product-bug"` and how to
reproduce it, and ends with outcome `FAIL-PRODUCT-CONTRACT` and exit code 1.
Other findings are observations: they are recorded, and the outcome reads
`PASS-WITH-FINDINGS`.

## Run against a held live community

The Community live gate can make a real community and keep it alive for a
while (`DORKOS_COMMUNITY_LIVE_HOLD_MINUTES`, see
`specs/community-self-host-launcher/04-live-gate.md`). While it holds, it
writes a `handoff.json` and prints only that file's path. Point this script at
it to run the member journey on that community:

```bash
DORKOS_TWO_DESKTOP_ACCEPTANCE=1 \
DORKOS_TWO_DESKTOP_COMMUNITY_HANDOFF=/path/printed/by/the/gate/handoff.json \
caffeinate -i pnpm --filter @dorkos/e2e community-two-desktop
```

The handoff holds two passwords, so the script refuses to start unless it is
a regular file with mode `0600`, in a folder with mode `0700`, and has every
field:

```json
{
  "origin": "https://…",
  "communityId": "…",
  "channelId": "…",
  "owner": { "email": "…", "password": "…" },
  "member": { "email": "…", "password": "…" },
  "inviteLink": "https://…"
}
```

The origin must be https. The only exception is an address on this machine
(`127.0.0.1`, `localhost`), which is how a local dry run tries remote mode out.

In remote mode the script starts no Postgres and no Community server. A is
the handoff's owner and B its member, who is already in. B signs in on the
live community first, and the script photographs the sign-in page and the
channel at desktop width and at phone width (390 x 844), before anything is
typed. Then it runs steps 5-7, 9-15b, 17-20, 22, 23 and 25. Step 20 adds one
agent each and leaves the community's agent limit alone, and its name in the
receipt says the limit was not tested.

Every other step appears in `receipt.json` as `"skipped": "remote-mode"`, with
the reason:

| Step       | Why it is skipped                                                               |
| ---------- | ------------------------------------------------------------------------------- |
| 1-3        | The live gate already set up the community and brought the member in            |
| 4, 8, 16   | They need a second community, and remote mode starts none                       |
| 21         | It needs a private channel, which the gate's community does not have (DOR-2186) |
| 24, 26, 28 | They change membership on a community the gate still needs (DOR-2182)           |
| 27         | It expires an invitation in the database, which a remote run cannot reach       |
| 29         | It repeats step 19 after steps 21 and 24-28, none of which ran                  |

A run that ends with a step neither run nor listed fails, so a step cannot drop
out quietly.

To retry, run the script again while the gate still holds. The channel keeps
every earlier run's messages, so each run marks its own messages with a stamp,
looks at the newest end of the channel rather than the whole feed, and reads
the channel's full history through the app when it needs a message's details.

Cleanup removes only what the run made: each app's agent enrollments and
connections (which revokes that app's grant on the community), then both apps
and their temporary homes. It never deletes the community, its channels or the
two accounts; the gate does that when its hold ends. The receipt records
`"mode": "remote"` and the community's host name. The passwords, both email
addresses and the invite are replaced with `[redacted]` in `steps.log`,
`receipt.json`, each app's network and console logs, and the `FAIL-*-aria.yml`
snapshots, and no screenshot is named after any of them. Screenshots are not
redacted: one can show a person's email address, for example in the app's
account menu, but never a password (password fields are masked, and the
sign-in page is photographed before anything is typed). Keep a remote run's
folder to yourself.

If cleanup cannot undo something it made, the run exits 1, the receipt says
`"cleanupFailed": true`, and an outcome that would have been `PASS` or
`PASS-WITH-FINDINGS` becomes `FAIL-CLEANUP`.

To try remote mode without a live community, start a local one with this
script's own `infra.ts`, make an owner and a member in a browser, and write
the handoff by hand into a fresh `0700` folder with mode `0600`.

## Evidence

Each run writes `run-<timestamp>/` under the output folder:

- `steps.log`: every step with PASS or FAIL and how long it took.
- `receipt.json`: the outcome, the commit, the evidence from each step, the
  findings, and what cleanup did.
- `screenshots/`: at least one screenshot per step, plus `FAIL-*` shots of both
  apps and every browser when a step fails.
- `person-a-network.log`, `person-b-network.log`: each app's Community
  requests and failures. `*-console.log`: warnings and errors.
- `private/`: the Community server logs and uploaded files. Keep this folder
  to yourself.

## Cleanup

The script cleans up after itself on success and on failure. It closes both
apps, stops the two Community servers it started (by their process IDs), drops
the databases it created, removes its throwaway Postgres container (or stops a
borrowed one it started), and deletes the temporary homes. `receipt.json` lists
what it did under `cleanup`.

Stopping a run with Ctrl-C or `kill` (SIGINT or SIGTERM) runs the same
cleanup, then exits with code 130 and outcome `INTERRUPTED` in the receipt. Press Ctrl-C again to abandon cleanup.

Only a run that can't clean up (SIGKILL, a crash, a power cut) leaves things
behind. The throwaway container and its volume are labelled, and
`scripts/sweep-ephemeral-docker.sh` removes them on the next run. The temporary
homes are `dorkos-two-desktop-homes-*` folders in the system temp folder. With
a borrowed container, drop any leftover `two_desktop_*` databases by hand. The
two Community servers (`apps/community/dist-server/main.js`) and the two DorkOS
apps may also still be running. Stop those by their process IDs, never by name,
because other people's copies may be running on the same machine.
