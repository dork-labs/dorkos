# DorkOS notes — 0.61.0, Aug 17

About 90 minutes on the Mac app and the npm build, plus a Flow install. Claude was reading logs
and source alongside me the whole way, so some of this is more precise than I'd get solo.

Ordered by what I'd fix first. Repro steps where I have them, and a section at the end for what I
couldn't verify.

---

## Fixed since 0.58.0

Worth saying first, because three of my Aug 11 notes are closed:

- **Approvals are reachable now.** The tool-approval prompt renders inline in the session with
  Approve / Always Allow / Deny, and `Heads up → agent › Waiting on you` shows in the sidebar. On
  Aug 11 a real permission request rendered nowhere I could get to and auto-denied itself at 10:00.
- **The engaged window announces itself.** `stopped replying here — this back-and-forth hit its
automatic-reply limit`. Before, it lapsed silently and I posted into a dead room.
- **`relay_send_and_wait` fails fast.** It used to hang the full 10 minutes, three times in a row,
  and abort the turn. Now it returns `ACCESS_DENIED` in seconds with a reason.

---

## Blockers

### 1. `/flow:init` recommends a tracker its own schema rejects

`/flow:init` probed my machine, found no Linear reachable, and recommended **GitHub Issues via
`gh`**. It generated a complete GitHub adapter and passed the conformance gate first try. Then:

```
scripts/config-schema.ts:32
tracker: z.enum(['linear'])
```

`"github"` can't validate. The recommended path is unconfigurable without editing plugin source.

The only workaround is widening that enum in both `config-schema.ts` and the generated
`config/config.schema.json` — which a plugin update overwrites, at which point the config silently
stops validating. My install is in that state now.

Related: `flow.md` says _"All tracker I/O routes through the `linear-adapter` skill."_ The
PM-agnostic framing is real in the architecture and not yet true in the shipped code.

### 2. Mac app reports Claude Code missing when it's installed and signed in

`GET /api/system/requirements` returns `missing` for both `Claude Code CLI` and
`Claude Code authentication`. Both probes pass by hand:

```
claude --version          → 2.1.233 (Claude Code)     0.6s
claude auth status --json → {"loggedIn": true, ...}    0.3s
```

Same on the copy bundled in the app. Same machine, same `~/.dork`, one minute later, npm-run
0.61.0 reports **both satisfied**. Only the packaging differs.

Where I think it goes: `resolveClaudeBinaryPath()` is
`resolveBundledClaudeBinary() ?? findBinaryOnPath('claude')`, and `resolveBundledClaudeBinary()`
never consults `DORKOS_CLAUDE_CLI_PATH` — only `resolveClaudeBinaryFromEnv()` does, and the
readiness ladder doesn't call it. So the first branch returns an `app.asar` path and the PATH
fallback never runs.

**Caveat, and I'd trust the repro over my theory:** I never saw the spawn fail, because of #3. And
the asar header marks that binary `"unpacked": true`, which should make Electron redirect. So the
packaging is definitely the variable; the mechanism might not be what I said.

### 3. The CLI probe throws its own error away

`checkCliBinary`'s `catch {}` drops the spawn error. Nothing is logged anywhere, so `missing` is
the only signal a user or you ever gets. This is what makes #2 undebuggable from outside.

### 4. `Install Claude` / `Try again` is a silent no-op

Both clicks show in the log:

```
POST /runtimes/claude-code/provision → 404
POST /runtimes/claude-code/provision → 404
```

`routes/runtimes.js` has `/opencode/provision` and `/codex/provision`. No `claude-code` route. The
404 never surfaces, so the button just does nothing.

---

## Relay

### 5. The agent-facing docs teach a subject format the ACL can't match

This is the one I'd fix first in the mesh. `relay-helpers.js:15` says deny/allow rules match on
`relay.agent.{ns}.{id}`. But every instruction the agent actually reads omits `{ns}`:

- `context-builder.js:87, 93, 104, 110` — the system prompt: `relay_send_and_wait(to_subject="relay.agent.{theirAgentId}", …)`
- `relay-tools.js:383, 443, 472` — the tool schema `.describe()` strings: `e.g., "relay.agent.{agentId}"`

So an agent that follows its own documentation addresses a subject no allow rule can match, falls
through to the blanket `<self> → * deny`, and is refused. Repro: two fresh agents, grant
`a → b` in Team → Access, ask a to relay. Denied. Hand it the full
`relay.agent.b.<id>` and it works immediately.

Same root cause as the missing `keep.` segment DorkBot found via `mesh_inspect` back in February.
`routes/relay.js:88` still parses what a comment calls "the legacy shape," so I'd guess the format
grew a segment, routing learned both, and the ACL layer and the docs didn't.

### 6. A target's error comes back to the caller as a successful empty answer

When the target agent's turn died, the caller got:

```json
{ "reply": { "type": "agent_result", "text": "", "done": true }, "progress": [] }
```

with a real `replyMessageId`. The failure was an upstream `API Error: 500` — Anthropic's, not
yours, it hit four unrelated sessions of mine in the same two minutes. Not reporting that as a bug.

The bug is that a caller can't tell "answered nothing" from "crashed." You render the error
correctly inside the target's own session; it just doesn't cross the relay boundary. That's
survivable when I'm watching and a silent no-op on an unattended schedule.

### 7. A fresh mesh is fully disconnected and nothing says so

Every agent lands in its own namespace named after itself, with a built-in `<self> → * deny`. Two
agents created in the same app, in the same minute, can't talk until I hand-add a rule in
Team → Access → Allow Cross-Project Access, two dropdowns at a time.

Deny-by-default is the right call. Shipping the headline feature off, with nothing surfacing it
during setup or agent creation, isn't. You find out when an agent hits the wall mid-task. Also
scales badly: 5 agents is 20 grants.

### 8. Relay tool schemas are deferred, and the agent pays for it

Its own words: _"I'll need to search for the mesh_list and relay tool schemas since they're
deferred."_ That's a round trip on every agent-to-agent call, against a 3-minute timeout.

---

## Smaller

### 9. Codex is missing from the Mac app's requirements payload

`/api/system/requirements` returned only `claude-code` and `opencode` in the Mac app, but the UI
still drew a Codex card. npm-run 0.61.0 returns Codex and reports it satisfied (`codex-cli 0.147.0`).

### 10. `Ignoring the project copy of X` warnings, still printed twice

hello-world, linear-issues, marketplace. Same as Aug 11. Plus an extension shutdown/re-init loop
right after boot.

### 11. `aggregateSessionList` degrades on every Mac-app boot

`runtime listing degraded … Access denied: path outside directory boundary`.

### 12. The install dialog gives a file count with no paths

`134 files will be created, modified, or deleted`, and it can't be undone without an uninstall.
Disclosing the hook command verbatim is a genuine improvement over Aug 11. But a count without a
location isn't consent, and the one thing I'd want before approving a delete is exactly what's
missing. (For what it's worth I checked afterward and everything stayed inside `~/.dork`.)

### 13. The marketplace buries your own packages

298 packages, 289 of them plugins, nearly all mirrored from `claude-plugins-official`. Your nine
DorkOS-native ones are in there somewhere. Search saved me; browsing wouldn't have.

### 14. Flow ships without `node_modules` and its own validator can't run

Needed `npm install --include=dev` for prettier+zod. My shell carries `NODE_ENV=production` and
`omit=dev`, so it had installed nothing. That install reported **3 high-severity vulnerabilities**
in the dev deps.

### 15. Adversarial review is on by default and points at a file that can't be created

`REVIEW.md` scaffolding needs `git rev-parse --show-toplevel`, which fails outside a repo, so the
reviewer silently runs generically instead of against the rubric.

### 16. Step 5's dry dispatch reads like a connectivity test

It returned `{"picked":[],"eligibleCount":0,"starved":false}` and looked like a green light.
`dispatch.ts` is a pure policy oracle taking items on stdin and never touches a tracker. Your own
agent caught this and flagged it, which is the only reason I didn't misread it.

---

## Things that are better than they need to be

- **The instance-lock error.** Named the pid, the port, the version, and three ways out. Better
  than most shipped software.
- **A hook blocked your own plugin's script from reading my secrets file**, mid-run, and the agent
  respected it and re-validated by key names only. A security control that fired against its
  author's code.
- **`/flow:init` probed before it offered.** It checked what was actually reachable on my machine
  instead of listing all three trackers blindly, recommended `gh` on a stated security property
  (per-call identity), and named the Notion MCP problem unprompted: _"an MCP server acts as whoever
  OAuth'd it, with no per-call account flag … /flow silently writes as the wrong user."_ Then it
  offered **"Decide later"** with the exact consequence spelled out. That's how a setup wizard
  avoids pointing something at production.
- **The agents kept out-reporting the UI.** Three separate times. One diagnosed its own
  `ACCESS_DENIED`, named both namespaces and the rule, and gave me the click path. One refused to
  trust its own passing gate — _"it passed first try, which made me suspicious, so I proved the
  harness bites"_ — and then failed a bad fixture on INV-3. And it listed four explicit guesses it
  hadn't verified, and set `autonomy.default: "manual"` on its own initiative because no repo was
  wired, flagging that as its call rather than something I asked for.

That last one is the thing. The cockpit is not what sold me; the agents inside it are.

---

## What I didn't verify

- The `app.asar` mechanism in #2. Packaging is proven by the repro, the mechanism is a theory, and
  #3 is why I can't close it.
- Whether any of #2/#4 actually blocks starting a conversation in the Mac app. I switched to npm
  instead of pushing on it.
- The 3 high-severity vulns in #14. Saw the count, didn't look.
- Flow end to end. Config, adapter and conformance gate are done; no repo wired, so no work item
  ever moved a stage. I stopped there rather than run it against a plugin I'd hand-patched.
- Anything about Codex. Never exercised it.
