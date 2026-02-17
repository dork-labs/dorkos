# CLI Self-Update Command Patterns

**Date**: 2026-02-17
**Mode**: Deep Research
**Objective**: Should `dorkos` implement a `dorkos update` (or similar) self-update command? What do popular CLI tools do, what packages exist, and what are the tradeoffs?

---

## Research Summary

Self-update commands are widely implemented by non-npm-native runtimes (Deno, Bun, Rust's rustup) because they own their installation mechanism and binary distribution. For npm-distributed global CLIs, the ecosystem is more split: most major tools (Vercel CLI, Firebase CLI, AWS Amplify CLI, GitHub CLI) do NOT implement a self-update subcommand, and instead rely on `npm install -g pkg@latest` plus the ubiquitous `update-notifier` pattern for passive notification. A small but growing minority (pnpm via `pnpm self-update`, some Oclif-based CLIs) do implement it by spawning `npm install -g` as a child process. There is no firm ecosystem consensus, but the dominant pattern for npm-distributed CLIs is notification-only, with the user running the standard npm update command themselves.

---

## Key Findings

1. **Non-npm runtimes universally implement self-update**: Deno (`deno upgrade`), Bun (`bun upgrade`), Rustup (`rustup self update`) all have built-in self-update. They own their binary installers and bypass npm entirely, making self-update straightforward.

2. **npm-distributed CLIs mostly skip self-update**: Vercel CLI, Firebase CLI, AWS Amplify CLI, and GitHub CLI (when installed via npm) do not ship a `tool update` subcommand. They tell users to re-run `npm install -g <pkg>`.

3. **pnpm is the notable npm-ecosystem exception**: pnpm added `pnpm self-update` in v9.8.0 (August 2024). It only works when pnpm was installed via the standalone installer script, not when installed via `npm install -g pnpm`. This installation-method dependency is the crux of the complexity.

4. **`update-notifier` is the dominant pattern** (~8 million weekly downloads, 5,500+ dependent packages): It runs a background check against the npm registry and prints a message like `Update available: 1.0.0 -> 1.2.0 — Run npm i -g dorkos to update` the next time the CLI runs. It does NOT perform the update itself.

5. **Self-update via child_process is technically feasible**: The accepted implementation pattern for Node.js CLIs that do want a self-update command is to spawn the system npm binary with `['install', '-g', 'dorkos@latest']`. Using the npm programmatic JavaScript API is explicitly discouraged by npm contributors as unsafe and unreliable.

6. **The installation-manager conflict is the core problem**: If a user installed `dorkos` via `npm`, then `dorkos update` should spawn `npm install -g`. If they used `yarn global`, it should use `yarn global add`. If they used `pnpm`, use `pnpm add -g`. The CLI cannot reliably know which manager was used. Spawning the wrong manager can corrupt the install.

---

## Detailed Analysis

### What Popular Tools Do

| Tool | Self-Update Command? | Mechanism |
|---|---|---|
| Deno | `deno upgrade` | Downloads binary from dl.deno.land, replaces executable |
| Bun | `bun upgrade` | Downloads binary from GitHub releases, replaces executable |
| Rustup | `rustup self update` | Downloads from static.rust-lang.org, replaces itself |
| pnpm | `pnpm self-update` (v9.8+) | Spawns npm/standalone installer, only works for standalone installs |
| npm | `npm install -g npm@latest` (no subcommand) | Recommends nvm; self-update is notoriously broken |
| Volta | No self-update command | Recommends re-running the install script |
| GitHub CLI | No self-update command | Defers to OS package manager (brew, winget, apt) |
| Vercel CLI | No self-update command | Documents `npm i -g vercel` |
| Firebase CLI | No self-update command | Documents `npm install -g firebase-tools` |
| AWS Amplify CLI | No self-update command | Documents `npm install -g @aws-amplify/cli` |
| Homebrew | `brew upgrade <formula>` | Managed by Homebrew itself, not the tool |

**Pattern**: Self-update is universal for tools that own their distribution channel (binary downloads, custom scripts). It is uncommon for tools distributed purely through npm, where npm is the canonical package manager and the tool is a guest in npm's system.

### The npm Self-Update Paradox

The core technical challenge is described in the npm issue tracker (issue #7723, opened 2015, still referenced today):

When a package is installed globally via the system npm, that global installation is invisible to any npm instance bundled *inside* the package itself. Running `npm.commands.update()` from within the CLI sees only the local `node_modules`, not the global install location. The npm programmatic API was explicitly called "not a super safe way" to do this by npm contributors, with reports of npm "unexpectedly deleting itself."

The only reliable workaround is to spawn the *system's* npm binary as a separate child process (not using `exec` with shell interpolation — always use `execFile` or `spawn` with an args array to avoid shell injection). In dorkos terms this would use the existing `execFileNoThrow` utility or equivalent:

```typescript
// Conceptual sketch — use execFileNoThrow from src/utils/execFileNoThrow.ts
import { execFileNoThrow } from '../utils/execFileNoThrow.js';

async function selfUpdate(): Promise<void> {
  const result = await execFileNoThrow('npm', ['install', '-g', 'dorkos@latest']);
  if (result.status !== 0) {
    throw new Error(`Update failed:\n${result.stderr}`);
  }
}
```

This works, but has a critical catch: it assumes npm is the installation manager.

### The Package Manager Fragmentation Problem

In 2026, users install global CLIs with multiple managers:
- `npm install -g dorkos`
- `yarn global add dorkos`
- `pnpm add -g dorkos`
- `bun add -g dorkos`

If `dorkos update` blindly spawns `npm install -g dorkos`, it will:
- Create a duplicate npm-managed install alongside a yarn-managed one
- Potentially install to a different location than the user's PATH points to
- Not update the correct instance the user is running

Detection heuristics exist (inspect `process.env.npm_config_user_agent`, check for lock files, detect `process.env.npm_execpath`) but are imperfect. The `npm_config_user_agent` env var is set when running via npm scripts but may not be set for a globally installed binary invoked directly.

pnpm's solution was to limit `pnpm self-update` to only work when installed via their standalone script — effectively opting out of the package-manager-agnostic problem.

### The `update-notifier` Approach (Dominant Pattern)

The ecosystem's answer to this complexity is **passive notification, not active update**. The `update-notifier` package:

- Runs an async background check against the npm registry (non-blocking, spawns in an `unref`'d child process)
- Caches the result for a configurable interval (default: 24 hours)
- On the *next* run of the CLI, displays a message like:

```
Update available: 0.9.0 -> 1.0.0
Run npm i -g dorkos to update
```

- Respects `NO_UPDATE_NOTIFIER` env var and `--no-update-notifier` flag for CI/automation
- Downloads: ~8 million/week; used by 5,500+ packages

This approach is used by: Create React App, Angular CLI, Vue CLI, Gatsby CLI, and many more.

**Known limitation**: The default message says `npm i -g dorkos` but this is incorrect for yarn/pnpm/bun users. Some CLIs customize the notification message using the `preferred-pm` or `which-pm-runs` packages to show the right command for each user.

### Arguments For a Self-Update Command

1. **User experience**: One command (`dorkos update`) is simpler than remembering `npm install -g dorkos`. Reduces support burden from "how do I update?"
2. **Discoverability**: Users running `dorkos --help` see `update` listed, making the update path obvious.
3. **Version visibility**: A self-update command can show current vs. available version before updating, offering better UX than a blind install.
4. **Precedent in developer tools**: Bun, Deno, pnpm all do it. The trend in developer-facing CLIs leans toward self-update.
5. **CI/automation safety**: Can be skipped via `--yes` flag or `NO_UPDATE_NOTIFIER` env var, making automated upgrades scriptable.
6. **Offline/error detection**: The command can print a helpful error when the registry is unreachable rather than silently failing.

### Arguments Against a Self-Update Command

1. **Package manager fragmentation**: Cannot reliably determine which package manager installed the tool (npm vs yarn vs pnpm vs bun). Guessing wrong can produce a corrupted or shadowed install.
2. **npm's own self-update is broken**: npm's documentation acknowledges that `npm install -g npm` can corrupt installations; the recommended approach is to use nvm. This sets a strong precedent that npm-managed self-update is fragile.
3. **Security surface**: Downloading and replacing your own binary is a supply chain attack vector. The trust model of "npm installed you, npm updates you" is more auditable.
4. **Maintenance cost**: Handling permission errors, stale lock files, yarn workspaces, Corepack conflicts, and sudo-wrapped installs adds ongoing maintenance for limited upside.
5. **Duplicates npm's responsibility**: npm's job is to manage packages. Having your CLI duplicate that logic is redundant and fragile.
6. **Package managers evolve**: npm has changed its global install behavior multiple times historically. Your self-update logic can silently break across npm major versions.
7. **update-notifier is sufficient**: The notification pattern already solves "user doesn't know an update exists" without any of the above risks.

### What the Node.js/npm Ecosystem Consensus Looks Like

There is no official guidance from the npm team on whether CLIs should implement self-update. The GitHub issue (#7723) on this topic has been open since 2015 with no official resolution — which is itself telling.

The de facto consensus, as observed from major CLI tools, is:

- **Notification (yes)**: Use `update-notifier` or equivalent. This is nearly universal and considered table-stakes.
- **Self-update (optional)**: Implement only if you control the install mechanism (standalone binary/script) or are willing to handle package manager detection complexity and its edge cases.

The trend among newer/developer-focused CLIs (Bun, pnpm v9.8+) is to add self-update, while established, larger production CLIs (Firebase, Vercel, AWS) continue to skip it.

---

## Recommendation for DorkOS

**Recommended approach: `update-notifier` for passive notification + a transparent `dorkos update` command that delegates to the correct package manager.**

### Rationale

`dorkos` is a developer tool targeting technical users who understand npm. The self-update problem is solvable with a reasonable heuristic. The expected user base is small enough that edge cases (Corepack, yarn workspaces, sudo) can be handled incrementally. Adding `dorkos update` improves discoverability significantly and reduces "how do I update?" friction in the README and docs.

### Proposed Update Logic

1. Check `process.env.npm_config_user_agent` for `yarn`, `pnpm`, `bun`, or `npm`.
2. Fall back to checking which binary is on PATH.
3. If still ambiguous, default to `npm install -g dorkos@latest` and clearly print what command is being run.
4. Always print the exact install command before executing it so users can abort and run it themselves if needed.

```
$ dorkos update

Current version: 0.9.0
Latest version:  1.0.0

Detected package manager: npm
Running: npm install -g dorkos@latest

[npm output...]

dorkos updated to 1.0.0
```

### Proposed Subcommand API

```
dorkos update              # Check for updates and install if available
dorkos update --check      # Print current vs. latest, no install
dorkos update --yes        # Non-interactive, skip confirmation prompt
dorkos update --dry-run    # Show what command would run, but don't run it
```

### What to Add Passively (Immediately)

Add `update-notifier` at CLI startup. This is low-risk, zero-downside, and expected by users of modern CLI tools. It handles background checks and displays a notification at the start of any `dorkos` invocation when an update is available. Customize the message to be package-manager-aware:

```typescript
// packages/cli/src/index.ts
import updateNotifier from 'update-notifier';
import pkg from '../package.json' assert { type: 'json' };

updateNotifier({ pkg }).notify({
  message: 'Update available: {currentVersion} -> {latestVersion}\nRun npm i -g dorkos to update',
});
```

### Risk Mitigation

- Use `execFileNoThrow` (not `exec`) for the actual install to prevent shell injection
- Document that Corepack-managed installs should use `corepack` to update
- Test across npm, pnpm, and bun installs in CI
- Add `--dry-run` flag that shows what would be run without executing it
- Emit a clear error if update fails (permissions, network) with a manual fallback command

---

## Research Gaps & Limitations

- Did not survey Oclif-based CLIs (Heroku, Salesforce) which have `@oclif/plugin-update` for framework-level self-update via tarballs — a more robust approach worth examining if the child_process approach proves too fragile.
- The `npm_config_user_agent` heuristic was not tested empirically across package managers in this research.
- Corepack's interaction with global package manager installs is an additional complexity not fully explored.
- Did not verify whether `bun add -g` respects the same global binary PATH as npm global bins.

---

## Contradictions & Disputes

- **pnpm docs vs. behavior**: pnpm's `self-update` docs say it works for standalone installs, but a 2025 GitHub issue (#8949) shows it fails to upgrade from v9 to v10 in some configurations — demonstrating that even purpose-built self-update can fail.
- **update-notifier shows the wrong command**: For yarn/pnpm/bun users, `update-notifier`'s default message says `npm i -g` which is incorrect. This is a known limitation requiring customization.
- **npm's self-update history**: npm's own self-update has been broken multiple times across major versions, which is the strongest argument that npm-managed self-update is inherently fragile — yet pnpm and others ship it anyway, betting on reliability at their specific install path.

---

## Search Methodology

- Searches performed: 12
- Most productive search terms: `"pnpm self-update"`, `"update-notifier npm"`, `npm issue 7723 self-update`, `deno upgrade CLI`, `bun upgrade command`
- Primary information sources: npm GitHub issues, official Deno/pnpm/Bun/Rustup docs, npm registry stats, Socket.dev

---

## Sources

- [Implement self-update in npm global module — GitHub Issue #7723](https://github.com/npm/npm/issues/7723)
- [update-notifier — npm](https://www.npmjs.com/package/update-notifier)
- [simple-update-notifier — Socket.dev analysis](https://socket.dev/npm/package/simple-update-notifier)
- [deno upgrade — Official Docs](https://docs.deno.com/runtime/reference/cli/upgrade/)
- [Bun upgrade — Official Docs](https://bun.com/docs/guides/util/upgrade)
- [pnpm self-update — Official Docs](https://pnpm.io/cli/self-update)
- [pnpm self-update not updating to v10 — GitHub Issue #8949](https://github.com/pnpm/pnpm/issues/8949)
- [rustup self update — Fig Manual](https://fig.io/manual/rustup/self/update)
- [How to upgrade GitHub CLI — cli/cli Discussion #4630](https://github.com/cli/cli/discussions/4630)
- [volta self-update issue — volta-cli/volta #521](https://github.com/volta-cli/volta/issues/521)
- [spawn-npm-install — npm](https://www.npmjs.com/package/spawn-npm-install)
- [Update-notifier Guide 2025 — generalistprogrammer.com](https://generalistprogrammer.com/tutorials/update-notifier-npm-package-guide)
- [Confusing about how to update pnpm — pnpm Discussion #4383](https://github.com/orgs/pnpm/discussions/4383)
- [Brew Upgrade GH doesnt initiate upgrade — cli/cli Issue #299](https://github.com/cli/cli/issues/299)
