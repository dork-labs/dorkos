---
date: 2026-07-21
topic: marketplace Recent sort — data source
status: implemented
issue: DOR-381
---

# Marketplace "Recent" sort: where does the timestamp come from?

The marketplace browse page offers Featured, A–Z, and Popular sorts. Popular
shipped in DOR-380 (PR #399) backed by real install counts. Recent was pulled
earlier because it had no real data behind it — it sorted on a field nobody set,
so it lied. This note picks an honest source and puts Recent back.

## The three options

1. **Author-stamped `updatedAt`.** Each package declares its own "last updated"
   date in its manifest or sidecar. Rejected: it is self-reported, so a package
   can claim any recency it likes, and in practice authors forget to bump it, so
   it goes stale and quietly wrong. A sort that authors can game or neglect is
   worse than no sort.

2. **Registry-derived recency.** The real last time each package's files
   actually changed in the `dork-labs/marketplace` repository — the last git
   commit that touched the package's directory. Nobody types this in; git
   records it as a side effect of every change. It cannot be gamed short of
   actually editing the package, and it never goes stale. **Chosen.**

3. **Defer Recent.** Rejected: the endpoint plumbing Popular built (a public
   site read endpoint, a cached server-side provider, client sort machinery) is
   exactly what Recent needs too, so the marginal cost is small and the value —
   "show me what's changed lately" — is real.

## The data path

The same shape Popular uses, one channel over:

```
GitHub commits API  →  site read endpoint  →  server provider (cached)  →  AggregatedPackage.updatedAt  →  client "Recent" sort
   (registry truth)     /api/telemetry/          UpdatedAtProvider           (optional ISO string)          (comparator + menu)
                          updated-at
```

- **The site computes it.** The site already fetches the registry as a static
  raw JSON file from GitHub (`fetch.ts`) — it has no local clone and no git
  history at request time. But GitHub exposes the history over its REST API:
  `GET /repos/dork-labs/marketplace/commits?path=<dir>&per_page=1` returns the
  most recent commit that touched a directory, with its ISO 8601 date. The site
  resolves each package's `source` to its registry directory
  (`resolvePluginSource`) and makes one such call per package. Verified against
  the live registry: `plugins/flow` → `2026-07-18T17:41:20Z`.

- **What we honestly can and cannot stamp.** Only packages whose files live
  inside the registry repo (relative-path sources, 11 of the current 12) have a
  registry-derived timestamp. One package (`lifeos-starter`) points at an
  external repo via a `github` source, so it has no directory in
  `dork-labs/marketplace` and therefore no honest registry recency — the API
  returns nothing for it, and we leave `updatedAt` absent rather than invent a
  value. In the Recent sort it sorts last, after everything with a real date.
  This is the honest bound: we stamp what the registry actually records and
  nothing else.

- **The server caches it** in an `UpdatedAtProvider` that mirrors
  `InstallCountsProvider` exactly: a short-lived in-memory cache, background
  refresh (stale-while-revalidate), never blocks the browse response, and honors
  the same telemetry kill switches (`DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED`)
  because it is an outbound call to dorkos.ai — every outbound channel is off
  when a self-hoster sets the switch. Scoped to the `dorkos-community`
  marketplace, so a same-named package in another source never borrows a date.

- **The client** adds a `recent` comparator (newest first, missing dates last,
  ties broken by name) and re-adds the menu option, grayed out when no package
  carries a date — the same graceful degrade Popular uses.

## Staleness bounds

Three caches sit in the path; the worst-case lag from a registry commit to a
changed sort order is their sum, and every layer degrades to "no data" rather
than to a wrong answer:

| Layer                                        | TTL    | On failure                         |
| -------------------------------------------- | ------ | ---------------------------------- |
| GitHub fetch (Next data cache, `revalidate`) | 1 hour | serve last-known / omit            |
| Site route `Cache-Control` (`s-maxage`)      | 1 hour | `no-store`, empty map, still `200` |
| Server `UpdatedAtProvider` in-memory cache   | 15 min | keep last-known, retry ≤ 1×/TTL    |

So Recent reflects registry changes within roughly two hours, which is right for
a "what's changed lately" browse hint — nobody needs it to the minute, and the
caches keep the GitHub rate limit (60 requests/hour unauthenticated, ~11 calls
per refresh) far from the ceiling.

## The honest-degrade story

Recent never shows a wrong order. When the site is unreachable, the kill switch
is set, or the cache is cold, no package carries `updatedAt`, so the menu grays
the option out and a stale `?sort=recent` link falls back to A–Z — exactly how
Popular behaves without counts. Packages the registry has no date for sort last
behind those it does. The field is only ever present when it is real.
