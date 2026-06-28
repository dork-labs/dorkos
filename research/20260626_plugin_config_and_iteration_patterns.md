---
title: 'Plugin Config and Iteration Patterns: Per-Project Config with Global Install + Upstream Contribution Loops'
date: 2026-06-26
type: external-best-practices
status: active
tags:
  [
    plugin,
    extension,
    config-discovery,
    cosmiconfig,
    vscode,
    raycast,
    terraform,
    backstage,
    github-apps,
    secrets,
    npm-link,
    git-subtree,
    git-submodule,
    marketplace,
    agent-harness,
    upstream-contribution,
  ]
searches_performed: 16
sources_count: 42
---

# Plugin Config and Iteration Patterns

**Date**: 2026-06-26
**Research Depth**: Deep Research
**Context**: Designing a markdown-based agent-harness plugin distributed through a marketplace and installed into many different git repos. Two specific design problems surveyed.

---

## Research Summary

This report surveys how mature plugin and extension ecosystems solve two hard problems specific to tools that are installed once globally but consumed per-project: (A) per-project configuration where secrets must stay out of git, and (B) editing an installed plugin and getting those changes back to the source marketplace. The findings show that cosmiconfig-style upward directory search plus gitignored local-override files plus OS-keychain or env-var secrets is the dominant and most-copied pattern for Problem A. For Problem B, no ecosystem has fully automated "edit installed copy → open PR to marketplace" — Raycast comes closest, and the universal fallback is always clone-source-separately + PR. Concrete recommendations for the DorkOS agent-harness plugin follow each problem section.

---

## PROBLEM A: Per-Project Config with a Global/Once Install

### Key Findings

#### 1. Cosmiconfig-Style Upward Directory Search: The Dominant Pattern

**Who uses it**: ESLint (historically), Prettier, Babel, Jest, PostCSS, Stylelint, Commitlint, Husky, Lint-staged, and hundreds of other JavaScript/TypeScript tools.

**How it works**: The library [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) (85M weekly downloads) walks the directory tree starting from `process.cwd()` (or a caller-supplied `searchFrom` path), checking each directory for a config file in this order:

```
package.json          (toolName key)
.${toolName}rc
.${toolName}rc.json
.${toolName}rc.yaml
.${toolName}rc.yml
.${toolName}rc.js / .ts / .mjs / .cjs
.config/${toolName}rc  (and extension variants)
${toolName}.config.js / .ts / .mjs / .cjs
```

It checks all of those in one directory, then climbs one level (`../`), checks again, and repeats until it either finds a config or hits `stopDir` (defaults to the user's home directory `~`). It stops at the **first** file found — it does not merge configs up the tree.

The **global strategy** (enabled by passing a `stopDir`) also checks `~/.config/{toolName}/config` (and extension variants) after traversal reaches home, providing a clean home-level global default.

**Alternatives with the same core pattern**:

- [lilconfig](https://github.com/antonk52/lilconfig) — zero-dependency drop-in, sync-only, no YAML by default; used by Prettier and PostCSS for startup speed (~3x smaller than cosmiconfig)
- [c12](https://github.com/unjs/c12) — UnJS ecosystem, adds TypeScript config, `extends` layering (like Nuxt), and hot-reload watch mode; used by Nuxt, Nitro

**Key behavior**: the search stops at the project root — typically where `package.json` or `.git` lives — because that's the first place a config file is usually found. This creates an implicit "local wins, global fallback" without any special mechanism: the project-level config is found first, so the home-directory config is never reached.

**First-run / empty-config UX**: Most tools using cosmiconfig silently use built-in defaults if no config file is found. Prettier formats with defaults. Babel transpiles without transforms. ESLint added `--init` for a first-run wizard, but only because linting is meaningless without rules. The pattern: zero-config first run, optional config discovery.

#### 2. VS Code `contributes.configuration`: Typed Scope-Aware Split

**How it works**: VS Code extensions declare settings in `package.json` under `contributes.configuration`. Each setting has a `scope`:

| Scope         | Where Stored                               | In Git?  | Notes                        |
| ------------- | ------------------------------------------ | -------- | ---------------------------- |
| `application` | User `settings.json`                       | No       | Machine-global, not synced   |
| `machine`     | User `settings.json`                       | No       | Machine-specific, not synced |
| `window`      | User or Workspace `settings.json`          | Possibly | Instance-level               |
| `resource`    | User, Workspace, or Folder `settings.json` | Possibly | Per-folder, most granular    |

**Global** = `~/.config/Code/User/settings.json` (User Settings)
**Local** = `.vscode/settings.json` at workspace/project root (Workspace Settings, typically committed)

**Secrets out of git**: Extensions use `ExtensionContext.secrets` ([SecretStorage API](https://code.visualstudio.com/api/references/vscode-api)), backed by Electron's `safeStorage` → OS keychain (macOS Keychain Access, Windows Credential Manager, Linux Keyring). Secrets are never in `settings.json`, never committed. API tokens set in settings (plain text) vs. `SecretStorage` (encrypted keychain) is a well-documented security distinction in the VS Code ecosystem.

**Extension-level vs workspace-level split**: Extensions declare `"scope": "machine"` for credentials (user-global, never committed) and `"scope": "resource"` for project settings (can live in `.vscode/settings.json`).

#### 3. Terraform Provider Config + TF*VAR* + `*.tfvars` Gitignore

**How it works**: Terraform cleanly separates three layers:

1. **Provider config blocks** in `.tf` files (committed) — declare the provider and which variables it expects, but not the values.
2. **`variables.tf`** (committed) — declares variable names and types, with optional defaults.
3. **`terraform.tfvars`** (gitignored) — actual values for variables, including secrets.
4. **`TF_VAR_varname` env vars** — override any variable, highest precedence.
5. **Provider-specific env vars** — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `ARM_CLIENT_SECRET`, etc. recognized by the provider SDK.

GitHub's official Terraform `.gitignore` template includes `*.tfvars` by default. The separation is crisp: the shape of config is committed; the values (especially secrets) are not.

**First-run UX**: `terraform init` scaffolds the provider lockfile. `terraform plan` reports missing required variables with an actionable error. No silent failure.

#### 4. Backstage `app-config.yaml` + `app-config.local.yaml`

**How it works**: Backstage uses a layered YAML config system with an explicit priority stack:

1. `APP_CONFIG_*` environment variables (highest)
2. Files listed via `--config` flag (rightmost wins)
3. `app-config.local.yaml` (gitignored, local overrides)
4. `app-config.yaml` (base config, committed)

The pattern: **commit the base, gitignore the local override**. `app-config.local.yaml` is listed in Backstage's `.gitignore` by default. Secrets go in `app-config.local.yaml` or in env vars; neither is committed.

**Env-based override**: `APP_CONFIG_backend_auth_keys_0_secret=xxx` overrides `backend.auth.keys[0].secret`. The double-underscore or nested-key encoding lets any YAML path be set by env var — a pattern Backstage shares with many tools.

#### 5. GitHub Apps: Per-Repo Config Files in `.github/`

**How it works**: A GitHub App is installed once at the org or user level (globally), then per-repo behavior is controlled by config files that consuming repos commit to their own `.github/` directory. Examples:

- **Probot-based apps** (like `settings` app): read `.github/settings.yml` from each repo
- **GitHub Actions reusable workflows**: `.github/workflows/*.yml` in each consuming repo
- **Dependabot**: `.github/dependabot.yml`
- **Code owners**: `.github/CODEOWNERS`

The global install handles authentication (OAuth app credentials, webhook secrets are at the App level, managed in GitHub's UI). The per-repo config file is purely behavioral — which labels to create, which reviewers to assign — never credentials.

**Secrets**: App secrets (private key, webhook secret) live in GitHub's App settings and in the CI/CD environment. Per-repo `.github/*.yml` files contain no credentials; they are always safe to commit.

#### 6. Raycast Extensions: Manifest-Declared Preferences, OS Keychain for Passwords

**How it works**: Each extension declares `preferences` in `package.json`. A preference has a `type` field: `textfield`, `password`, `checkbox`, `dropdown`, `appPicker`, `file`, `directory`.

- **`type: "password"`** preferences are stored in Raycast's encrypted local database, backed by the macOS Keychain. Never on disk as plaintext.
- **Extension-level preferences** (shown in Raycast Preferences for the whole extension) vs **command-level preferences** (shown when selecting a specific command). Commands inherit extension preferences.
- **Required preferences**: If a required preference has no value, Raycast shows the preferences dialog when the command is first invoked — a clean first-run UX without a separate init wizard.

Extensions requesting direct Keychain Access are rejected from the store; they must use Raycast's built-in `password` preference type.

#### 7. Oh My Zsh: Single Global File, No Per-Project Layer

Oh My Zsh uses a single global `~/.zshrc` for plugin registration (`plugins=(git docker node)`). There is no native per-project config override mechanism. `$ZSH_CUSTOM` provides a directory for override files, but it's still user-global. This is an **anti-pattern** for per-project config — zsh-specific tools like `direnv` fill the gap by loading per-directory `.envrc` files on `cd`.

**What zsh ecosystems use instead**: `direnv` with per-project `.envrc` files (gitignored if they contain secrets, or committed with only non-sensitive exports).

---

### Synthesis: The Three Dominant Patterns for Problem A

**Pattern 1: Upward File Search (cosmiconfig/lilconfig)**

- **Best for**: tools that need a config file format, especially ones used by developers
- **Global/local split**: implicit — project-level file found first stops the search; home dir is the fallback
- **Secrets**: not built in; tools typically defer to env vars (`TOOL_API_KEY`) and document that secrets should not go in the config file
- **First-run**: silent defaults; wizard via `--init` only if truly needed
- **Users**: ESLint, Prettier, Babel, Jest, PostCSS, Stylelint

**Pattern 2: Base File + Gitignored Local Override + Env Vars (Terraform/Backstage/many others)**

- **Best for**: tools with both shared team config and per-user/per-environment secrets
- **Global/local split**: explicit file naming convention (`app-config.yaml` vs `app-config.local.yaml`; `variables.tf` vs `terraform.tfvars`)
- **Secrets**: gitignored local file + env vars (both are "not in git")
- **First-run**: tool scaffolds the gitignored file template; required values cause actionable errors on first run
- **Users**: Terraform, Backstage, Docker Compose, many config-heavy tools

**Pattern 3: Manifest-Declared Preferences with OS Keychain for Secrets (VS Code / Raycast)**

- **Best for**: GUI-embedded extension systems where the host app owns the settings UX
- **Global/local split**: formal scope system (`machine` vs `resource`; extension-level vs command-level)
- **Secrets**: OS keychain via host app's API (`SecretStorage` / Raycast's encrypted db) — never in settings files
- **First-run**: host shows settings panel automatically if required preference missing; no init wizard needed
- **Users**: VS Code extensions, Raycast extensions, JetBrains plugins

---

### Recommendation for DorkOS Agent-Harness Plugin (Problem A)

The agent-harness plugin is installed globally but used per-repo. It is markdown-based, not GUI-embedded. The closest analogs are ESLint/Prettier + Terraform + GitHub Apps.

**Recommended pattern: Cosmiconfig-style upward search + gitignored local secrets file + env vars**

1. **Plugin config discovery**: Use a cosmiconfig-style search starting from the working directory. Search for:
   - `.dorkos/<plugin-name>.yml` in the repo root
   - `<plugin-name>` key in `package.json` (or equivalent project manifest)
   - Fall back to `~/.dork/plugins/<plugin-name>/config.yml` for global defaults

2. **Per-repo config file** (`.dorkos/<plugin-name>.yml`, committed): Contains tracker key, project ID, behavioral flags, non-secret settings. Safe to commit.

3. **Secrets file** (`.dorkos/<plugin-name>.local.yml`, gitignored by DorkOS's generated `.gitignore`): Contains tokens, credentials, any values the user does not want in git. The plugin's `SKILL.md` should document this split explicitly and add `.dorkos/*.local.yml` to the generated `.gitignore` on install.

4. **Env var fallback** (`DORKOS_<PLUGIN>_<KEY>`): Overrides both file layers. Documents neatly in CI/CD guides.

5. **First-run UX**: If the plugin is invoked and a required setting (e.g. Linear API key) is missing, emit a structured error citing exactly which file/env var is missing and what to set. Do not fail silently with a cryptic error.

6. **No OS keychain integration needed** (at this stage): The gitignored `.local.yml` + env vars is sufficient for an agent-harness context. If Claude Code's own SecretStorage ever becomes accessible, that's a future upgrade.

---

## PROBLEM B: Iterating / Editing a Plugin and Pushing Changes Upstream

### Key Findings

#### 1. npm link / pnpm workspace link: The Local Symlink Loop

**What it does**: `npm link` or `pnpm link` creates a symlink from the installed location in `node_modules` back to a local source directory. Changes to the source are reflected immediately in the consuming project.

**Development loop**:

1. Clone the plugin source repo separately
2. `pnpm link ../my-plugin-source` in the consuming project
3. Edit source → changes reflected immediately (for interpreted/watched builds) or after rebuild
4. Commit + push to source repo → open PR

**Key limitation**: The consumer must clone the plugin source as a **separate repository**. There is no tooling that looks at an installed package in `node_modules` and automatically locates its upstream source repo. The installed copy and the editable source are always separate.

**pnpm workspace protocol**: Within a monorepo, `"my-plugin": "workspace:*"` resolves to the local copy. This is the cleanest local-dev loop for monorepo-style plugin development, but it requires the plugin source to be inside the same monorepo workspace tree.

#### 2. VS Code `--extensionDevelopmentPath`: Author Loop, Not Consumer Loop

**What it does**: `code --extensionDevelopmentPath=/path/to/my-ext` launches an Extension Development Host with the local extension loaded. TypeScript is in watch mode; changes appear after reload.

**Key point**: This is the workflow for **extension authors** developing their own extension. It is not a workflow for a consumer of an installed extension to iterate on it. An installed `.vsix` extension has its source compiled; there is no path back to its source from the installed binary.

**Publishing**: `vsce publish` pushes to the VS Code Marketplace. This requires:

- A publisher account on the marketplace
- The `vsce` CLI authenticated

There is no "install this extension, tweak it, and submit the tweak upstream" tooling. The consumer must either:

- Fork the extension source repo on GitHub, clone it, develop locally with `--extensionDevelopmentPath`, then open a PR to the source repo
- Or open an issue and wait for the maintainer

#### 3. Git Submodules: Bidirectional Push, But Only If You Have Write Access

**What it does**: The consuming repo has a `.gitmodules` file pointing to the plugin's source repo. The plugin source lives in a subdirectory, directly connected to its upstream git history.

**Edit and push back**:

1. Edit files in the submodule directory
2. `cd` into the submodule
3. `git push origin my-feature-branch`
4. Open PR on the plugin's source repo

**Pros**: Most direct connection between consumed code and source. Pushing back is just a normal `git push` inside the submodule directory.

**Cons**:

- Requires write access or fork of the plugin source
- Every consumer must run `git submodule update --init` after cloning — a notorious footgun
- Submodule updates must be explicitly committed in the consuming repo
- Does not work if the plugin is installed via a marketplace installer (the installer copies files, not clones submodules)

#### 4. Git Subtree: Embedded History, Harder Push-Back

**What it does**: `git subtree add --prefix=plugins/my-plugin https://github.com/org/my-plugin main` copies the plugin's full git history into the consuming repo.

**Edit and push back**:

```
git subtree push --prefix=plugins/my-plugin https://github.com/org/my-plugin my-feature-branch
```

Then open PR on the plugin's source repo.

**Pros**:

- No `.gitmodules` file; consumers don't need to know they're using subtree
- Works with standard `git clone` — no extra init step
- Changes in consuming repo can be pushed back

**Cons**:

- History becomes intertwined; `git log` in the consuming repo includes all plugin commits
- Push-back requires remembering (or documenting) the remote URL and prefix path
- No tooling automatically detects "this subtree came from X repo"; the mapping is manual
- If the plugin marketplace doesn't distribute via subtree, this pattern can't be used

#### 5. Terraform `override.tf`: Local Source Override, Manual PR Flow

**What it does**: `override.tf` in the consuming Terraform project can override any `source` attribute in a `module` block. To develop a module locally:

```hcl
# override.tf (not committed)
module "my_module" {
  source = "../../local/path/to/module"
}
```

The original `main.tf` still points to the registry source. `terraform init` picks up the override immediately with no version constraint.

**Edit and push back**: Manually. The developer edits the local path, tests it, then opens a PR to the module's source repo. There is no `terraform module publish` or "open PR from here" command. HashiCorp Terraform Registry requires a GitHub repo tagged with semantic versions; publishing is done by pushing a git tag.

**Key takeaway**: Override files for local dev → manual PR flow to the module source repo. No automation.

#### 6. Homebrew Tap PRs: `brew edit` → Test → PR

**What it does**: `brew edit formula-name` opens the formula Ruby file in `$EDITOR`. After editing:

```
brew install --build-from-source formula-name
brew test formula-name
brew audit --strict formula-name
```

Then the developer opens a PR to `homebrew/homebrew-core` (or the relevant tap).

**Key point**: `brew edit` edits the **locally-installed formula file** in the Homebrew installation prefix, not the source repo. After the PR is merged, `brew update` will pull the change. There is no automation to go from `brew edit` → open PR; the workflow requires:

1. Fork `homebrew/homebrew-core` on GitHub
2. Commit the edited formula to the fork
3. Open PR via GitHub web UI

Homebrew does provide `brew bump-formula-pr` for the specific case of version bumps, which **does** automate the fork → commit → PR flow for that one use case.

#### 7. Backstage Plugin Local Dev Loop

**What it does**: Backstage's development workflow uses yarn/pnpm workspaces. A plugin lives in `plugins/my-plugin/` inside the Backstage monorepo. To develop locally against a consuming app, the plugin is linked via workspace protocol.

**Contributing back**: Fork `backstage/backstage`, add your plugin to `plugins/`, test against the example app in the monorepo, then open a PR. No "install plugin from registry → edit in place → PR back" path exists.

#### 8. Raycast: The Closest Example of "Edit Installed → PR Upstream"

This is the most interesting case. Raycast is the **only ecosystem surveyed** with tooling that partially automates the edit-installed → PR-upstream loop.

**The workflow**:

1. Open Raycast, find any store extension, press `Cmd+K` → **"Fork Extension"** — this action sparse-clones the `raycast/extensions` monorepo (using `git sparse-checkout` to avoid downloading the full 20GB repo) and checks out only the extension's directory
2. Navigate to the cloned folder: `npm install && npm run dev`
3. Edit the extension source
4. Run `npm run publish` — this authenticates with GitHub and **automatically opens a PR** to `raycast/extensions` on the developer's behalf

**How the source mapping works**: All Raycast store extensions live in a single centralized monorepo (`raycast/extensions`). The "Fork Extension" action knows exactly where to sparse-clone from and where to PR back to, because there is only one possible upstream. This is not a general solution; it works because Raycast chose a monorepo distribution model.

**Limitations**:

- Still a separate clone — the installed extension and the editable source are not the same directory
- Requires GitHub authentication in the Raycast app
- PR creation (`npm run publish`) squashes commits
- Only works because the entire extension catalog is a single public monorepo

**Assessment**: Raycast's `Fork Extension` + `npm run publish` is as close as any ecosystem comes to "edit and send upstream with tooling support." The key insight is that the tooling can automate the PR because it always knows the upstream URL (`raycast/extensions`). For a distributed marketplace where each plugin lives in its own repo, this automation is harder.

---

### Synthesis: The Three Dominant Patterns for Problem B

**Pattern 1: Clone Source Separately + Symlink for Dev (Universal / npm link)**

- **How**: Clone plugin source repo independently → `npm link` or `pnpm link` into consuming project → edit source → push to plugin repo → open PR
- **Tooling**: npm/pnpm link, workspace protocol within monorepos
- **Upstream mapping**: developer is responsible for knowing the source repo URL
- **Automation level**: none — fully manual PR flow
- **Users**: essentially all JavaScript/TypeScript plugin ecosystems

**Pattern 2: git submodule / git subtree (Embedded Source)**

- **How**: Plugin source embedded in consuming repo via submodule or subtree → edit in place → push changes to plugin's upstream
- **Tooling**: `git submodule`, `git subtree push --prefix=...`
- **Upstream mapping**: `.gitmodules` (submodule) or documented via convention (subtree)
- **Automation level**: low — push command is automated but PR creation is manual
- **Users**: large projects with vendored dependencies, internal tooling

**Pattern 3: Centralized Monorepo + CLI-Automated PR (Raycast)**

- **How**: Single monorepo for all plugins → sparse-clone the target extension → edit → `npm run publish` opens PR automatically
- **Tooling**: `git sparse-checkout`, `npm run publish` → GitHub PR API
- **Upstream mapping**: always known (single monorepo); no lookup needed
- **Automation level**: high — PR is opened by the CLI
- **Users**: Raycast extensions only (in the surveyed ecosystems)

---

### Recommendation for DorkOS Agent-Harness Plugin (Problem B)

The DorkOS marketplace distributes plugins as git repos (each plugin has its own repo or is distributed from a catalog). The DorkOS agent harness plugin is markdown-based, so the "installed copy" is markdown files — not compiled binaries, which makes in-place editing feasible.

**Recommended approach: Plugin manifest carries its source repo URL; DorkOS CLI provides `dorkos plugin contribute <plugin-name>` command**

The key insight from Raycast: the automation is possible when the tool knows the source repo URL. The DorkOS plugin format should carry the source repo as a mandatory field (it already appears to do so: `"repository"` in the Claude Code plugin manifest).

Proposed DorkOS contribution loop:

1. **Install from marketplace**: DorkOS installer writes the plugin files to `.agents/skills/` (or wherever) and records the source repo URL + installed version in a lockfile (analogous to `pnpm-lock.yaml`)

2. **User wants to edit**: The DorkOS marketplace UI or CLI runs `dorkos plugin contribute <plugin-name>`, which:
   - Reads the source repo URL from the lockfile
   - Sparse-clones or full-clones the plugin source into a temporary worktree (using the existing DorkOS worktree machinery)
   - Opens a terminal/session pointed at that worktree

3. **User edits the plugin source** in the cloned worktree

4. **User runs `dorkos plugin submit`** (or a skill invocation):
   - Checks if the user has a fork of the plugin's source repo (via GitHub API)
   - Forks if needed
   - Pushes the branch to the fork
   - Opens a PR to the plugin's source repo
   - Reports the PR URL

**Simpler alternative (lower friction, lower automation)**:

For the near term — given that in-place markdown edits are safe and the "installed copy" is human-readable — the recommended minimal viable loop is:

1. Plugin installer records the source repo URL in `.dork/plugins/<name>.lock`
2. A skill or CLI command prints the source repo URL and a one-liner to clone it: `git clone <url> --sparse --filter=blob:none`
3. The user edits, tests, pushes a branch, and opens a PR on the source repo
4. On PR merge, the marketplace auto-publishes a new version
5. `dorkos plugin update` pulls the new version into the consuming repo

This is the Homebrew `brew bump-formula-pr` model — partial automation, not full. The PR creation remains manual, but the source-lookup step is automated.

**What to avoid**: Do NOT design a workflow where the plugin's installed files are edited directly in place in the consuming repo without any mechanism to push those edits back. That produces a "local fork" that drifts silently from the upstream and can never contribute back — the worst outcome.

---

## Sources & Evidence

### Cosmiconfig / Config Discovery

- [cosmiconfig GitHub README](https://github.com/cosmiconfig/cosmiconfig) — canonical upward-search algorithm, stopDir, global strategy, default searchPlaces list
- [cosmiconfig npm page](https://www.npmjs.com/package/cosmiconfig) — weekly download counts, API overview
- [cosmiconfig vs lilconfig vs c12 2026 — PkgPulse Guides](https://www.pkgpulse.com/guides/cosmiconfig-vs-lilconfig-vs-c12-config-file-loading-2026) — comparison of all three libraries, adoption by tool
- [lilconfig GitHub](https://github.com/antonk52/lilconfig) — zero-dependency alternative, sync-only, used by Prettier

### VS Code Extensions

- [VS Code User and Workspace Settings](https://code.visualstudio.com/docs/configure/settings) — scope hierarchy, User vs Workspace settings
- [VS Code Contribution Points: configuration](https://code.visualstudio.com/api/references/contribution-points) — `scope` values (machine, window, resource)
- [VS Code SecretStorage API](https://code.visualstudio.com/api/references/vscode-api) — `ExtensionContext.secrets`, OS keychain backing
- [How to use SecretStorage in VS Code extensions — DEV Community](https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco)
- [Protect API/auth keys — Elio Struyf](https://www.eliostruyf.com/protect-api-auth-keys-keeping-out-vscode-settings/)
- [VS Code Extension Debugging](https://vscode-docs.readthedocs.io/en/stable/extensions/debugging-extensions/) — `--extensionDevelopmentPath` flag
- [Publishing VS Code Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) — `vsce publish`, publisher account requirements

### Terraform

- [Protect sensitive input variables — HashiCorp Developer](https://developer.hashicorp.com/terraform/tutorials/configuration-language/sensitive-variables) — `sensitive = true`, `terraform.tfvars`, env var prefix `TF_VAR_`
- [How to Use Environment Variables for Terraform Secrets — OneUptime](https://oneuptime.com/blog/post/2026-02-23-how-to-use-environment-variables-for-terraform-secrets/view)
- [Terraform Local Module Development — HashiCorp Developer](https://developer.hashicorp.com/terraform/tutorials/modules/module-create) — local `source` path override
- [Terraform override.tf for local dev](https://developer.hashicorp.com/terraform/language/block/module) — swapping registry source to local path

### Backstage

- [Backstage Static Configuration Docs](https://backstage.io/docs/conf/) — `app-config.yaml`, `app-config.local.yaml`, `APP_CONFIG_` env vars, loading priority

### GitHub Apps

- [Syncing GitHub repository settings at scale — roger.ml](https://www.roger.ml/p/syncing-github-repository-settings) — `.github/settings.yml` pattern, per-repo config
- [GitHub Workflows documentation — GitHub Docs](https://docs.github.com/en/actions/using-workflows/about-workflows) — `.github/workflows/` per-repo
- [Reusing workflows — GitHub Docs](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)

### Raycast

- [Raycast Manifest reference — Raycast API](https://developers.raycast.com/information/manifest) — `preferences` schema, `type: "password"`, extension vs command level
- [Raycast Preferences API reference](https://developers.raycast.com/api-reference/preferences) — inheritance, keychain storage
- [Raycast Security docs](https://developers.raycast.com/information/security) — keychain integration, rejection of raw Keychain Access
- [Contribute to an Extension — Raycast API](https://developers.raycast.com/basics/contribute-to-an-extension) — Fork Extension action workflow
- [Publish an Extension — Raycast API](https://developers.raycast.com/basics/publish-an-extension) — `npm run publish` → automatic GitHub PR to raycast/extensions
- [Forked Extensions community tool — Raycast API](https://developers.raycast.com/information/developer-tools/forked-extensions) — sparse-checkout mechanism

### npm / pnpm Linking

- [pnpm workspaces docs](https://pnpm.io/workspaces) — workspace protocol, `linkWorkspacePackages`
- [pnpm link docs](https://pnpm.io/cli/link) — symlinking local packages
- [Developing shared npm packages locally — CodingKiwi](https://blog.coding.kiwi/npm-composer-local-package-development/)

### Git Submodules vs Subtrees

- [Git Subtree: Alternative to Git Submodule — Atlassian](https://www.atlassian.com/git/tutorials/git-subtree) — `git subtree push --prefix=...` for upstream contribution
- [Git Submodule vs Subtree — GeeksforGeeks](https://www.geeksforgeeks.org/git/git-subtree-vs-git-submodule/)
- [Git Subtree for tracking upstream apps — Giant Swarm Handbook](https://handbook.giantswarm.io/docs/product/managed-apps/dev-experience/git-subtree/) — real-world subtree workflow

### Homebrew

- [How to Open a Homebrew Pull Request — Homebrew Documentation](https://docs.brew.sh/How-To-Open-a-Homebrew-Pull-Request) — `brew edit`, test, PR workflow

---

## Research Gaps & Limitations

- **Raycast sparse-checkout mechanism**: The exact `git sparse-checkout` invocation used by the "Fork Extension" action is not publicly documented; behavior inferred from the Forked Extensions community tool docs and issue tracker
- **Oh My Zsh per-project**: OMZ has no official per-project config layer; the gap is filled by `direnv` (not surveyed in depth)
- **JetBrains plugins**: Not surveyed; likely similar scope model to VS Code
- **WordPress plugins**: Very different model (hosted `wp-admin` GUI, no CLI config discovery) — out of scope for developer-tools context
- **No ecosystem surveyed has fully automated "edit installed binary → open PR"**: The gap exists. Raycast is closest but only because of the centralized monorepo distribution model.

---

## Contradictions & Disputes

- **ESLint config discovery**: ESLint historically used cosmiconfig but switched to its own "flat config" system in v9 (`eslint.config.js` in cwd only, no upward walk). This is a deliberate break from the cosmiconfig model — ESLint's new stance is that config file discovery should be explicit and predictable, not implicit and crawling.

- **"Secrets in config files" debate**: Some teams commit non-sensitive credentials (read-only API keys, public token IDs) to `app-config.yaml` or similar. The Terraform community is split on whether `terraform.tfvars` should always be gitignored. The consensus for genuinely sensitive values (write-capable tokens, private keys) is universal: never in committed files.

---

## Search Methodology

- Searches performed: 16
- Most productive search terms: "cosmiconfig search places directory walk stopDir", "VS Code extension scope machine resource workspace settings secrets", "Raycast Fork Extension npm run publish upstream PR", "git subtree push prefix upstream", "Terraform local module override source path", "Backstage app-config.local.yaml gitignore"
- Primary information sources: Official documentation (cosmiconfig GitHub README, VS Code API docs, Raycast API docs, HashiCorp Developer docs, Backstage docs, GitHub Docs), npm package pages, engineering blog posts
