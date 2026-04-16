---
title: 'Changelog Sources for @anthropic-ai/claude-agent-sdk'
date: 2026-04-16
type: implementation
status: active
tags: [claude-agent-sdk, changelog, runtime-upgrade, release-notes, anthropic]
feature_slug: codex-runtime-adapter-prework
searches_performed: 9
sources_count: 6
---

# Changelog Sources for `@anthropic-ai/claude-agent-sdk`

## Package Identity

- **npm package**: `@anthropic-ai/claude-agent-sdk`
- **Source repository**: `https://github.com/anthropics/claude-agent-sdk-typescript`
- **Current installed version in this repo**: `0.2.89`
- **Latest published version (as of 2026-04-16)**: `0.2.111`
- **Versions between installed and latest**: ~22 releases (0.2.89 → 0.2.111, with some version numbers skipped)
- **Release cadence**: 1–2 releases per day during active development

---

## Source 1: GitHub Releases Page

**URL**: `https://github.com/anthropics/claude-agent-sdk-typescript/releases`

**Exists and accessible**: Yes, fully public.

**Format**: GitHub-flavored Markdown release notes per tag. Each release is a separate page/entry anchored at `releases/tag/vX.Y.Z`.

**Completeness**:

- 87 total releases as of 2026-04-16
- All patch versions from 0.2.55+ have manually written release notes
- Release notes are **concise but substantive**: bullet-pointed features and fixes, no code examples
- Some versions (e.g. v0.2.104) have empty or minimal notes ("chore: Update CHANGELOG.md")
- Earlier versions (pre-0.2.x) may have thinner coverage

**Sample entry (v0.2.89)**:

- `startup()` method to pre-warm CLI subprocess
- `includeSystemMessages` option for `getSessionMessages()`
- `listSubagents()` and `getSubagentMessages()` for subagent history
- `includeHookEvents` option
- Six named bug fixes (stream errors, Zod v4, null side_question, etc.)

**Programmatic accessibility**:

- **GitHub REST API**: `GET https://api.github.com/repos/anthropics/claude-agent-sdk-typescript/releases` — returns JSON with `tag_name`, `published_at`, `body` (Markdown string), pagination via `per_page`/`page` params. **No auth required for public repos** (rate limit: 60 req/hr unauthenticated, 5000/hr authenticated).
- Can filter to a version range by fetching until `tag_name <= from_version`
- `body` field is raw Markdown — easy to render or strip to plain text
- Gaps: version numbers are not always sequential (e.g. 0.2.101, 0.2.98, 0.2.97 — versions 0.2.99, 0.2.100 do not appear in releases). This may indicate some patch versions were published to npm but not tagged as GitHub releases, or were retracted.

**Rating**: PRIMARY SOURCE — structured, programmatic, human-readable, covers individual versions with substantive notes.

---

## Source 2: CHANGELOG.md in the GitHub Repository

**URL**: `https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md`

**Exists and accessible**: Yes, file exists at repo root, publicly readable via raw.githubusercontent.com.

**Format**: Custom Markdown. Version headers as `## X.Y.Z` with unordered bullet lists of changes. Not strictly "Keep a Changelog" format. Dates are present for only a handful of entries (e.g., 0.2.0 on 2026-01-07, 0.1.77 on 2026-01-05); most entries have no date.

**Completeness**:

- Covers 0.1.0 through 0.2.111 — the most complete single-document coverage
- 100+ version entries
- Some entries are very thin ("Updated to parity with Claude Code v2.1.X")
- No dates on most entries makes timeline reconstruction harder without cross-referencing npm/GitHub

**Programmatic accessibility**:

- Fetch as plain text: `curl https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md`
- Must parse Markdown sections by `## X.Y.Z` headers — straightforward regex split
- Lack of per-entry timestamps requires secondary lookup (npm registry `time` field or GitHub releases API) to determine when a version was published
- Single HTTP request for the entire changelog vs. paginated GitHub releases API
- **Risk**: The file reflects the `main` branch tip — if a version's notes were added retroactively or amended after release, the file content may differ from what was true at release time

**Rating**: SECONDARY SOURCE — best for bulk historical lookups and offline parsing, but requires date enrichment from npm or GitHub API.

---

## Source 3: npm Registry Metadata

**URL**: `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk`

**Exists and accessible**: Yes, fully public.

**Format**: JSON. The `time` field maps every version string to an ISO 8601 publish timestamp. The `versions` field contains full `package.json` metadata per version but no changelog text.

**Completeness**:

- Every version ever published is present (including yanked/deprecated ones if any)
- Publish timestamps are authoritative — this is the ground truth for "when was 0.2.89 published"
- No changelog text — zero release notes content

**Programmatic accessibility**:

- `GET https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk` returns the full packument (large JSON, ~several MB)
- The `time` field alone: `GET https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk` and extract `.time`
- For a specific version's metadata only: `GET https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.2.89`
- No changelog field exists in the package metadata
- Useful for: determining exact publish dates, finding the list of all published versions, checking dist-tags (`latest`, `next`)

**Rating**: SUPPLEMENTARY — use to get authoritative version list and publish timestamps, not for changelog content.

---

## Source 4: Installed Package in node_modules

**Path**: `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.89_zod@4.3.6/node_modules/@anthropic-ai/claude-agent-sdk/`

**Exists and accessible**: Yes, in the pnpm virtual store.

**CHANGELOG.md present**: **No** — the installed package does not ship a CHANGELOG.md file. The root-level files in the installed package are: `README.md`, `LICENSE.md`, `bun.lock`, and source/dist files. No changelog.

**Rating**: NOT USEFUL for changelog content. Only useful for inspecting the package.json of the currently installed version.

---

## Source 5: Anthropic Docs (`docs.anthropic.com`)

**URL**: `https://docs.anthropic.com`

**Checked**: The docs site covers the Anthropic API (Messages, Models, etc.) and Claude Code product docs. There is no dedicated changelog page for the `@anthropic-ai/claude-agent-sdk` npm package in the public documentation.

**Rating**: NOT A SOURCE for this package's release notes.

---

## Source 6: `@anthropic-ai/sdk` (the lower-level API SDK — for reference)

**Note**: The project also has `@anthropic-ai/sdk@0.74.0` installed as a dependency of the agent SDK. That package **does** ship a `CHANGELOG.md` in node_modules (confirmed at `node_modules/.pnpm/@anthropic-ai+sdk@0.74.0_zod@4.3.6/node_modules/@anthropic-ai/sdk/CHANGELOG.md`). This is the base Anthropic TypeScript SDK, not the agent SDK — included here for contrast.

---

## Priority Order for `/app:runtime-upgrade`

### Recommended Strategy

For a command that needs to show "what changed between version A and version B", use sources in this order:

**Step 1 — Get version list and publish dates (npm registry)**

```
GET https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk
Extract: .time (version → ISO timestamp mapping)
Extract: .dist-tags.latest (current latest)
```

This gives the authoritative set of versions to enumerate between `from` and `to`.

**Step 2 — Fetch release notes per version (GitHub Releases API)**

```
GET https://api.github.com/repos/anthropics/claude-agent-sdk-typescript/releases?per_page=100
Paginate until tag_name <= from_version
```

- Each release has `tag_name` (e.g. `v0.2.89`), `published_at`, and `body` (Markdown)
- Filter to releases where semver is > from_version and <= to_version
- Handles gaps: not every npm version has a GitHub release; fall through to CHANGELOG.md for gaps

**Step 3 — Fall back to CHANGELOG.md for versions missing from GitHub releases**

```
GET https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md
Parse ## X.Y.Z sections
```

- Use for versions that appear in npm `time` but not in GitHub releases
- No publish dates in the file, but npm registry timestamps fill that gap

### Practical Notes for the Command

1. **Version gaps are real**: The npm registry shows some version numbers do not have corresponding GitHub releases (e.g. 0.2.99, 0.2.100 are absent from releases but may exist on npm). Always use the npm `time` field as the source of truth for "what versions exist", then look up notes in GitHub releases.

2. **"Parity" entries are noisy**: Many releases say only "Updated to parity with Claude Code v2.1.X". These are real but low-signal — the upgrade command might want to filter or de-emphasize these to focus on substantive API changes.

3. **Rate limits**: GitHub unauthenticated API is 60 requests/hr. For a range of ~22 versions (0.2.89 → 0.2.111), a single paginated `releases?per_page=100` call returns all needed data in one request. No auth required unless running in CI at high frequency.

4. **No changelog in the npm tarball**: Do not attempt to read `node_modules/@anthropic-ai/claude-agent-sdk/CHANGELOG.md` — the file is not shipped in the package.

5. **Single-document shortcut**: If you only need a quick full dump (e.g., for AI summarization), fetching the raw CHANGELOG.md in one HTTP call is fastest. Parse `## X.Y.Z` headers to extract per-version blocks.

---

## Summary Table

| Source              | Has Content        | Has Dates             | Programmatic             | Completeness                 | Recommended Use              |
| ------------------- | ------------------ | --------------------- | ------------------------ | ---------------------------- | ---------------------------- |
| GitHub Releases API | Yes                | Yes (published_at)    | Yes (JSON REST)          | 87 releases, some gaps       | PRIMARY — per-version notes  |
| CHANGELOG.md (raw)  | Yes                | Partial (few entries) | Yes (raw text, parse MD) | 100+ versions, most complete | SECONDARY — gap fill, bulk   |
| npm registry `time` | No (metadata only) | Yes (authoritative)   | Yes (JSON REST)          | All versions                 | SUPPLEMENTARY — version list |
| Installed package   | No                 | No                    | Yes (file read)          | n/a                          | NOT USEFUL                   |
| docs.anthropic.com  | No                 | No                    | n/a                      | n/a                          | NOT A SOURCE                 |
