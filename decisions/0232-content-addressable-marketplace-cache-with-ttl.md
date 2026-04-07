---
number: 232
title: Content-Addressable Marketplace Package Cache with 1h TTL on marketplace.json
status: draft
created: 2026-04-06
spec: marketplace-02-install
extractedFrom: marketplace-02-install
superseded-by: null
---

# 232. Content-Addressable Marketplace Package Cache with 1h TTL on marketplace.json

## Status

Draft (auto-extracted from spec: marketplace-02-install)

## Context

A `dorkos install` flow does two distinct kinds of network work, each with very different freshness needs:

1. **Marketplace catalog fetch** — Read a `marketplace.json` document from a configured marketplace source. This is small, frequently re-read (every install, every browse, every update check), and the user expects it to reflect new packages within minutes — but not seconds. Hammering the upstream registry on every CLI invocation is wasteful and brittle when offline.
2. **Package contents clone** — Clone the package's git repository at a specific commit SHA. This is large (potentially hundreds of MB), expensive to fetch, and — once fetched at a specific SHA — immutable forever. A clone of `code-review-suite@a1b2c3d` is identical today, tomorrow, and a year from now.

A single TTL applied to both makes one wrong: too short means slow installs and broken offline use, too long means stale catalogs.

## Decision

Use two cache disciplines side by side under `${dorkHome}/cache/marketplace/`:

```
${dorkHome}/cache/marketplace/
├── marketplaces/
│   └── ${name}/
│       ├── marketplace.json   # TTL-governed catalog
│       └── .last-fetched      # Timestamp stamp
└── packages/
    └── ${name}@${sha}/        # Content-addressable, never expires
```

**Marketplace catalog (`marketplace.json`)** — TTL of **1 hour** by default. After the TTL expires the entry is still served but flagged `stale: true` so callers can refresh in the background. This is a stale-while-revalidate strategy: installs never wait on a network round-trip when a cached document exists.

**Package contents (`packages/${name}@${sha}/`)** — **Content-addressable by commit SHA** (or by tag-resolved SHA). Never expires. Garbage-collected only on demand via `MarketplaceCache.prune()` (size budget) or `MarketplaceCache.clear()` (full reset). A future install of the same `${name}@${sha}` is a free disk hit; a future install of a different SHA stores a new entry alongside the old.

The cache is pure file I/O — `MarketplaceCache` performs no network requests of its own. Callers (`marketplace-source-manager`, `package-fetcher`) are responsible for fetching upstream content and handing it to `writeMarketplace` / `putPackage`. This keeps the cache testable without HTTP mocks and lets the same cache class back any future fetcher (HTTP, git, local file).

Implementation: `apps/server/src/services/marketplace/marketplace-cache.ts`. The `dorkHome` is a required constructor parameter; the cache never falls back to `os.homedir()`.

## Consequences

### Positive

- Repeated `dorkos install` calls within an hour skip every marketplace.json fetch — meets the spec's >80% cache-hit target.
- Reinstalls of the same `${name}@${sha}` are zero-network — works fully offline once cached.
- Branch updates and version bumps store new SHAs alongside old ones; rollback to a previous version is a free disk hit, no re-clone.
- Stale-while-revalidate keeps installs fast even immediately after the TTL expires; the staleness flag lets the UI surface "refreshing in background" without blocking.
- The pure-file-I/O design lets unit tests work with `mkdtemp` directories instead of mocked HTTP, which is faster and more honest.

### Negative

- Disk usage grows monotonically until `prune` runs. The default policy is "never prune unless asked", which is correct for development but will need a size-budget cron in spec 04 once seed packages start landing.
- Two cache disciplines means two mental models. Documentation must make clear that "the cache is stale" only refers to `marketplace.json`, not package contents.
- Content-addressable storage assumes the upstream git host is honest about commit SHAs. A force-pushed tag pointing at a new SHA will fetch a new entry rather than overwrite the old — correct, but potentially confusing if the user expects a `dorkos install foo@latest` to "update" the existing cache entry.
- The 1-hour TTL is a guess. If marketplaces start changing more frequently, the constant in `marketplace-cache.ts` (`DEFAULT_TTL_MS = 60 * 60 * 1000`) is the single tuning knob.

## Alternatives Considered

- **Single TTL for both layers** — Rejected. Catalogs and package contents have fundamentally different freshness characteristics; sharing one TTL forces a bad compromise.
- **Cache by package version (not SHA)** — Rejected. Package versions are mutable in practice (republished tags, branch installs) so a version-keyed cache would either over-evict or serve stale code. Commit SHAs are the only stable key.
- **No package-content cache (always re-clone)** — Rejected. Every reinstall, every failure-path test, and every offline session would pay the full clone cost.
- **External cache service** (Redis, sqlite-backed) — Rejected. The cache lives on disk inside `${dorkHome}` to match the file-first storage discipline used by every other DorkOS subsystem (agents, sessions, adapters). A separate service would create a second source of truth.
