# Marketplace 05 — Bootstrap & Phase 8 Smoke Test Runbook

**Created:** 2026-04-07
**Status:** One-shot operator runbook (not a recurring guide)
**Spec:** [02-specification.md](./02-specification.md) · [04-implementation.md](./04-implementation.md)

This runbook closes the loop on marketplace-05 by bootstrapping the
`github.com/dork-labs/marketplace` registry repo with the seed content
and running the Phase 8 manual smoke tests against real Claude Code
and DorkOS binaries.

The recurring "how to add a package to the marketplace" reference lives
in [`contributing/marketplace-registry.md`](../../contributing/marketplace-registry.md)
— this file is the one-time bootstrap procedure only.

## Prerequisites

- [x] Spec marketplace-05 fully implemented and merged to `main`
- [x] Empirical CC validator verification done (CC 2.1.92)
- [x] Seed fixture passes `claude plugin validate` locally
- [x] `gh repo create dork-labs/marketplace --public ...` (empty repo
      created on GitHub, no README/LICENSE/.gitignore)
- [x] `main` pushed to `origin/main`

## Step 1 — Copy the seed to a fresh location

The seed lives at `packages/marketplace/fixtures/dorkos-seed/` in the
dork-os repo. To make it the **root** of the new `dork-labs/marketplace`
repo, copy it to a sibling directory outside the dork-os tree (so it
gets a fresh git history, not a subset of dork-os's history).

Pick whichever destination matches your `~/code` layout. Example uses
`~/code/dork-labs-marketplace`:

```bash
cp -R /Users/doriancollier/Keep/dork-os/core/packages/marketplace/fixtures/dorkos-seed ~/code/dork-labs-marketplace
cd ~/code/dork-labs-marketplace

# Sanity check — should show .claude-plugin/, plugins/, and README.md
ls -la
ls -la .claude-plugin/
ls plugins/
```

You should see:

- `.claude-plugin/marketplace.json`
- `.claude-plugin/dorkos.json`
- `plugins/code-reviewer/`, `plugins/security-auditor/`, ... (8 directories)
- `README.md`

## Step 2 — Initialize git and commit

```bash
cd ~/code/dork-labs-marketplace

git init -b main
git add .
git commit -m "$(cat <<'EOF'
Initial marketplace bootstrap (marketplace-05 seed)

Same-repo monorepo layout:
- .claude-plugin/marketplace.json — CC-standard registry (8 plugins)
- .claude-plugin/dorkos.json — DorkOS extension sidecar
- plugins/<name>/ — stub package directories with .claude-plugin/plugin.json
  + README.md (+ skills/SKILL.md for agent-typed plugins)

Verified against `claude plugin validate` (CC 2.1.92) before push.
See dork-labs/dorkos spec marketplace-05-claude-code-format-superset
and ADRs 0236-0239 for the format design rationale.
EOF
)"
```

## Step 3 — Add the remote and push

```bash
cd ~/code/dork-labs-marketplace

git remote add origin git@github.com:dork-labs/marketplace.git
git push -u origin main
```

If you used HTTPS instead of SSH when creating the repo, swap the
remote URL:

```bash
git remote add origin https://github.com/dork-labs/marketplace.git
```

## Step 4 — Verify the live registry

Once the push lands, run these from anywhere — they confirm the live
raw URLs work and the validators see the new content.

```bash
# DorkOS-side: validate the live remote (runs the current working-tree CLI source)
cd /Users/doriancollier/Keep/dork-os/core
pnpm --filter './packages/cli' exec tsx src/cli.ts marketplace validate https://github.com/dork-labs/marketplace
```

> Why `--filter './packages/cli' exec tsx` instead of `pnpm tsx`, `pnpm dorkos`, or `pnpm --filter dorkos`?
>
> - `tsx` is a devDependency of `packages/cli` (and `apps/server`, `apps/site`),
>   **not** the workspace root — so `pnpm tsx …` from the repo root fails with
>   `Command "tsx" not found`.
> - `pnpm dorkos marketplace …` resolves to the globally-installed `dorkos`
>   binary, which may be out of date (missing the `marketplace validate`
>   subcommand added in marketplace-05) and whose bundled `better-sqlite3` may
>   be compiled for a different Node ABI than the one you currently have active
>   via nvm.
> - `pnpm --filter dorkos` is a **name** filter, and the root workspace
>   `package.json` is also named `dorkos` — so the name filter matches **two**
>   packages and runs `exec` in each. The root has no `tsx`, so pnpm aborts with
>   `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`. Use the **path** filter
>   `'./packages/cli'` (quoted — the `./` tells pnpm it's a path, not a name)
>   to target exactly one package.
>
> The path-filter form runs the CLI source from your working tree under `tsx`
> and dispatches through the marketplace dispatcher's `validate` subcommand
> (`packages/cli/src/commands/marketplace-validate.ts`), which auto-detects the
> URL vs path input shape and routes to the right handler. Paths passed to
> `src/cli.ts` are relative to `packages/cli/` because `--filter` runs `exec`
> from inside that package.
>
> If you'd rather avoid pnpm filter syntax entirely, this also works from the
> repo root:
>
> ```bash
> packages/cli/node_modules/.bin/tsx packages/cli/src/cli.ts marketplace validate https://github.com/dork-labs/marketplace
> ```
>
> **Deprecated form** (still works, prints a stderr deprecation notice):
>
> ```bash
> pnpm --filter './packages/cli' exec tsx src/cli.ts package validate-remote https://github.com/dork-labs/marketplace
> ```

Expected output:

```
[OK]   Fetched https://github.com/dork-labs/marketplace/raw/main/.claude-plugin/marketplace.json
[OK]   DorkOS schema (passthrough)
[OK]   Sidecar present and valid (8 plugins)
[OK]   Claude Code compatibility (strict)
[OK]   Marketplace name not reserved

All checks passed. https://github.com/dork-labs/marketplace (8 packages)
```

Quick raw-URL sanity check:

```bash
curl -sf https://raw.githubusercontent.com/dork-labs/marketplace/main/.claude-plugin/marketplace.json | jq .name
# Expected: "dorkos"

curl -sf https://raw.githubusercontent.com/dork-labs/marketplace/main/.claude-plugin/dorkos.json | jq .schemaVersion
# Expected: 1
```

If `marketplace validate` exits 0 and the curl checks return the
expected values, the registry is live and consumable by both DorkOS
and CC. The hourly ISR on `dorkos.ai/marketplace` will pick up the
content within an hour.

## Step 5 — Phase 8 manual smoke tests

These are the bidirectional install tests that prove the strict-superset
invariants hold against real binaries. Capture the outputs and append
them to [`04-implementation.md`](./04-implementation.md) under the
"Phase 8 results" section so the spec has a permanent record.

### Test 4 — Claude Code can add the marketplace

```bash
claude plugin marketplace add dork-labs/marketplace
claude plugin marketplace list
```

**Expected:** `dorkos` appears in the marketplace list with 8 plugins.

### Test 5 — Claude Code can install a plugin from it

```bash
claude plugin install code-reviewer@dorkos
claude plugin list
```

**Expected:** install succeeds, `code-reviewer` appears as installed.

The plugin is intentionally a stub (just a SKILL.md placeholder), so it
won't _do_ anything when invoked — but the install path itself is what's
being tested. The plugin's skill should be visible to Claude Code as
`code-reviewer:code-reviewer` (the SDK auto-namespaces plugin skills).

### Test 6 — DorkOS install + runtime activation end-to-end

This proves the full DorkOS pipeline works against the live registry —
install machinery (DorkOS-owned) plus the Claude Agent SDK
`options.plugins` activation (SDK-owned) composing cleanly per ADR-0239.

```bash
# 1. Start DorkOS dev server
cd /Users/doriancollier/Keep/dork-os/core
pnpm dev
# Wait for both server (port 6242) and client (port 6241) to be ready
```

In another terminal:

```bash
# 2. Add the new marketplace as a source (CLI route)
dorkos marketplace add https://github.com/dork-labs/marketplace
dorkos marketplace list

# 3. Refresh the cache so the marketplace.json + sidecar are pulled
dorkos marketplace refresh

# 4. Install the code-reviewer plugin
dorkos install code-reviewer@dorkos
```

**Step 5 (the load-bearing assertion):** open the DorkOS UI at
`http://localhost:6241/session`, start an agent session, and send a
message like "What skills do you have?". Look for `code-reviewer:code-reviewer`
(or similar `code-reviewer:` prefix) in the agent's response.

If the plugin's skill is visible in the agent session, the runtime
activation wiring is working end-to-end and the strict-superset spec
is fully verified. Capture a screenshot for the implementation report.

If the plugin's skill is **not** visible:

- The `refreshActivatedPlugins()` lifecycle didn't fire after install
  — try restarting `pnpm dev` to force a fresh plugin scan
- If it still doesn't appear after restart, that's a real regression
  in `apps/server/src/services/runtimes/claude-code/plugin-activation.ts`
  or the `claude-code-runtime.ts` cache wiring — file an issue

## Step 6 — Update the implementation summary

After all 3 tests pass, append to
[`04-implementation.md`](./04-implementation.md):

```markdown
## Phase 8 results — operator-run smoke tests

**Date:** YYYY-MM-DD
**dork-labs/marketplace initial commit:** <SHA>
**Claude Code version:** 2.1.92
**DorkOS commit:** <main HEAD SHA>

### Test 4 — `claude plugin marketplace add dork-labs/marketplace`

PASS — output:
```

<paste output>
```

### Test 5 — `claude plugin install code-reviewer@dorkos`

PASS — output:

```
<paste output>
```

### Test 6 — DorkOS install + runtime activation end-to-end

PASS — `code-reviewer:code-reviewer` skill visible in agent session.
Screenshot: <link or note>.

**Verdict:** spec marketplace-05-claude-code-format-superset is fully
verified against live binaries. #28 GitHub org bootstrap is complete.

```

Then update the spec manifest status to `verified` if your manifest
schema supports it (otherwise leave as `implemented`).

## Optional follow-ups (recommended but not required)

Once the smoke tests pass, the registry is live and functional. These
are nice-to-haves for the new repo:

1. **`CONTRIBUTING.md` in `dork-labs/marketplace`** — describes how to
   add a new plugin entry. Copy the relevant sections from
   [`contributing/marketplace-registry.md`](../../contributing/marketplace-registry.md)
   and trim to the contributor-facing parts.

2. **`validate-submission.yml` GitHub Actions workflow** — gates every
   PR with `dorkos package validate-marketplace .claude-plugin/marketplace.json`.
   Easiest path: `npx -y dorkos@latest package validate-marketplace ...`
   once the CLI is published.

3. **Branch protection on `main`** — require the validate workflow to
   pass before merging. Configurable in the GitHub repo settings or
   via `gh api`.

4. **README.md polish** — the seed README is minimal. Expand it with
   contributor-facing intro, link to the dork-labs/dorkos repo, and a
   section on the format reference.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `gh repo create` says repo already exists | You ran the command twice or someone else created it | `gh repo view dork-labs/marketplace` to confirm; if it's empty you can still push to it |
| `claude plugin marketplace add` says "marketplace not found" | Repo isn't public yet | Check repo settings on GitHub; CC requires public repos for marketplace add |
| `claude plugin marketplace add` says "validation failed" | Drift between local seed and what was pushed | `git log` in `~/code/dork-labs-marketplace` to confirm the push landed; re-run `claude plugin validate` against the local fixture to verify it still passes |
| `claude plugin install` fails with "package not found" | CC's marketplace cache is stale | `claude plugin marketplace refresh dork-labs/marketplace` |
| `dorkos install` succeeds but plugin doesn't appear in agent session | `refreshActivatedPlugins()` wasn't called | Restart `pnpm dev` to force a fresh plugin scan; if still broken, real regression in `plugin-activation.ts` |
| `marketplace validate` 404s on the sidecar | Sidecar wasn't pushed (only `marketplace.json`) | `git status` in `~/code/dork-labs-marketplace`; re-add and push the missing file |
| `marketplace validate` 404s on `marketplace.json` itself | Default branch on `dork-labs/marketplace` isn't `main` (the repo-URL shorthand hardcodes `/raw/main/`) | Either rename the default branch to `main`, or pass a direct raw URL to the file instead of the repo URL |
| `dorkos package validate-marketplace` / `validate-remote` prints a deprecation notice | These forms are legacy back-compat aliases for `dorkos marketplace validate <path-or-url>` | Migrate scripts/CI to the new form. The aliases still work for one release |
| `pnpm tsx …` says `Command "tsx" not found` | `tsx` is only a devDependency of `packages/cli`, `apps/server`, `apps/site` — not the workspace root | Use `pnpm --filter './packages/cli' exec tsx src/cli.ts marketplace validate …` (paths are relative to `packages/cli/` under `--filter`) |
| `pnpm --filter dorkos exec …` fails with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` / `Command "tsx" not found` | The root `package.json` is **also** named `dorkos`, so `--filter dorkos` (a name filter) matches two packages and runs in both; the root has no `tsx` | Switch to the **path** filter: `pnpm --filter './packages/cli' exec tsx …` (quotes required so the shell passes `./packages/cli` through verbatim). Or invoke the binary directly: `packages/cli/node_modules/.bin/tsx packages/cli/src/cli.ts …` |
| `pnpm dorkos marketplace validate` fails with a `better-sqlite3` `NODE_MODULE_VERSION` mismatch | Globally-installed `dorkos` was built against a different Node ABI than your currently-active nvm version, and/or predates the `marketplace validate` subcommand and boots the server for every command | Use the `pnpm --filter './packages/cli' exec tsx …` form above, which runs the working-tree CLI source and never touches `better-sqlite3`. To refresh the global separately: `npm i -g dorkos@latest` under your current Node |
```
