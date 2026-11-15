---
title: 'Safety Hooks outside Claude Code: what fires today and the smallest way to make it fire'
date: 2026-11-14
type: internal-architecture
status: active
tags: [safety-hooks, hooks, runtimes, codex, opencode, doe, runtime-parity, DOR-4379]
---

# Safety Hooks outside Claude Code

DOR-4379. The Safety Hooks package (`dork-labs/marketplace`, `plugins/safety-hooks`) says it guards
agents against `git stash`, `pkill` and similar commands. That is only true in Claude Code. This
report records what each runtime does today, proves what Codex sends a hook, and proposes the
smallest change per runtime. It is proof and design only: no product code changed.

## Summary

| Runtime            | Guard fires today?  | Why                                                                                                                                     | Smallest way to make it fire                                                                          |
| ------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Claude Code        | **Yes**             | Reads the projected `PreToolUse` hooks natively                                                                                         | Nothing                                                                                               |
| Codex              | **No, in practice** | Gets `.codex/hooks.json`, and the payload and blocking work, but Codex runs a hook only after a person trusts it, and nothing trusts it | DorkOS supplies the guard hooks per thread **and** their trust (to verify), or surfaces "not trusted" |
| OpenCode           | **No**              | Declarative hooks are dropped: OpenCode has no hooks file                                                                               | Run the package's `Bash` hooks from DorkOS's existing permission seam                                 |
| Dork runtime (Doe) | **No**              | No hooks executor                                                                                                                       | Same, from Doe's `beforeToolCall` approval seam                                                       |

## The guard contract

Both guards (`git-guard.mjs`, `process-guard.mjs`) read one JSON payload on stdin:

- They exit 0 (allow) unless `payload.tool_name === 'Bash'`.
- They inspect `payload.tool_input.command`.
- They block by writing a reason to stderr and exiting **2**.
- Bad input fails open (exit 0).

Any runtime that hands them a Claude-shaped payload and treats exit 2 as "refuse" gets their full
behaviour unchanged.

## Codex: payload proof (free, real binary)

**Setup:** the pinned `codex-cli 0.163.0` binary, run as `codex exec`.

- Throwaway `CODEX_HOME` and `HOME`; the project is marked trusted in the throwaway config.
- A fake Responses model on 127.0.0.1 calls `exec_command` once.
- No key, nothing billed.

**Hooks:** `.codex/hooks.json` holds a `PreToolUse` group with `matcher: "Bash"` and two command
hooks: a logger that saves its stdin, and the real `git-guard.mjs` or `process-guard.mjs` from the
package. The fake model asks to run `git stash; touch ran-marker.txt` (or `pkill -f …; touch
ran-marker.txt`), so the marker file shows whether the command ran.

| Case                                                                                     | Hook ran | Command ran | What the model got back                                          |
| ---------------------------------------------------------------------------------------- | -------- | ----------- | ---------------------------------------------------------------- |
| A. `git stash`, hook trust bypassed (`--dangerously-bypass-hook-trust`)                  | yes      | **no**      | `Command blocked by PreToolUse hook: Blocked: git stash …`       |
| B. `git stash`, hooks not trusted (the normal case)                                      | **no**   | yes         | the command's own output                                         |
| C. `pkill`, trust bypassed                                                               | yes      | **no**      | `Command blocked by PreToolUse hook: Blocked: pkill / killall …` |
| D. `git stash`, hooks passed as a `-c hooks.PreToolUse=[…]` config override, not trusted | **no**   | yes         | the command's own output                                         |
| E. Same as D, trust bypassed (control)                                                   | yes      | **no**      | blocked, as in A                                                 |

The exact stdin Codex sent the hook (A; C differs only in the command):

```json
{
  "session_id": "…",
  "turn_id": "…",
  "transcript_path": "…/codex-home/sessions/…/rollout-….jsonl",
  "cwd": "…/proj",
  "hook_event_name": "PreToolUse",
  "model": "fake-model",
  "permission_mode": "bypassPermissions",
  "tool_name": "Bash",
  "tool_input": { "command": "git stash; touch ran-marker.txt" },
  "tool_use_id": "call_probe"
}
```

**What this settles:**

- **Payload:** Codex sends `tool_name: "Bash"` and `tool_input.command`, exactly where the guards
  look. The guards need no change for Codex.
- **Blocking:** a hook's exit 2 blocks the call, and its stderr reaches the model as the reason.
- **Trust gate:** this is the blocker. A hook that has not been trusted never runs (B), and hooks
  supplied as a config override are held to the same gate (D). Codex records trust per hook as a
  `trusted_hash` in its hook state.
- **Environment:** `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_ROOT` are not set under Codex. That is
  fine for the package: the projector already rewrites `${CLAUDE_PLUGIN_ROOT}` to the absolute
  install path, and the `${CLAUDE_PROJECT_DIR:-$(git rev-parse …)}` fallback still finds the
  project.

**What it does not settle:**

- It ran `codex exec`, not the `app-server` DorkOS uses. The hook engine is shared, but an
  app-server run is the next probe.
- Whether DorkOS can supply hook **trust** in the per-thread config it already sends (a
  `hooks.state.<key>.trusted_hash` override). If it can, that is the smallest Codex fix. The key
  format and hash are not yet known.

**DorkOS's own Codex approval channel is not a substitute.** `item/commandExecution/requestApproval`
only arrives when Codex escalates out of its sandbox. An in-workspace `git stash` under
workspace-write runs without asking, and Full (`danger-full-access`, approval `never`) never asks.

## OpenCode

**Today:** hooks are dropped by design: OpenCode "has no declarative hook config (only a code-based
TypeScript plugin API), so hooks cannot be projected as files"
(`packages/harness/src/plan/hooks-projection.ts`, contract HK-03).

**The seam already exists.**

- DorkOS's sidecar config sets `permission.bash: 'ask'` (`opencode/server-manager.ts`), so every
  shell command raises a `permission.asked` event carrying `metadata.command`.
- `enforceApprovals` (`opencode/messaging/approvals.ts`) answers it, and it already runs a check
  before the mode is looked at: `protectedFileVerdict` refuses protected files even under
  `bypassPermissions`.

**Smallest fix:** a command-guard check beside `protectedFileVerdict`.

- For a `bash` permission, run the installed package's `PreToolUse`/`Bash` command hooks with a
  Claude-shaped payload (`tool_name: 'Bash'`, `tool_input.command`).
- Exit 2 answers `reject`, with the hook's stderr as the reason.
- This keeps the package's scripts as the single source of truth and covers every mode, Full
  included.

**Alternative:** an OpenCode plugin using `tool.execute.before`. It is not used anywhere in DorkOS
today, it would put DorkOS code inside the sidecar, and it adds nothing the seam above doesn't
already give.

## Dork runtime (Doe)

**Today:** no hooks executor.

**The seam:**

- Every tool call passes through `beforeToolCall` (`packages/doe/src/pi-engine.ts`), which calls
  `DoeApprovals.callback` (`apps/server/src/services/runtimes/doe/approvals.ts`).
- That callback already denies protected paths before its `bypassPermissions` auto-allow, so it
  runs in every mode.
- Doe's shell tool is `shell` with `{ command }`, not `Bash`.

**Smallest fix:** the same command-guard check, placed before the `bypassPermissions` allow.

- Map `shell` to the Claude-shaped `Bash` payload.
- Exit 2 returns `'deny'`.

## One shared piece

OpenCode and Doe can share one server-side **hosted hook runner**:

- **Input:** the agent's project, the tool's command, the session's cwd.
- **Read:** the installed hook config the harness already merges for that project. Only
  `PreToolUse` command hooks whose matcher is `Bash`; the same rule decides for Doe's `shell`.
- **Run:** each hook with the Claude-shaped payload, a timeout, and the project as cwd.
- **Answer:** refuse on exit 2. Allow on 0, and on any other exit (Claude Code's rule); log it.

This follows the protected-paths pattern already shared across runtimes
(`apps/server/src/services/runtimes/shared/policy/`). Codex keeps its native hooks once trust is
solved. The runner could also back Codex's escalation channel, but that channel doesn't see most
commands, so it is not the Codex answer.

**Ordering note:** for OpenCode and Doe the guard must run before any mode auto-approve, exactly as
the protected-file checks do, or Full mode bypasses it.

## Saying so where the person turns it on (Security's rule)

A runtime where the guard doesn't fire must say so where the person installs the package or turns
the runtime on, never only in a README. The harness already knows this: the plan emits a `drop` for
OpenCode hooks with a reason. Proposal:

1. **At install:** the install preview lists, per runtime the person's agents use, whether the
   package's hooks will run ("Runs in Claude Code. Doesn't run for agents on OpenCode or the Dork
   runtime yet."). It is built from the plan's hook `drop` lines, not hand-written.
2. **At turn-on:** when an agent is switched to a runtime where an installed hook package doesn't
   fire, the runtime picker shows the same line.
3. **Codex until trust is solved:** "Installed, but Codex runs it only after you trust it." Once
   DorkOS can supply trust, the line goes away.
4. **As each runtime gains the hosted runner,** its line flips to "runs", backed by a probe test
   that refuses `git stash` and `pkill` on that runtime (the ticket's Done-when).

## Proposed order

1. **Install and turn-on notices** (Security's rule). Small, and true today.
2. **Hosted hook runner for OpenCode and Doe.** Both seams exist. Test: a probe call matching each
   guard is refused, in every mode including Full.
3. **Codex:**
   - Probe the app-server path.
   - Probe a trust override in thread config.
   - If trust can be supplied, ship it for DorkOS-installed packages only. That is a Security
     decision, because it pre-approves code a person didn't trust in Codex.
   - If it can't, keep the notice and offer the person a one-step "trust in Codex" instruction.

## Evidence

The probe script and both outputs (A–C, D–E) are kept under
`/Volumes/ext-ssd-1/dork-os/evidence/2026-11-14-safety-hooks-probe/`.
