---
title: 'Claude Code Plugin Marketplace: marketplace.json Schema & Validation Bug Analysis'
date: 2026-03-23
type: external-best-practices
status: active
tags: [claude-code, plugins, marketplace, schema, validation, source-field]
searches_performed: 5
sources_count: 8
---

## Research Summary

The Claude Code official plugin marketplace (`claude-plugins-official`) uses a `marketplace.json` schema supporting five source types for plugin entries: relative path string, `github`, `url`, `git-subdir`, and `npm`. A recurring class of schema validation bugs has caused the entire marketplace to fail loading when any single plugin entry contains an unrecognized or invalid `source` field. The most impactful instance (Issue #33739) was caused by the `git-subdir` source type not being recognized by the validator in older Claude Code versions, failing 200+ plugins when only one entry was malformed. This was fixed in v2.1.77.

---

## Key Findings

1. **`source` field is polymorphic** — it is either a plain string (relative path starting with `./`) or an object with a discriminant `source` key set to one of: `"github"`, `"url"`, `"git-subdir"`, or `"npm"`. The object form wraps its type discriminant in a field also named `source`, creating a nested `source.source` structure.

2. **Fail-all validation behavior** — when any plugin entry in `marketplace.json` fails schema validation, the entire marketplace refuses to load. There is no graceful skip-and-continue. This was the root cause of multiple high-impact bugs affecting all users of the official marketplace.

3. **Multiple known validation bugs** — at least four distinct GitHub issues document schema validation failures against the official `claude-plugins-official` marketplace across different Claude Code versions (v2.0.76, v2.1.58, v2.1.69+). Each involves a different root cause, but all produce the same symptom: `plugins.N.source: Invalid input`.

4. **`git-subdir` was the most recent blocker** — Issue #33739 and #34567 document that plugins 56, 63, 67, 71–75 in the official marketplace use `git-subdir` source objects that older validator versions did not recognize, breaking the marketplace entirely. Fixed in v2.1.77.

5. **Field bleed into cached `plugin.json`** — Issue #26555 documents a separate bug where marketplace-level fields (`category`, `source`) leak into the cached per-plugin `plugin.json`, causing a second round of validation failures when the validator then rejects unrecognized keys in the plugin manifest schema.

---

## Detailed Analysis

### marketplace.json Top-Level Structure

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "claude-plugins-official",
  "description": "Directory of popular Claude Code extensions...",
  "owner": {
    "name": "Anthropic",
    "email": "support@anthropic.com"
  },
  "plugins": [ ... ]
}
```

**Required top-level fields:** `name` (kebab-case string), `owner` (object with `name`), `plugins` (array).

**Optional top-level fields:**

- `metadata.description` — human-readable marketplace description
- `metadata.version` — marketplace version string
- `metadata.pluginRoot` — base path prepended to relative plugin `source` strings

---

### The `source` Field — All Supported Formats

#### 1. Relative Path (string)

```json
{
  "name": "quality-review-plugin",
  "source": "./plugins/quality-review"
}
```

- Must start with `./`
- Cannot contain `..`
- Resolves relative to the marketplace repository root (not to `.claude-plugin/`)
- Only works when the marketplace is added via Git clone, not via a direct URL to `marketplace.json`

#### 2. GitHub Repository (object, `source: "github"`)

```json
{
  "name": "my-plugin",
  "source": {
    "source": "github",
    "repo": "owner/plugin-repo",
    "ref": "v2.0.0",
    "sha": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
  }
}
```

| Field  | Required | Description                                |
| ------ | -------- | ------------------------------------------ |
| `repo` | Yes      | `owner/repo` shorthand                     |
| `ref`  | No       | Branch or tag (defaults to default branch) |
| `sha`  | No       | Full 40-char commit SHA for exact pinning  |

#### 3. Git URL (object, `source: "url"`)

```json
{
  "name": "my-plugin",
  "source": {
    "source": "url",
    "url": "https://gitlab.com/team/plugin.git",
    "ref": "main",
    "sha": "a1b2c3d4..."
  }
}
```

| Field | Required | Description                                                     |
| ----- | -------- | --------------------------------------------------------------- |
| `url` | Yes      | Full git URL (`https://` or `git@`). `.git` suffix is optional. |
| `ref` | No       | Branch or tag                                                   |
| `sha` | No       | Full 40-char SHA                                                |

#### 4. Git Subdirectory (object, `source: "git-subdir"`)

```json
{
  "name": "my-plugin",
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/acme-corp/monorepo.git",
    "path": "tools/claude-plugin",
    "ref": "v2.0.0",
    "sha": "a1b2c3d4..."
  }
}
```

Performs a sparse, partial clone to fetch only the subdirectory. The `url` field also accepts GitHub `owner/repo` shorthand or SSH URLs.

| Field  | Required | Description                           |
| ------ | -------- | ------------------------------------- |
| `url`  | Yes      | Git URL, GitHub shorthand, or SSH URL |
| `path` | Yes      | Subdirectory path within the repo     |
| `ref`  | No       | Branch or tag                         |
| `sha`  | No       | Full 40-char SHA                      |

**This is the source type that triggered the most widespread marketplace failure (Issue #33739).**

#### 5. npm Package (object, `source: "npm"`)

```json
{
  "name": "my-npm-plugin",
  "source": {
    "source": "npm",
    "package": "@acme/claude-plugin",
    "version": "2.1.0",
    "registry": "https://npm.example.com"
  }
}
```

| Field      | Required | Description                    |
| ---------- | -------- | ------------------------------ |
| `package`  | Yes      | Package name or scoped package |
| `version`  | No       | Version or semver range        |
| `registry` | No       | Custom registry URL            |

---

### Plugin Entry — Full Field Reference

Each entry in the `plugins` array supports these fields:

**Required:**

- `name` — kebab-case identifier (public-facing, used in `/plugin install name@marketplace`)
- `source` — one of the five formats above

**Optional metadata:**

- `description`, `version`, `author` (`name` + optional `email`), `homepage`, `repository`, `license`, `keywords`, `category`, `tags`
- `strict` (boolean, default `true`) — whether `plugin.json` is the authority for component definitions

**Optional component configuration:**

- `commands`, `agents`, `hooks`, `mcpServers`, `lspServers` — can inline definitions or provide paths

---

### Validation Bug History

#### Issue #33739 — `git-subdir` unrecognized by schema validator (affects all versions before v2.1.77)

- **Error:** `plugins.56.source: Invalid input` (and indices 63, 67, 71–75)
- **Root cause:** The `git-subdir` source type was added to the official marketplace before the schema validator in Claude Code recognized it
- **Impact:** All 200+ plugins in `claude-plugins-official` failed to load
- **Fix:** Resolved in Claude Code v2.1.77
- **Workaround (older versions):** Upgrade to v2.1.77, or use native installer instead of npm

#### Issue #34567 — Schema validation errors on v2.1.58

- **Error:** `plugins.56.source: Invalid input, plugins.63.source: Invalid input, plugins.67.source: Invalid input, plugins.71.source: Invalid input, plugins.72.source: Invalid input, plugins.73.source: Invalid input, plugins.74.source: Invalid input, plugins.75.source: Invalid input`
- **Root cause:** Same `git-subdir` validator gap, surfaced across more indices as the official marketplace grew
- **Status:** Closed/redirected to `claude-plugins-official#765`

#### Issue #15198 — Reserved name validation blocks official marketplace when launched from Claude Desktop Code tab (v2.0.76)

- **Error:** `Invalid schema: name: Marketplace name cannot impersonate official Anthropic/Claude marketplaces. Names containing "official", "anthropic", or "claude" in official-sounding combinations are reserved.`
- **Root cause:** The reserved-name exemption for `claude-plugins-official` did not apply when the CLI was launched through the Claude Desktop Code tab (regression from fix in v2.0.72/#14477)
- **Impact:** Affects only users launching Claude Code via Claude Desktop's Code tab, not terminal launch
- **Status:** Closed as NOT_PLANNED after 30 days of inactivity

#### Issue #26555 — `category` and `source` fields bleed into cached `plugin.json`

- **Root cause:** When Claude Code fetches a URL-sourced external plugin, marketplace-level fields (`source`, `category`) are written into the cached per-plugin `plugin.json`. The plugin manifest schema does not recognize these fields, causing a second validation failure.
- **Impact:** Plugins that install appear broken on subsequent loads

#### Issue #20423 — `$schema` field validation triggers reserved-word check incorrectly

- **Root cause:** The validator's reserved-word scan for marketplace names was incorrectly applied to the `$schema` field value as well
- **Impact:** Any marketplace whose `$schema` URL contained "claude" or "official" could fail validation

---

### Naming Restrictions

The following marketplace names are reserved and cannot be used by third-party operators:

- `claude-code-marketplace`
- `claude-code-plugins`
- `claude-plugins-official`
- `anthropic-marketplace`
- `anthropic-plugins`
- `agent-skills`
- `knowledge-work-plugins`
- `life-sciences`

Names that "impersonate" official marketplaces (e.g., `official-claude-plugins`, `anthropic-tools-v2`) are also blocked — but as Issue #15198 demonstrates, the exemption logic for the actual official marketplace has had regression bugs.

---

### Validation Tool

The official validator can be run before publishing:

```bash
claude plugin validate .
# or from within Claude Code:
/plugin validate .
```

Common validation errors and their fixes are documented in the official docs. The most relevant for `source` fields:

| Error                                   | Cause                                               | Fix                                                                                                                                     |
| --------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins[N].source: Invalid input`      | Unrecognized source type or malformed source object | Upgrade Claude Code to v2.1.77+; verify `source` discriminant is one of `github`, `url`, `git-subdir`, `npm`, or a `./`-prefixed string |
| `plugins[0].source: Path contains ".."` | Relative path escapes marketplace root              | Restructure directories; use a proper source type for external plugins                                                                  |

---

## Research Gaps & Limitations

- The exact JSON Schema at `https://anthropic.com/claude-code/marketplace.schema.json` was not directly fetched — the schema fields were inferred from documentation and GitHub issues
- It is unclear whether Issue #15198 (Claude Desktop Code tab launch path) was ever actually fixed or just closed due to inactivity
- The `claude-plugins-official` marketplace currently has 200+ plugins; the full list of plugin indices using `git-subdir` vs other source types was not enumerated

---

## Contradictions & Disputes

- Issue #15198 documents that the official marketplace's own name (`claude-plugins-official`) is blocked by the reserved-name validator — yet the same name is listed as reserved. The intent was to reserve the name _for_ Anthropic use while exempting Anthropic's own use. The exemption logic has had at least one regression.
- The official docs describe `git-subdir` as a fully supported source type, but it was not recognized by the validator until v2.1.77, creating a sustained period where the docs and the implementation were out of sync.

---

## Sources & Evidence

- [Official marketplace.json file](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json)
- [Claude Code Issue #33739 — Official marketplace fails to load entirely due to `git-subdir`](https://github.com/anthropics/claude-code/issues/33739)
- [Claude Code Issue #34567 — Schema validation errors on v2.1.58, plugins 56/63/67/71-75](https://github.com/anthropics/claude-code/issues/34567)
- [Claude Code Issue #15198 — Reserved name validation regression from Claude Desktop Code tab](https://github.com/anthropics/claude-code/issues/15198)
- [Claude Code Issue #26555 — `category` and `source` fields bleed into cached plugin.json](https://github.com/anthropics/claude-code/issues/26555)
- [Claude Code Issue #20423 — `$schema` field triggers reserved-words check](https://github.com/anthropics/claude-code/issues/20423)
- [Official Plugin Marketplaces Docs](https://code.claude.com/docs/en/plugin-marketplaces)
- [DeepWiki: claude-plugins-official Plugin Architecture](https://deepwiki.com/anthropics/claude-plugins-official/3-plugin-architecture)

---

## Search Methodology

- Searches performed: 5
- Most productive search terms: `github.com/anthropics/claude-plugins-official marketplace.json schema`, `Claude Code plugin marketplace "source" field schema validation "Invalid input"`
- Primary sources: GitHub Issues (anthropics/claude-code), official Claude Code docs (code.claude.com), direct GitHub file fetch
