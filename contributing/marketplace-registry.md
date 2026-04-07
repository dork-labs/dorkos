# Marketplace Registry

This guide describes the format of the DorkOS marketplace registry that
powers browse, install, and telemetry. The registry format is a **strict
superset** of Claude Code's `marketplace.json` format — every registry
this guide covers is valid for BOTH `claude plugin validate` AND DorkOS's
install pipeline. DorkOS-specific extensions live in a sidecar file
(`dorkos.json`) that CC ignores entirely.

> **Why a strict superset?** See ADR-0236. Empirical verification against
> Claude Code 2.1.92 confirmed that CC's validator enforces
> `additionalProperties: false` on plugin entries — any inline
> `x-dorkos-*` field is rejected. The sidecar strategy is the only safe
> extension mechanism.

## Repository layout (Dork Labs seed)

The canonical Dork Labs marketplace lives at
`github.com/dork-labs/marketplace` using the **same-repo monorepo**
pattern (ADR-0237):

```
dork-labs/marketplace/
├── .claude-plugin/
│   ├── marketplace.json      # CC-standard registry
│   └── dorkos.json           # DorkOS extension sidecar
├── plugins/
│   ├── code-reviewer/
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json   # CC plugin manifest
│   │   ├── README.md
│   │   └── skills/code-reviewer/SKILL.md
│   ├── security-auditor/
│   └── ...
├── CONTRIBUTING.md
└── README.md
```

A reference copy of this layout lives in
`packages/marketplace/fixtures/dorkos-seed/` and is exercised by both
the schema tests and the Direction A bidirectional tests
(`packages/marketplace/src/__tests__/cc-compat.test.ts`).

Community contributors continue to host plugins in their own repos —
the registry references them via the `github`, `url`, or `git-subdir`
source forms. The monorepo pattern is the Dork Labs default, not a
requirement.

## `marketplace.json` schema

The top-level document has three required fields (`name`, `owner`,
`plugins`) plus optional `metadata`:

```json
{
  "name": "dorkos",
  "owner": { "name": "Dork Labs", "email": "hello@dorkos.ai" },
  "metadata": {
    "description": "Official marketplace for DorkOS",
    "version": "0.1.0",
    "pluginRoot": "./plugins"
  },
  "plugins": [ … ]
}
```

### Five source forms

Each plugin entry's `source` is a discriminated union. The DorkOS install
pipeline dispatches on the discriminator.

**1. Relative path** — bare string starting with `./`, resolved against
the marketplace clone root. Used for same-repo monorepos:

```json
{ "name": "code-reviewer", "source": "./code-reviewer" }
```

When `metadata.pluginRoot` is set, entries can use the explicit path form
`"./<name>"` so `pluginRoot` is implicit. Bare names without `./` are
NOT accepted by Claude Code 2.1.92 — always include the `./` prefix.

**2. GitHub object** — canonical form for GitHub-hosted plugins:

```json
{
  "name": "code-reviewer",
  "source": {
    "source": "github",
    "repo": "owner/repo",
    "ref": "main",
    "sha": "<optional 40-char hex>"
  }
}
```

**3. URL object** — generic git-cloneable URL (GitLab, Bitbucket, Gitea,
Azure DevOps, self-hosted):

```json
{
  "name": "code-reviewer",
  "source": { "source": "url", "url": "https://gitlab.com/owner/repo.git" }
}
```

**4. git-subdir object** — sparse clone of a subdirectory inside a
monorepo. DorkOS uses partial sparse clone (`--filter=blob:none` +
cone-mode sparse-checkout) with a 3-step fallback ladder for older
self-hosted git servers.

```json
{
  "name": "code-reviewer",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/owner/monorepo.git",
    "path": "plugins/code-reviewer"
  }
}
```

**5. npm object** — package reference. The install pipeline currently
throws `NpmSourceNotSupportedError`; full implementation is tracked in
spec `marketplace-06-npm-sources`.

```json
{
  "name": "code-reviewer",
  "source": {
    "source": "npm",
    "package": "@dorkos/code-reviewer",
    "version": "^1.0.0"
  }
}
```

### Plugin entry fields

CC-standard fields only. Anything else must go in the sidecar.

| Field         | Type                    | Notes                                    |
| ------------- | ----------------------- | ---------------------------------------- |
| `name`        | kebab-case string       | Required                                 |
| `source`      | discriminated union     | Required                                 |
| `description` | string                  | Optional                                 |
| `version`     | semver string           | Optional                                 |
| `author`      | `{ name, email? }`      | **Object shape**, not bare string        |
| `homepage`    | URL                     | Optional                                 |
| `repository`  | URL                     | Optional                                 |
| `license`     | string ≤64 chars        | Optional                                 |
| `keywords`    | string[] ≤50            | Optional                                 |
| `category`    | string ≤64 chars        | Optional                                 |
| `tags`        | string[] ≤20 (≤32 each) | Optional                                 |
| `strict`      | boolean                 | Optional — CC strict mode                |
| `commands`    | unknown                 | CC component fields — opaque passthrough |
| `agents`      | unknown                 | Same                                     |
| `hooks`       | unknown                 | Same                                     |
| `mcpServers`  | unknown                 | Same                                     |
| `lspServers`  | unknown                 | Same                                     |

## Sidecar `dorkos.json`

The sidecar lives at `.claude-plugin/dorkos.json` alongside
`marketplace.json` and is indexed by plugin name. It holds every
DorkOS-specific field — `type`, `layers`, `requires`, `featured`,
`icon`, `dorkosMinVersion`, `pricing`.

```json
{
  "$schema": "https://dorkos.ai/schemas/dorkos-marketplace.schema.json",
  "schemaVersion": 1,
  "plugins": {
    "code-reviewer": {
      "type": "agent",
      "layers": ["agents", "tasks"],
      "icon": "🔍",
      "featured": true,
      "pricing": { "model": "free" }
    }
  }
}
```

### Drift handling rules

1. Plugin in `marketplace.json` but NOT in `dorkos.json` → merged entry
   has `dorkos: undefined`. Consumers treat it as a default `plugin`
   with no extensions. NOT an error.
2. Plugin in `dorkos.json` but NOT in `marketplace.json` → added to the
   merge helper's `orphans` list. Callers log a warning and drop the
   orphan from merged output. NOT an error.

See `packages/marketplace/src/merge-marketplace.ts` for the merge helper
and the test suite that exercises both cases.

## `metadata.pluginRoot` semantics

`pluginRoot` lets same-repo monorepos elide the `./plugins/` prefix on
every entry. The resolver applies these rules exactly (ordered):

1. Object-form sources (`github`, `url`, `git-subdir`, `npm`) **always
   ignore `pluginRoot`**.
2. Relative-path sources starting with an explicit `./` are resolved
   against `<marketplaceRoot>/<source>` — `pluginRoot` is **ignored**
   because the leading `./` is explicit.
3. Bare names (no `./`) are resolved against
   `<marketplaceRoot>/<pluginRoot>/<name>`. **Note:** CC 2.1.92 does
   not accept bare names — always use the explicit `./<name>` form.
4. Trailing slashes on `pluginRoot` are normalized.
5. Absolute paths in `pluginRoot` throw `ResolvePluginSourceError`.
6. Any `..` traversal in `pluginRoot` or `source` throws
   `ResolvePluginSourceError`.

## Reserved marketplace names

CC reserves 8 marketplace names for official use and impersonation
prevention. DorkOS's schema rejects them via `.refine()`:

- `claude-code-marketplace`
- `claude-code-plugins`
- `claude-plugins-official`
- `anthropic-marketplace`
- `anthropic-plugins`
- `agent-skills`
- `knowledge-work-plugins`
- `life-sciences`

## Strict superset framing

**Outbound invariant**: Any `marketplace.json` produced against DorkOS's
schema, using only CC-standard fields, must pass `claude plugin validate`.
DorkOS extensions live in the sidecar.

**Inbound invariant**: Any `marketplace.json` that passes `claude plugin
validate` must install successfully via DorkOS's pipeline. No manual
conversion. No import step. Native consumption.

The `cc-validator.ts` module in `@dorkos/marketplace` ports CC's schema
to strict-mode Zod and serves as the outbound oracle. The sync-direction
invariant (ADR-0238) is load-bearing: **`cc-validator.ts` MUST NOT be
stricter than CC's actual CLI behavior**. Looser-than-CC is acceptable;
stricter-than-CC is a regression.

The weekly sync cron at `.github/workflows/cc-schema-sync.yml` fetches
`hesreallyhim/claude-code-json-schema` and opens a PR labeled
`cc-schema-drift` when the DorkOS port has drifted from the upstream
reference.

## Submission flow

To contribute a new package to the Dork Labs seed:

1. Fork `github.com/dork-labs/marketplace`.
2. Add a new `plugins/<name>/` directory with at minimum:
   - `.claude-plugin/plugin.json` (CC manifest stub)
   - `README.md`
3. Add the entry to `.claude-plugin/marketplace.json` with
   `"source": "./<name>"` and CC-standard metadata.
4. Add the sidecar entry to `.claude-plugin/dorkos.json` with the
   DorkOS type, layers, and pricing.
5. Run `dorkos package validate-marketplace .claude-plugin/marketplace.json`
   locally. Exit 0 means your entry is ready to submit.
6. Open a PR against `main`.

Community plugins hosted in their own repos go through the same flow
except step 2 is skipped and step 3 uses the `github` or `git-subdir`
source form instead of a relative path.

## Validation

Two CLI commands gate submissions:

```bash
# Validate a local marketplace.json file (with optional sidecar)
dorkos package validate-marketplace .claude-plugin/marketplace.json

# Validate a remote marketplace by URL
dorkos package validate-remote https://github.com/dork-labs/marketplace
```

Exit codes (both commands):

- `0` — all checks pass
- `1` — fetch/parse failed, DorkOS schema failed, sidecar invalid, or reserved name
- `2` — DorkOS schema passes but strict CC compatibility fails (outbound regression)

Exit code 2 specifically means "your marketplace is valid for DorkOS but
will break `claude plugin validate` — move the offending field to the
sidecar."

## Related ADRs

- [ADR-0236: Sidecar dorkos.json for Marketplace Extensions](../decisions/0236-sidecar-dorkos-json-for-marketplace-extensions.md)
- [ADR-0237: Same-Repo Monorepo for dork-labs/marketplace Seed](../decisions/0237-same-repo-monorepo-for-dork-labs-marketplace-seed.md)
- [ADR-0238: Port-to-Zod CC Validator with Weekly Sync Cron](../decisions/0238-port-to-zod-cc-validator-with-weekly-sync-cron.md)
- [ADR-0239: Plugin Runtime Activation via Claude Agent SDK options.plugins](../decisions/0239-plugin-runtime-activation-via-claude-agent-sdk-options-plugins.md)
