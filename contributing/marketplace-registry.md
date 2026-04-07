# Marketplace Registry

The `dorkos-community/marketplace` GitHub repository is the canonical registry for the DorkOS Marketplace. It hosts `marketplace.json` (the source of truth that `dorkos.ai/marketplace` and every DorkOS client read), the contributor-facing submission docs, the GitHub Actions validation workflow, and the branch-protection rules that keep the registry trustworthy.

This guide documents the registry repo layout, the JSON schema it serves, the submission flow contributors follow, and the operational settings (Actions workflow, branch protection, CODEOWNERS) maintainers configure when bootstrapping the org. The actual seed package repos (`code-reviewer`, `security-auditor`, etc.) live alongside the registry under the same `dorkos-community` org but are out of scope for this guide.

Pair this guide with:

- [`specs/marketplace-04-web-and-registry/02-specification.md`](../specs/marketplace-04-web-and-registry/02-specification.md) — the authoritative spec. If this guide and the spec disagree, the spec wins and this file needs a patch.
- [`contributing/marketplace-installs.md`](marketplace-installs.md) — the install pipeline that consumes a resolved package source from the registry.
- [`contributing/marketplace-packages.md`](marketplace-packages.md) — package authoring (`dorkos package init`, manifest schema, layer rules).
- [`packages/marketplace/src/marketplace-json-schema.ts`](../packages/marketplace/src/marketplace-json-schema.ts) — the Zod schema that defines `marketplace.json` and is run by `dorkos package validate-marketplace`.

## 1. Overview

The registry repo is intentionally minimal: a single JSON file that lists every published package, plus the docs and Actions plumbing required to keep that file trustworthy. It is **not** the install pipeline, **not** a package host, and **not** a CDN. It is a source-of-truth manifest, mirrored once per hour by `dorkos.ai/marketplace` (Next.js ISR) and by every DorkOS client that runs `dorkos install`.

The registry exists for three reasons:

1. **Discovery without installation.** Anyone can browse `https://dorkos.ai/marketplace` and learn what DorkOS does without running a single command. The web pages SSG-render directly from `marketplace.json`.
2. **Deterministic install.** `dorkos install <name>` resolves the short package name to a real GitHub URL via `marketplace.json`. There is no central package host — each package lives in its own public git repo.
3. **Auditable curation.** Every addition or change to `marketplace.json` lands via a pull request that runs `dorkos package validate-remote` against the submitted source. Maintainers review the PR. Branch protection prevents direct pushes to `main`.

## 2. Repo layout

```
dorkos-community/marketplace/
├── marketplace.json                  # The registry index
├── README.md                         # Public-facing description
├── CONTRIBUTING.md                   # How to submit a package
├── CODE_OF_CONDUCT.md
├── LICENSE                           # MIT
└── .github/
    └── workflows/
        ├── validate-submission.yml   # Runs `dorkos package validate` on PRs
        └── publish-update.yml        # Notifies dorkos.ai when registry changes
```

The repo is publicly browsable. `marketplace.json` is served via the GitHub raw URL (`https://raw.githubusercontent.com/dorkos-community/marketplace/main/marketplace.json`) and consumed by both `apps/site` and the DorkOS server. There is no separate API in front of it — GitHub raw is the API.

## 3. `marketplace.json` schema

`marketplace.json` is a Claude Code-compatible marketplace document with optional DorkOS extension fields. The Zod schema lives in [`packages/marketplace/src/marketplace-json-schema.ts`](../packages/marketplace/src/marketplace-json-schema.ts) and is the single source of truth for what fields are valid. Both the GitHub Actions workflow and `apps/site` parse `marketplace.json` against this schema.

Per-package fields fall into two disjoint groups:

- **Standard Claude Code fields** — `name`, `source`, `description`, `version`, `author`, `homepage`, `repository`, `license`, `keywords`. These are the only fields Claude Code's parser is guaranteed to understand.
- **DorkOS extension fields** — `type`, `category`, `tags`, `icon`, `layers`, `featured`. These power the browse/filter experience on `dorkos.ai/marketplace` without requiring every package to be cloned.

Both the per-entry schema and the top-level document schema use `.passthrough()` so unknown fields survive a parse/serialize round-trip — the format may grow new fields and the registry should never silently strip them.

The `featured` field is set by maintainers, not contributors. Contributor PRs that set `featured: true` will be asked to remove it before merge.

<details>
<summary>Initial seed payload (8 packages — verbatim from spec)</summary>

```json
{
  "name": "dorkos-community",
  "description": "Official community marketplace for DorkOS — agents, plugins, skill packs, and adapters",
  "plugins": [
    {
      "name": "code-reviewer",
      "source": "https://github.com/dorkos-community/code-reviewer",
      "description": "Reviews your PRs every weekday morning, posts findings to Slack, files Linear issues for blockers",
      "type": "agent",
      "category": "code-quality",
      "tags": ["review", "pr", "ci"],
      "icon": "🔍",
      "featured": true
    },
    {
      "name": "security-auditor",
      "source": "https://github.com/dorkos-community/security-auditor",
      "description": "Weekly dependency vulnerability scans, secret detection, and license compliance audits",
      "type": "agent",
      "category": "security",
      "tags": ["audit", "security", "dependencies"],
      "icon": "🛡️",
      "featured": true
    },
    {
      "name": "docs-keeper",
      "source": "https://github.com/dorkos-community/docs-keeper",
      "description": "Watches code changes, suggests documentation updates, keeps READMEs in sync with reality",
      "type": "agent",
      "category": "documentation",
      "tags": ["docs", "maintenance"],
      "icon": "📚",
      "featured": true
    },
    {
      "name": "linear-integration",
      "source": "https://github.com/dorkos-community/linear-integration",
      "description": "Linear status dashboard extension and webhook adapter for issue notifications",
      "type": "plugin",
      "category": "integration",
      "tags": ["linear", "issues"],
      "layers": ["extensions", "adapters"],
      "icon": "📋"
    },
    {
      "name": "posthog-monitor",
      "source": "https://github.com/dorkos-community/posthog-monitor",
      "description": "PostHog dashboard widget and error alerting for your DorkOS sidebar",
      "type": "plugin",
      "category": "observability",
      "tags": ["analytics", "monitoring", "errors"],
      "layers": ["extensions", "tasks"],
      "icon": "📊"
    },
    {
      "name": "security-audit-pack",
      "source": "https://github.com/dorkos-community/security-audit-pack",
      "description": "Scheduled security audit tasks: dependency scanning, secret detection, license checks",
      "type": "skill-pack",
      "category": "security",
      "tags": ["audit", "tasks"],
      "layers": ["tasks"],
      "icon": "🔐"
    },
    {
      "name": "release-pack",
      "source": "https://github.com/dorkos-community/release-pack",
      "description": "Tasks for version bumping, changelog generation, and git tagging",
      "type": "skill-pack",
      "category": "release",
      "tags": ["release", "versioning", "changelog"],
      "layers": ["tasks", "skills"],
      "icon": "🚀"
    },
    {
      "name": "discord-adapter",
      "source": "https://github.com/dorkos-community/discord-adapter",
      "description": "Discord relay adapter — bridge agent messages to Discord channels and DMs",
      "type": "adapter",
      "category": "messaging",
      "tags": ["discord", "chat"],
      "layers": ["adapters"],
      "icon": "💬"
    }
  ]
}
```

The seed contains exactly 3 agents, 2 plugins, 2 skill-packs, and 1 adapter — a 3+2+2+1 type distribution that the fixture validation test in `packages/marketplace/__tests__/` asserts on every CI run.

</details>

## 4. Submission flow

The contributor-facing submission flow lives in `dorkos-community/marketplace/CONTRIBUTING.md`. The canonical contents are reproduced below verbatim — when updating the registry repo's `CONTRIBUTING.md`, copy from this section, not the spec, so we have a single source of truth in the DorkOS repo.

`dorkos-community/marketplace/CONTRIBUTING.md`:

```markdown
# Submitting a Package to the DorkOS Marketplace

## Quick Start

1. Build your package using `dorkos package init <name> --type <type>`
2. Develop, test locally with `dorkos package validate`
3. Push your package to a public GitHub repo
4. Open a PR to this repo adding your package to `marketplace.json`

## Submission Checklist

- [ ] Package builds and validates with `dorkos package validate`
- [ ] README explains what the package does and any required setup
- [ ] LICENSE file present (MIT, Apache-2.0, or compatible)
- [ ] No hardcoded secrets or credentials
- [ ] External hosts declared in `.dork/manifest.json`
- [ ] If type is `plugin`, includes `.claude-plugin/plugin.json`

## PR Format

Add your package to the `plugins` array in `marketplace.json`, alphabetically ordered:

\`\`\`json
{
"name": "your-package-name",
"source": "https://github.com/your-username/your-package",
"description": "What it does in one sentence",
"type": "plugin",
"category": "your-category",
"tags": ["relevant", "tags"],
"icon": "📦"
}
\`\`\`

The `featured` field is set by maintainers, not contributors.

## Validation

Our GitHub Actions workflow runs `dorkos package validate` on every submission.
PRs failing validation cannot be merged.

## Review

A maintainer will review your submission within 7 days. We check:

- Package quality and usefulness
- Code safety (no obvious malware or supply chain risks)
- Description accuracy
- Category appropriateness
```

## 5. GitHub Actions workflow

`validate-submission.yml` runs on every pull request that touches `marketplace.json`. It installs the published `dorkos` CLI, runs `dorkos package validate-marketplace` against the modified file (which catches schema violations and duplicate names), and then iterates every entry in the `plugins` array running `dorkos package validate-remote` against each source URL. `validate-remote` shallow-clones the package into a temp directory and runs the full `validatePackage` pipeline against it.

Both CLI subcommands are added to `packages/cli` as part of spec 04 — they are not built specifically for the workflow, they are reusable validators that the workflow happens to call.

`.github/workflows/validate-submission.yml`:

```yaml
name: Validate Submission
on:
  pull_request:
    paths:
      - 'marketplace.json'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - name: Install dorkos CLI
        run: pnpm install -g dorkos
      - name: Validate marketplace.json
        run: dorkos package validate-marketplace marketplace.json
      - name: Validate each new package
        run: |
          for pkg in $(jq -r '.plugins[].source' marketplace.json); do
            dorkos package validate-remote "$pkg"
          done
```

A second workflow, `publish-update.yml`, fires after merge to `main` and notifies `dorkos.ai` so the next ISR revalidation picks up the change immediately instead of waiting for the hourly window. The exact webhook payload is owned by `apps/site` and is out of scope for this guide.

## 6. Branch protection

The `main` branch of `dorkos-community/marketplace` must be protected before the registry goes live. Required settings:

- **Require a pull request before merging** — no direct pushes to `main`, including from maintainers and admins.
- **Require status checks to pass before merging** — the `validate` job from `validate-submission.yml` is a required check.
- **Require branches to be up to date before merging** — prevents stale PRs from merging an outdated `marketplace.json` over a newer one.
- **Require review from a code owner** — at least one maintainer listed in `CODEOWNERS` must approve.
- **Include administrators** — the rules apply to org admins as well, so a compromised admin account cannot push a malicious payload to `main` without going through the workflow.
- **Restrict who can dismiss pull request reviews** — only maintainers, never the PR author.
- **Do not allow force pushes or branch deletion** — the registry's history is auditable; rewriting it is never acceptable.

These settings are the contractual mitigation for the "submission spam / low-quality PRs" risk in the spec — they guarantee that nothing reaches `main` without both automated validation and human review.

## 7. CODEOWNERS

`CODEOWNERS` lives at `.github/CODEOWNERS` in the registry repo and lists the maintainers who must approve every change. At minimum:

```
# Every change to the registry requires a maintainer review.
*                       @dorkos-community/maintainers

# marketplace.json is the source of truth — review extra carefully.
/marketplace.json       @dorkos-community/maintainers

# Workflow changes affect every future submission.
/.github/workflows/     @dorkos-community/maintainers
```

`@dorkos-community/maintainers` is a GitHub team inside the `dorkos-community` org. Adding or removing someone from that team is itself a sensitive operation and should go through a public discussion in an issue.

When the registry expands beyond its initial maintainer set, consider splitting CODEOWNERS by package category (e.g. `@dorkos-community/security-reviewers` for entries tagged `category: security`) to spread review load and let domain experts gate their own area. The single-team setup is the right starting point — split only when review latency becomes the bottleneck.
