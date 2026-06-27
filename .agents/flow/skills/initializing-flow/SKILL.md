---
name: initializing-flow
description: First-run setup for the /flow engine in a new repo - detect or reconfigure an existing install, gather setup choices (tracker + connection, identity mode, project routing) via the calibration ladder, generate and verify the concrete tracker adapter, scaffold the committed config.json plus the gitignored config.local.json, and confirm the install with a dry dispatch. Use when running /flow:init, configuring flow for the first time, adopting a new tracker, or reconfiguring an existing flow install.
---

# Initializing Flow - first-run setup

> **What this is.** The one-time setup procedure an adopter (or `/flow:init`)
> follows to make `/flow` runnable in a repo: pick a tracker, generate the
> concrete **adapter** that lets the generic engine speak to it, scaffold the
> config triad, and confirm the install. After this runs clean, every
> `/flow:<stage>` command and the autonomous loop work against your tracker with
> no further wiring.
>
> **This is a prose procedure, not code.** The agent reads this skill and follows
> it. `/flow:init` is a thin trigger over it.

## The one rule: stay tracker-neutral until the adapter exists

Setup never names a tracker API, a tool string, or a tracker-specific field. The
**only** tracker-aware artifact this procedure produces is the generated adapter
under `.agents/flow/skills/<tracker>-adapter/`. Everything else you touch (the
config triad, the dispatch check) stays generic. When you need adapter-generation
detail, read the `building-adapters` skill
(`.agents/flow/skills/building-adapters/SKILL.md`); it owns the generate-and-verify
contract. This skill owns the **setup orchestration** around it.

## Calibration: ask when a human is present, default when headless

Setup choices are gathered by the calibration ladder. When a human is at the
terminal, ask with `AskUserQuestion` (one question per choice, with the safe
option pre-marked). When running headless (no interactive terminal, or a
non-interactive trigger), do **not** block: apply the sane default for each
choice, record the assumption in your setup report, and proceed. Setup is
reversible (re-run with `/flow:init` to change anything), so headless defaults are
safe to apply silently. The one exception is Step 4's clobber guard, which always
confirms before overwriting committed config.

---

## Process

```
  1 DETECT     does a valid config.json already exist?  (fresh vs re-run)
  2 GATHER     tracker + connection · identity mode · project routing
  3 ADAPTER    generate the concrete adapter, then validate until green (the gate)
  4 CONFIG     write config.json (committed) + config.local.json (gitignored secrets)
  5 CONFIRM    dry dispatch on an empty queue → "/flow is ready"
```

### Step 1 - Detect: fresh install or re-run

Check whether `.agents/flow/config.json` exists and parses as valid JSON
(`node -e "require('./.agents/flow/config.json')"` exits `0`).

- **No file, or invalid JSON → fresh install.** Proceed to Step 2 with defaults
  seeded from the committed `config.json` template if one is present, otherwise
  from schema defaults.
- **Valid file exists → re-run (reconfigure).** Do **not** clobber it silently.
  Tell the operator `/flow` is already configured (name the current `tracker` and
  `identity.agent`), and ask whether to **reconfigure** (re-gather choices and
  rewrite), **regenerate the adapter only** (skip Steps 2 and 4, jump to Step 3),
  or **cancel**. Headless re-run defaults to **cancel** (never rewrite committed
  config without a human), and reports that it stopped because a valid config
  already exists.

Also confirm the toolchain is present: `node` is on PATH and
`scripts/validate-adapter.mjs` exists (it is the Step 3 gate). If either is
missing, stop and say so plainly rather than proceeding to a setup that cannot be
verified.

### Step 2 - Gather setup choices (the calibration ladder)

Three choices drive the rest of setup. Gather them with `AskUserQuestion`
interactively, or apply the headless default.

1. **Tracker + connection.** Which tracker, and how the adapter reaches it. Offer:
   - your tracker via an **in-session MCP server** (an authenticated MCP server
     exposes tracker tools the agent calls directly),
   - your tracker via an **external CLI** (a CLI bridges to the tracker when no
     in-session MCP server is available),
   - a different tracker (for example a generic issue tracker) via **MCP**,
   - a different tracker via **CLI or REST**,
   - **other / from scratch**.

   This choice picks the adapter's **transport** and its closest reference
   starting point in Step 3 (an MCP transport resembles the MCP reference
   adapter; a CLI or REST transport resembles the CLI/REST reference adapter;
   see `.agents/flow/adapters/SPEC.md` and the reference adapters under
   `.agents/flow/adapters/reference/`). Capture the tracker's short name (used as
   `<tracker>` in the adapter path and the `tracker` config field) and the
   connection/account handle the adapter authenticates through.
   _Headless default: keep the template's `tracker` value and its matching
   reference transport._

2. **Identity mode.** Whether the agent shares the human's tracker account or has
   its own (charter G10). Offer:
   - **Shared account**: the agent acts as the human's account. Set
     `identity.agent` to `"auto"` (resolved at runtime via the adapter's
     current-user read) and rely on the identity `marker` so the agent never
     answers its own comments.
   - **Two-account**: the agent has its own tracker account. Set `identity.agent`
     to the agent's account handle.

   In both modes, capture the human **reviewer** handle for the review-gate
   handoff (it lands in `config.local.json`, since a real handle is machine/account
   specific). _Headless default: shared account (`identity.agent: "auto"`),
   reviewer left unset (the review gate falls back to a comment that mentions the
   human)._

3. **Project routing.** What the engine claims and routes by default. This maps to
   `ownership.scope`. Offer:
   - **Issues only**: claim and run individual work items (`["issues"]`).
   - **Issues and projects**: also treat a project as a claimable/dispatchable
     unit (`["issues", "projects"]`).

   Project-scoped narrowing at runtime (for example `/flow auto <project>`) works
   regardless of this default via the adapter's project-resolution read; this
   choice only sets what the loop sweeps by default. _Headless default:
   `["issues", "projects"]` (the template default)._

Record each chosen value and each headless assumption; they feed Steps 3 and 4
and the final report.

### Step 3 - Generate and verify the adapter (the gate)

Hand off to the `building-adapters` skill and follow it to produce the concrete
adapter for the chosen tracker. In brief:

1. Read `.agents/flow/adapters/SPEC.md` (the contract) and pick the closest
   reference adapter for the transport chosen in Step 2 (or from-scratch for a
   tracker no reference fits).
2. Generate the adapter as a skill into
   `.agents/flow/skills/<tracker>-adapter/SKILL.md`, mapping the tracker onto the
   generic `WorkItem` model and all 16 capability verbs, with the durability and
   graceful-degradation notes the SPEC requires.
3. Build a representative fixture and run the conformance gate until it is green:

   ```bash
   node scripts/validate-adapter.mjs --fixture <path-to-your-fixture.json>
   ```

   Exit code `0` with `{ "ok": true }` is the pass. A nonzero exit names the
   failed invariant (`INV-1 .. INV-5`); fix the **mapping** that produced it in the
   adapter and re-run. **Do not advance to Step 4 until the verdict is green**: an
   unverified adapter is the failure mode `building-adapters` exists to prevent.

If the chosen tracker already has a conforming adapter (the "regenerate" or
re-run path), re-validate it against the current contract version rather than
regenerating from scratch, and only regenerate if validation fails.

### Step 4 - Scaffold the config triad

Write the two config files. The triad and its precedence are documented in
`.agents/flow/CONFIG.md`; honor it.

1. **`config.json`** (committed, no secrets). Set the resolved behavioral policy
   from Step 2: `tracker` (the chosen tracker's short name), `identity.agent`
   (`"auto"` for shared, the agent handle for two-account), and `ownership.scope`
   (the project-routing choice). Leave every other field at its template/schema
   default. **Never write a token, API key, or account handle into this file**:
   the schema is strict and credential-free by design. On a re-run, only rewrite
   this file after the Step 1 confirmation; never overwrite committed config
   silently.

2. **`config.local.json`** (gitignored, secrets + per-machine overrides). Create
   it from the template if it does not already exist:

   ```bash
   test -f .agents/flow/config.local.json || cp .agents/flow/config.local.example.json .agents/flow/config.local.json
   ```

   Fill in `secrets.trackerAccount` (the connection/account handle from Step 2)
   and, when the host does not already supply tracker auth, `secrets.trackerToken`.
   Put the human reviewer handle under `identity.reviewer` here. Delete any
   template block you do not need. If an existing `config.local.json` is present,
   merge the new values in rather than overwriting the operator's other overrides.

3. **Confirm the ignore.** Verify the repo `.gitignore` already ignores the local
   file (`grep -q 'config.local.json' .gitignore`). It does in this repo; if a
   future adopter's `.gitignore` lacks it, surface that loudly: a committed
   credential file is the one outcome setup must never allow.

### Step 5 - Confirm the install

Prove the wiring end to end with a dry dispatch against an empty queue:

```bash
node scripts/dispatch.mjs
```

A clean, no-work outcome (the dispatcher reaches the adapter, finds nothing
eligible, and returns a no-work result without error) confirms the adapter,
config, and credentials all resolve. A throw or an auth error here means a
connection or credential gap: point the operator at the specific file
(`config.local.json` for credentials, the generated adapter for transport) rather
than reporting success.

On a green dry dispatch, tell the operator `/flow` is ready: name the configured
tracker, the identity mode, the project-routing scope, and the entry points
(`/flow` to orchestrate, `/flow:<stage>` for a single stage, `/flow auto` for the
autonomous drain). Surface any headless assumptions you applied so the operator
can change them with another `/flow:init`.

---

## Idempotency and safety

- **Re-runnable.** Running `/flow:init` again never clobbers committed config
  without the Step 1 confirmation; a headless re-run defaults to cancel.
- **The verify gate is non-negotiable.** Step 3 does not complete until
  `validate-adapter.mjs` returns green. Setup that skips the gate ships an adapter
  that "looks right" but may not conform.
- **No secret ever lands in a committed file.** Credentials live only in
  `config.local.json` (gitignored) or a `FLOW_`-prefixed environment variable.
- **Honest failure.** If the toolchain is missing (Step 1), the adapter cannot be
  verified (Step 3), or the dry dispatch errors (Step 5), stop and say exactly
  what is wrong and which file to fix. Never report `/flow` as ready on an
  unverified or unreachable setup.

## References

- `.agents/flow/CONFIG.md` - the config triad, precedence, and the secrets/policy
  split.
- `.agents/flow/skills/building-adapters/SKILL.md` - the generate-and-verify
  procedure Step 3 invokes.
- `.agents/flow/adapters/SPEC.md` - the tracker-neutral adapter contract the
  generated adapter conforms to.
- `.agents/flow/config.json` / `.agents/flow/config.local.example.json` - the
  committed policy template and the local-secrets template Step 4 scaffolds from.
