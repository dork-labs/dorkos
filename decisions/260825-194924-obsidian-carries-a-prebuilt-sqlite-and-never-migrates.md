---
id: 260825-194924
title: The Obsidian embed carries a prebuilt SQLite and reads the database without ever writing it
status: accepted
created: 2026-08-25
spec: message-search
amends: null
superseded-by: null
---

# 260825-194924. The Obsidian embed carries a prebuilt SQLite and reads the database without ever writing it

## Status

Accepted (DOR-1563, spec `message-search` task 5.3, following DOR-691's seam).

**The filename still says `never-migrates`; the decision grew.** It was written as a decision
about migrations and became one about writing at all — the embed does not migrate because it does
not write. The slug is left alone deliberately: it is already linked from the changelog, the source
comments and the manifest, and a rename buys a tidier path at the cost of every one of those.

## Context

`DirectTransport.search` and `createEmbeddedSearch` landed with nothing wired behind them,
for one blunt reason: the Obsidian plugin could not open the index. Two things were in the
way, both proven by an adversarial review of PR #1310 rather than assumed.

**The database driver does not ship.** `better-sqlite3` is a native add-on and the plugin's
`dist/` holds three files — `main.js`, `manifest.json`, `styles.css`. Worse than absent, it
was unreachable: the bundled `require('bindings')('better_sqlite3.node')` walks up from the
calling file looking for `build/Release/…`, which does not exist in a symlinked dev install,
in `dist/`, or in a vault's plugin folder. Measured in all three.

**The migrations folder does not exist there either.** `@dorkos/db` resolved it from
`import.meta.url` at module scope, which inside the plugin bundle points at the plugin
directory — so the folder came out as `<plugin>/../drizzle`, and the resolution itself threw
before that, because Obsidian serves `document.baseURI` as an `app://` URL.

Both had to be answered before the embed's search surfaces could stop being gated.

## Decision

**1. Real SQLite, not WebAssembly.** The embed opens `~/.dork/dork.db` — the same file the
DorkOS app writes, holding every room conversation on the machine — so it needs WAL,
cross-process locking and FTS5 from a build that has them. A WASM SQLite has no OS file
locking; `sql.js` is in-memory with manual write-back, which against a file another process
may be writing is a corruption mechanism rather than a driver. It would also fork `Db`'s
type through every store in the repo for a second driver.

**2. The plugin build stages Electron-ABI prebuilts beside the bundle, one per ABI in a
window.** `better-sqlite3` is a V8-ABI add-on, so a build is tied to one
`NODE_MODULE_VERSION`, and Obsidian's is whatever Electron its release was built on —
a number DorkOS neither picks nor can ask for at build time. So the build fetches
`better-sqlite3`'s own published Electron prebuilds for a window of ABIs (Electron 33 and
up) for the building machine's platform, caches them in a gitignored `.native/`, and copies
them into `dist/` as `better_sqlite3-abi<N>.node`.

**3. The add-on is loaded from `__dirname`, not by `bindings`.** A post-bundle rewrite
replaces the `bindings` call with a load of `better_sqlite3-abi<process.versions.modules>.node`
beside the running `main.js`. An Obsidian outside the window gets one plain sentence naming
the version it wanted, and loses search only.

**4. Fetching is best-effort; rebuilding is forbidden.** A failed download warns and
continues, because `pnpm build` runs in CI where no vault exists and no network is promised.
Rebuilding through `@electron/rebuild` is explicitly not done: it flips the copy in the pnpm
store the whole monorepo shares, which is why `apps/desktop/scripts/rebuild-natives.ts`
carries a warning banner.

**5. The embed opens the database READ-ONLY, and writes nothing at all.** Not "does not migrate" —
does not write. `openReadOnlyDb` opens with `readonly` and `fileMustExist`, so the connection
cannot write even by mistake and a missing database is an error rather than an invitation to
create an empty one. Whoever owns the install owns the schema, and the migrations folder is
therefore never needed — it is now resolved lazily, so importing `@dorkos/db` into a bundle no
longer does URL arithmetic at load time either.

**6. And the embed does not index.** It reads whatever the DorkOS app has already indexed, and the
search box says so. Three things fall out of one decision:

- **No second writer.** `dork.db` is a single file two programs would otherwise be writing, on
  two DorkOS versions that need not match.
- **No frozen vault.** `better-sqlite3` is synchronous and Obsidian's renderer is the thread that
  paints the window. A sweep walks every transcript on the machine; a cold first pass over a large
  history would stall the vault, not just the search box.
- **No pragma problem.** `journal_mode` and `synchronous` are writes. Against a database already in
  WAL, SQLite answers `journal_mode` from the header and nothing happens; against one that is not,
  it raises "attempt to write a readonly database". Skipping both removes the question. `busy_timeout`
  is kept, because readers still wait on a checkpointing writer.

**What this cost, and why it was worth paying.** Read-only turned out not to be free: the operator's
author row is minted on demand, so `resolveOperatorAuthor` WRITES, and the seam raised "attempt to
write a readonly database" on every single search — measured, not predicted. The answer is
`peekOperatorAuthor`, the non-minting twin: same two natural keys, same active-row filter, `null`
where the other would have created a row. A `null` is a database no DorkOS has ever booted against
(it mints that row itself), and the seam refuses in a sentence rather than inventing an identity to
search as. `createRoomSubsystem` gained a `readOnly` flag for the same reason — its handle
reservations are the one thing construction writes.

**What read-only does NOT cost is freshness against a running DorkOS.** A readonly connection reads
the `-wal` file too, so a row the app committed a second ago and has not checkpointed is visible
here — measured. The staleness is only ever "what nothing has indexed yet", never "what has not been
checkpointed yet".

## Consequences

### Positive

- The embed reads the real index with the real driver — same rows, same FTS5, same access
  scope as `GET /api/search`, and the parity is asserted against the live route.
- The embed cannot corrupt, migrate, or disagree with the DorkOS app about the database, because it
  cannot write to it. That is a property of the connection, asserted in a test, rather than a
  property of the code paths anybody remembered to check.
- Every add-on the build downloads is checked against a committed SHA-256 (`native-addons.lock.json`,
  regenerated by `addons:lock`). A build that writes native code into a directory the plugin will
  `require()` from is a supply-chain surface, and a re-cut or substituted release fails the build
  rather than shipping.
- An Obsidian update inside the ABI window is a non-event: the loader reads the number off
  the host.
- Nothing in the pnpm store is touched, so building the plugin cannot break vitest for the
  rest of the monorepo the way desktop packaging can.
- A second process can never migrate the database out from under a running DorkOS server.

### Negative

- `dist/` grows by roughly a megabyte per ABI in the window, and the first build after a
  clean checkout downloads them.
- The window is a list a person maintains. An Obsidian built on an Electron below or beyond
  it loses search until the list moves — visibly, with a sentence, but it does lose it.
- The build reaches the network. It degrades rather than fails, but a build behind a proxy
  produces a plugin that cannot search and says so only in its log.
- An install that has never run DorkOS has no `dork.db`, so the embed has nothing to search.
  That is correct — there is no history yet — but it means search appears when the app has
  been run at least once, not when the plugin is installed.
- **Search in Obsidian is as fresh as the last time DorkOS indexed, and no fresher.** Rooms are
  indexed as they are posted, so those are current; a Claude Code, Codex or OpenCode conversation
  had while only Obsidian was open is not searchable there until the app runs. The search box states
  this rather than hiding it, which is the honest half of the trade and still a real gap. Giving the
  embed its own sweep — on a worker, or through the app over a socket — is the obvious next
  iteration and is deliberately not this one.
- The read-only choice made a hidden write visible (`resolveOperatorAuthor` minting) and will make
  others visible the same way: as a thrown error the first time a new code path is reached from the
  embed, rather than at review time. The degradation contract is what makes that survivable, and it
  is now tested directly.
- Rewriting the add-on load site after bundling is a string rewrite over minified output, in
  the same family as the `__dirname` rewrite beside it. It is anchored on `better-sqlite3`'s
  own string literal rather than on a name Rollup may rename, and the build fails if it does
  not find exactly one site.
