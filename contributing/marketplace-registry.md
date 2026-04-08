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

**`pluginRoot` + relative sources — read this carefully.** CC 2.1.92
**ignores** `metadata.pluginRoot` whenever a `source` starts with an
explicit `./`. The leading `./` is treated as absolute-from-marketplace-
root, not relative-to-pluginRoot. So with `pluginRoot: "./plugins"`,
the entry **must** be `"source": "./plugins/<name>"` — NOT
`"source": "./<name>"`, which silently points at a directory that
doesn't exist and fails at `claude plugin install` time with
`Source path does not exist`.

Bare names (no `./`) DO honor `pluginRoot`, but CC 2.1.92 rejects bare
names during its schema validation. Net effect: always use the fully
explicit `"./<pluginRoot>/<name>"` form. The DorkOS CLI's
`marketplace validate` catches the `./<name>` regression at publish
time via a reachability probe — see the Validation section below.

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
5. Run `dorkos marketplace validate .claude-plugin/marketplace.json`
   locally. Exit 0 means your entry is ready to submit.
6. Open a PR against `main`.

Community plugins hosted in their own repos go through the same flow
except step 2 is skipped and step 3 uses the `github` or `git-subdir`
source form instead of a relative path.

## Validation

One CLI command gates submissions. It takes either a local filesystem
path or a remote HTTPS URL and auto-detects which mode to use:

```bash
# Validate a local marketplace.json file (with optional sidecar)
dorkos marketplace validate .claude-plugin/marketplace.json

# Validate a remote marketplace by URL (GitHub repo URL or direct raw URL)
dorkos marketplace validate https://github.com/dork-labs/marketplace
```

> **Back-compat:** The legacy `dorkos package validate-marketplace <path>`
> and `dorkos package validate-remote <url>` forms still work but emit a
> stderr deprecation notice. They'll be removed in a future release — use
> the `marketplace validate` form in new scripts and CI.

### What it does

Both invocation shapes run the same five checks against the same Zod
schemas (`@dorkos/marketplace`). Only the two top-level registry files
are schema-checked; the reachability probe (step 5) also verifies that
each relative-path plugin's `.claude-plugin/plugin.json` exists without
parsing it.

1. **Fetch / read.**
   - For a URL: HTTPS `fetch()` (not `git clone`) against
     `<repo>/raw/main/.claude-plugin/marketplace.json` and
     `<repo>/raw/main/.claude-plugin/dorkos.json`. The `main` branch is
     hardcoded; non-`main` default branches are not supported via the
     repo-URL shorthand. To target a different branch, pass a direct
     raw URL instead (anything ending in `marketplace.json` is passed
     through unchanged).
   - For a path: `fs.readFile()` on the target. If the file lives under
     `.claude-plugin/`, a sibling `dorkos.json` is read as the sidecar.

2. **DorkOS schema (passthrough).** Parses `marketplace.json` against
   DorkOS's schema. "Passthrough" means DorkOS accepts any CC-valid
   marketplace without requiring its own extra fields — the DorkOS
   extensions live in the sidecar.

3. **Sidecar parse (optional).** If `dorkos.json` is present, parses it
   against the sidecar schema (per-plugin `type`, `layers`, `pricing`,
   etc.). Absence is fine; invalid-when-present is fatal.

4. **Claude Code compatibility (strict).** Runs the same
   `marketplace.json` through DorkOS's port of the Claude Code validator
   (`@dorkos/marketplace` `cc-validator.ts`, kept in sync with upstream
   CC by a weekly cron — see ADR-0238). This is the load-bearing check
   for the strict-superset invariant: whatever DorkOS publishes must
   also pass `claude plugin validate`, unmodified, so a vanilla Claude
   Code install can consume the same registry.

5. **Plugin sources reachable.** For each plugin entry with a
   relative-path source, resolves the source via the same rules CC
   2.1.92 uses at install time (`@dorkos/marketplace` `resolvePluginSource`
   — crucially, `metadata.pluginRoot` is ignored when a source starts
   with an explicit `./`) and probes the resulting
   `<resolved>/.claude-plugin/plugin.json`. Local paths are `fs.stat`'d;
   remote URLs get a parallel `GET`. Object-form sources (`github`,
   `url`, `git-subdir`, `npm`) are skipped — CC clones those at install
   and the validator should not depend on external git hosts. This is
   the load-bearing check that prevents `./<name>` + `pluginRoot`
   regressions from shipping: schema shape alone can't catch them.

6. **Reserved-name check.** The marketplace's `name` field isn't on the
   reserved list (already enforced by the DorkOS schema — surfaced
   separately for a clearer error message).

### Exit codes

- `0` — all checks pass.
- `1` — fetch/read failed, JSON parse failed, DorkOS schema failed,
  sidecar present but invalid, or marketplace name is reserved.
- `2` — DorkOS schema passes but either **strict CC validation fails**
  OR a **plugin source is not reachable** (outbound regression). In
  both sub-cases your marketplace is valid-looking to DorkOS but will
  break for a Claude Code user. The fix for strict-schema failures is
  almost always: move the offending field into `.claude-plugin/dorkos.json`
  instead of inlining it in `marketplace.json`. The fix for
  unreachable-source failures is almost always: rewrite
  `"source": "./<name>"` as `"source": "./<pluginRoot>/<name>"` because
  CC ignores `pluginRoot` on explicit-`./` sources.

### What it does NOT validate

- **Plugin contents.** The reachability probe (check 5) confirms that
  each relative-path plugin's `.claude-plugin/plugin.json` _exists_,
  but it never _reads_ or _parses_ that file — nor any `SKILL.md` or
  per-package `README`. Individual packages can be broken (invalid
  `plugin.json`, missing components, bad YAML frontmatter) and this
  command will still exit 0 as long as the file exists and the
  top-level registry is well-formed. Use `dorkos package validate <path>`
  on individual packages to catch per-package regressions.
- **Installability.** Whether Claude Code or DorkOS can actually install
  one of the listed plugins is not checked. That's what
  `claude plugin install` and `dorkos install` prove end-to-end.
- **Runtime activation.** Whether a plugin's skills show up in a live
  agent session is not checked. That's a separate integration test.
- **Any branch other than `main`** (for the URL shorthand — pass a raw
  URL to override).

## Related ADRs

- [ADR-0236: Sidecar dorkos.json for Marketplace Extensions](../decisions/0236-sidecar-dorkos-json-for-marketplace-extensions.md)
- [ADR-0237: Same-Repo Monorepo for dork-labs/marketplace Seed](../decisions/0237-same-repo-monorepo-for-dork-labs-marketplace-seed.md)
- [ADR-0238: Port-to-Zod CC Validator with Weekly Sync Cron](../decisions/0238-port-to-zod-cc-validator-with-weekly-sync-cron.md)
- [ADR-0239: Plugin Runtime Activation via Claude Agent SDK options.plugins](../decisions/0239-plugin-runtime-activation-via-claude-agent-sdk-options-plugins.md)
