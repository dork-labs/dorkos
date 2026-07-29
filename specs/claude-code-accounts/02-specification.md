# Claude Code accounts — choose which account runs your work

> Work item: DOR-729 · related: DOR-682 (search corpus, same resolver) · supersedes nothing
> Every measurement in this document was taken read-only on the operator's machine on 2026-07-29, not reasoned about.

## 1. The problem, measured

A "Claude Code account" is a Claude config directory. The operator runs three, one per **paying client**: `~/.claude`, `~/.claude2`, `~/.claude3`. Which one DorkOS uses today is decided entirely by whatever `CLAUDE_CONFIG_DIR` the launching terminal happened to export, inherited silently, and it cannot be changed from inside DorkOS at all.

For the dorkos repo alone:

| Account      | Sessions (this project) |
| ------------ | ----------------------- |
| `~/.claude`  | 50                      |
| `~/.claude2` | 41                      |
| `~/.claude3` | 5                       |
| **Total**    | **96**                  |

**No session id appears in more than one root.** Every session belongs permanently to exactly one account, for two independent reasons: its transcript only exists under that account's `projects/` directory, so resume cannot find it elsewhere; and the credentials differ anyway.

So DorkOS currently shows at most 50 of 96 sessions and reports nothing wrong. Launched from a shell exporting `~/.claude3` it shows 5 of 96. This is the failure shape DOR-682 measured for the search corpus — a short list is indistinguishable from a complete one — and it applies to the session list too.

Because the accounts are per-client, a turn that runs on the wrong account is a **real-money, real-trust** failure, and nothing in the product today shows which account a session is on.

## 2. What the operator gets

You open the account switcher, pick the client you're working for, and the next session runs and bills on their account. The sidebar still shows every session from every account, each labeled with the client it belongs to. Clicking this morning's session resumes it on the account that created it — not on whichever one is currently selected. Nothing outside DorkOS changes: your shell, your `claude2`/`claude3` aliases, and a bare `claude` all keep behaving exactly as before.

## 3. Decisions

### D1 — Config shape: accounts keyed by path, with a human label

```ts
runtimes.claudeCode: {
  /** Absolute path of the account new sessions use. null = inherit $CLAUDE_CONFIG_DIR, else ~/.claude. */
  activeAccount: string | null,
  /** Known accounts, for the union session list and for display. */
  accounts: Array<{ path: string; label: string | null }>,
}
```

Default `{ activeAccount: null, accounts: [] }` — byte-for-byte today's behavior.

**Why path as identity.** The path is literally what `CLAUDE_CONFIG_DIR` takes, so it is the natural key: no id generation, no id migration, nothing to keep in sync. **Why a label.** The operator's actual need is seeing _which client_ a session belongs to; `~/.claude2` does not answer that and "Acme Corp" does.

`activeAccount` is stored as a **path, not an index into `accounts`**, so removing an account can never silently repoint the active selection at a different client.

### D2 — Two resolvers, replacing one

- `resolveActiveClaudeRoot()` → `activeAccount ?? $CLAUDE_CONFIG_DIR ?? ~/.claude`. What a **new** session uses.
- `resolveClaudeRootSet()` → deduplicated union of the active root, `$CLAUDE_CONFIG_DIR` when set, `~/.claude`, and every `accounts[].path`, filtered to directories that exist. What **listing and search** enumerate.

This closes the dependency neither DOR-729 nor DOR-682 previously stated: selecting `~/.claude2` as the active account **adds it to the root set**, so search and the session list cannot silently stop covering the account you are actively working in.

`~/.claude` stays in the set unconditionally even when an active account is chosen, because it is a root the SDK may already have written to and dropping it would hide history.

### D3 — A session's account is derived, never stored

A session's account is **which root its transcript lives under**. It is not recorded in a registry and not written anywhere.

This is deliberately unlike ADR-0255's per-session runtime binding, and it is better here: the filesystem is already ground truth, there is no first-write-wins race, nothing can drift, and there is no migration for existing sessions — all 96 get correct accounts the moment the union scan lands. A stored binding would add a writable copy of a fact the disk already answers.

Consequence: any read that resolves a transcript path must know **which session** it is acting for, and resume must pass that session's own root.

### D4 — Account validation is structural, not credential-based

A directory qualifies as an account when it exists and contains a `projects/` subdirectory.

Claude Code names its macOS Keychain entry `Claude Code-credentials-<first 8 hex of sha256(configDir)>` (no suffix for the default `~/.claude`), which is _why_ changing the directory changes the billing identity — all three of the operator's entries exist and match exactly. **That naming is observed behavior of Claude Code 0.3.177, not a documented contract**, and it is macOS-only, so this feature records it as an explanation and **does not depend on it for any gate**. Authentication failures surface as runtime errors, which is honest, rather than as a pre-flight guess that breaks on the next Claude Code release or on Linux.

Verified: `projects/` cleanly separates the three real accounts from `~/.claude-worktrees` and `~/.claudekit`, which both lack it.

**Never auto-glob `~/.claude*`.** It is a guess and it sweeps up exactly those two non-accounts.

### D5 — A switch applies live, without a server restart

On a config change that alters the active account or the account set: clear the transcript metadata cache, restart the session-list broadcaster, and emit an invalidation so connected clients drop and refetch.

The broadcaster already has an idempotent `stop()` that closes every iterator and its watcher, and a `start(runtimes)` that re-invokes `subscribeSessionList` and re-resolves roots — so this needs no new machinery. The client invalidation is **not optional**: a restarted watcher emits upserts for the new roots but never removals for roots it no longer watches, so without it a cockpit shows a stale union.

### D6 — Operator-only, and visible before a turn is sent

Both leaves are `operator-only`, matching every credential-adjacent sibling (`runtimes.opencode.provider`, `runtimes.codex.credentialRef`, both `binaryPath` fields). An agent holding `operator.config_patch` must not be able to move the operator's work onto a different client's subscription. Under login-on this means `PATCH /api/config` requires an operator session cookie, so the control must handle a 403 rather than assume success.

The active account is surfaced where a turn is initiated, not only in settings — the operator switches several times a day, and misattributed billing is the failure mode.

### D7 — Settings field is a sibling card, not part of the runtime card

The field goes in a `FieldCard` in `RuntimesTab.tsx` (features layer). It does **not** go on the Claude Code card: `RuntimeSection` is entities-layer and deliberately props-only presentational, and entities cannot import features.

## 4. Acceptance criteria

1. With `runtimes.claudeCode` at its defaults, behavior is identical to today — including honoring an inherited `CLAUDE_CONFIG_DIR`.
2. Setting `activeAccount` makes the **next** session run on that account, and affects nothing outside DorkOS (no env export, no file moved, no `~/.claude` mutation).
3. An explicit `activeAccount` **overrides** an inherited `CLAUDE_CONFIG_DIR`, so the account is deterministic rather than dependent on the launching terminal.
4. With all three accounts registered, the session list shows **all 96** sessions for this repo, each tagged with its account.
5. Resuming a session runs it on **its own** account, regardless of which account is currently active.
6. A root that does not exist is skipped silently; a root that exists but fails to read contributes one entry in `warnings[]` and zero sessions — never a failed request.
7. Changing the active account takes effect with no server restart, and connected clients converge rather than showing a stale union.
8. `activeAccount: null` restores the default, and the UI shows the resolved default rather than an empty field.
9. Both config leaves are `operator-only`; the UI surfaces a 403 clearly under login-on.

## 5. Non-goals

- Creating, authenticating, or logging into a Claude account from DorkOS. Accounts are authenticated with `claude` itself; DorkOS only selects among already-authenticated ones.
- Moving a session between accounts. Impossible by construction — the transcript lives under one root.
- Per-session account _override_ at send time. The active account governs new sessions; a session's account is fixed once it exists.
- Auto-discovering accounts. The operator registers them (D4).
- Windows/Linux credential verification. Structural validation only (D4).

## 6. Risks

- **Leaning on an implementation detail.** The Keychain naming explains why this works but is not a contract (D4). Mitigated by depending on it nowhere.
- **A read path that forgets which session it is for.** D3 requires every transcript resolution to be session-scoped; a site that only has a `sessionId` must search the root set. These sites are enumerated during implementation and each gets a test.
- **Silent under-coverage regression.** The whole feature exists because a short list looks complete. Tests assert the union count, not merely that listing succeeds.

## 7. Test plan

- Real-`ConfigManager` test over a real file for the new schema (mock stores never cross the `conf`/Ajv seam).
- Multi-root listing: two temp roots, one distinct session in each, assert **both** appear and carry distinct accounts. Must fail before the change.
- Resume binding: a session in root B resumes with root B's directory while root A is active.
- Degradation: an unreadable root yields one warning and zero sessions, and does not fail the request.
- Defaults: with an empty config and `CLAUDE_CONFIG_DIR` set, the active root equals it and the set includes both it and `~/.claude`.

## 8. Amendment 1 — what a code trace found, and D8 (2026-07-29)

A read-only trace of the resume path **confirmed D3** and turned up three constraints the original draft did not anticipate. Recorded here because two of them change the implementation and one of them is the hardest decision in the feature.

### The trace confirmed D3 for a reason better than the original argument

`SessionStore.ensureForMessage` already calls `transcriptReader.hasTranscript(...)` on the resume path (`sessions/session-store.ts:165`, `:190`) and **throws away the root that probe resolved**, keeping only `hasStarted`. So deriving the account is _recovering information the code already computes_, not adding a lookup. Widening that probe to return the winning root and storing it on `AgentSession` (which has no root field today; `cwd` is the working directory, never the config root) is the whole mechanism.

Two further facts make derivation clearly right over a registry: the only available registry is `session_metadata`, whose `runtime` column is documented immutable/first-write-wins (ADR-0255) — wrong semantics for a directory a person can move or delete, where disk is self-healing — and every consumer holding a bare session id must touch disk to get the transcript anyway, so a registry buys nothing.

### C1 — The todo/task path is account-blind by signature

`getTodoFilePath(sessionId)` (`transcript-reader.ts:515`) resolves the config root **directly**, and `readTodosFromFile(sessionId)` / `getTodoFileETag(sessionId)` take no cwd at all. Worse, `readTasks(vaultRoot, sessionId)` is file-first: it returns at `:567` _before_ the `validateBoundaryOrDorkHome(vaultRoot)` check at `:571`, so the cwd plays no part. Under multi-account this silently returns the wrong account's todos. Fix: probe the root set for `todos/{sessionId}.json`, first match wins, memoized — correct because session ids are root-unique.

### C2 — The resume-failure retry must not migrate accounts

`message-sender.ts:880-888` handles a resume failure by setting `session.hasStarted = false` and restarting as a **brand-new SDK session**. If the derived account is not re-injected on that retry, a resume failure silently moves a client's conversation onto whatever account the retry resolves. This gets an explicit test.

### D8 — In-process SDK session helpers: pin the env under a lock for writes, degrade honestly for reads

Three call sites use the SDK **in-process**, so `sdkOptions.env` never reaches them, and the SDK's option types expose only `dir?`/`sessionStore?` — no config-dir, no env:

| Site                                            | What it does                         |
| ----------------------------------------------- | ------------------------------------ |
| `transcript-reader.ts:461` `getSessionInfo`     | reads the SDK-persisted custom title |
| `claude-code-runtime.ts:470` `sdkRenameSession` | renames a session                    |
| `session-store.ts:210` `sdkForkSession`         | forks a session                      |

The SDK memoizes its config root **keyed on** `process.env.CLAUDE_CONFIG_DIR`, so the only lever is mutating that variable process-globally — which is racy in a server running concurrent sessions across accounts.

**The decision:**

- **Rename and fork** — rare, explicitly user-initiated, never on a hot path — run inside a small async mutex that sets `process.env.CLAUDE_CONFIG_DIR` to the target session's account for the duration and restores it after. This is safe **only because** Phase C pins an explicit `CLAUDE_CONFIG_DIR` into every `sdkOptions.env`: an explicit value wins over the ambient one, so a concurrently spawning query cannot pick up the transient mutation. The two changes are load-bearing for each other and must not be separated.
- **Custom-title reads** are **not** wrapped. `getSessionInfo` sits on the session-listing path, and serializing listing behind a process-global env mutation trades a cosmetic gain for a systemic risk. Instead it is called only when the session's account is the active root; for other accounts the derived title is used and the SDK-persisted custom title is skipped.
- **The honest consequence:** a title you set on account B may not display while account A is active. That is a real, bounded degradation, it is documented rather than hidden, and it is preferred over both reverse-engineering the SDK's title sidecar (which would repeat exactly the implementation-detail dependency D4 refuses) and serializing every session listing.

### Implementation notes the trace produced

- Model `account` on `Session` after **`origin`**, not `runtime`: optional, best-effort, derived from disk, absent meaning "the unmarked default". `runtime` is a required tag with a mandatory backstop and is the wrong template.
- Keep `account` a **string**. `session-list-broadcaster.ts:193` shallow-copies the session because the Claude watcher emits the instance held in the reader's cache; a string survives that, an object would alias.
- `sessionMetaEqual` (`session-list-watcher.ts:57`) is the change-suppression comparator and does not compare `runtime`/`origin`/`cwd`. Leave `account` out of it deliberately — a session's account cannot change — and say so in a comment rather than omitting it silently.
- `session-list-watcher.ts` `onFileEvent`/`onDirEvent` compare against a single captured `projectsRoot`; with N watchers that capture must become per-watcher.
- `TranscriptReader.metaCache` is keyed by bare `sessionId` with no root in the key. That is safe **because** ids are root-unique, and unsafe the moment that invariant breaks — assert distinctness in a test rather than assuming it.
- `mcp-resources/session-resources.ts:40` uses `SessionSchema.pick({...})`, an allowlist: `account` will not reach `dorkos://sessions` unless added there.
- Only **two** call sites read `resolveClaudeConfigDir()` today, both in `transcript-reader.ts` (`:61`, `:515`), which is why this change stays contained.

## 9. Amendment 2 — D6 said more than the code enforces (2026-07-29)

Phase A classified all three leaves `operator-only` as D6 requires, then **probed whether the guard actually fires** and found it does not for the two array-element leaves. `findOperatorOnlyPaths({ runtimes: { claudeCode: { accounts: [{ path: '/evil', label: null }] } } })` returns `[]`: `patchPaths` (`config-write-policy.ts:436`) stops walking at an array, so it can never bridge `accounts` to `accounts[].path`. The identical probe on `connectors.rawMcpServers` also returns `[]`, so this is pre-existing and general, not something this feature introduced — and the limitation is already noted in that file at `:148-151`.

**What D6 actually guarantees, corrected.** Moving the operator's work onto a different client's subscription requires writing `activeAccount`, which is a scalar leaf and **is** refused for an agent. That is the property D6 exists to protect and it holds. What an agent holding `operator.config_patch` can still do is **append an entry to the account roster**, which does not change billing but does add a directory to the set DorkOS enumerates — an information-disclosure surface, since sessions under that root would then be listed.

**Decision: do not fix `patchPaths` here.** Teaching it to walk arrays would change refusal behavior for `connectors.rawMcpServers[]` at the same time, which is a policy change to an unrelated feature and belongs in its own change with its own review. This spec records the real boundary instead of implying a stronger one, and the gap is filed as **DOR-737** with a failing-today test as its bar.

A targeted mitigation inside this feature — special-casing `runtimes.claudeCode.accounts` in the PATCH handler — was considered and rejected: it would special-case one path while the general mechanism stays broken, and it becomes dead code the day DOR-737 lands. Both outcomes are things this codebase explicitly refuses.

The array-leaf verdicts stay in the table regardless: they are the correct declaration of intent, the drift guards require every leaf to be classified, and they become enforcing for free the day `patchPaths` learns to walk arrays.

### Naming correction

Phase A's wire field `accounts[].exists` does **not** mean `fs.existsSync` — it reports D4's structural check, so a directory that exists without a `projects/` subdirectory reports `false`. `exists` is therefore misleading to any UI that reads it. It is renamed **`isAccountRoot`** before the client consumes it.

### A note for Phase B

`resolveClaudeRootSet()` can legitimately return an **empty array** — D4 excludes a root without `projects/`, including when it is the active root (a freshly authenticated account that has never run a session). Listing must treat an empty set as "no sessions", never as an error, and must not assume the active root is a member.
