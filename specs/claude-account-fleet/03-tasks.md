# Tasks: claude-account-fleet

Generated from `03-tasks.json` (the canonical file). Spec: `02-specification.md`.

## Parallel groups

- **A**: 1.1, 1.2, 2.5, 3.3. No dependencies; different files.
- **B**: 1.3, 2.1, 2.4, 2.8. After 1.1 (1.3, 2.1) and 1.2 (2.4).
- **C**: 2.2, 2.3, 3.1, 2.6, 2.7. After 2.1 (and 1.2 for 2.3).
- **D**: 3.2, 3.4, 3.5, 5.1, 5.2, 5.3, 5.4. After 2.5+3.1 (3.2), 3.1 (3.4), 2.1+2.3+2.4 (3.5), 2.1+2.3+2.5+3.1 (5.1), 5.1+2.2 (5.2), 1.2+2.1 (5.3), 1.2 (5.4). 3.5 and 5.1 both touch routes/sessions.ts: land 3.5 first.
- **E**: 4.1. After 1.1, 1.3, 2.1, 2.4 (the marketplace fixture folder is merged, PR #57).

Critical path: 1.1 → 2.1 → 3.1 → 3.2.

## Shared-file hotspots

- apps/server/src/services/core/mcp-tool-tiers.ts, mcp-tool-metadata.ts, packages/shared/src/mcp-tool-groups.ts (2.1, 2.2, 3.2): one-entry additions; rebase, never overwrite.
- packages/shared/src/schemas.ts (1.2, 1.3, 3.3, 3.5).
- apps/server/src/routes/sessions.ts (2.5, 3.5, 5.1): 2.5, then 3.5, then 5.1.
- packages/db Drizzle migrations and journal (2.3, 3.3, 5.1, 5.2, 5.4): land in that order; each later one rebases and renumbers its migration.

## Phase 1: Shared contracts

### Task 1.1: Add the shared account-usage module implementing the ledger contract

- Size medium, priority high, tracker DOR-2380
- Depends on: nothing
- Parallel with: 1.2, 2.5, 3.3

Tracker: DOR-2380 (with the DOR-2379 color helpers). Spec §5.1, §5.2, §11 Shared row. The shared contract is the marketplace spec `specs/flow-cli-core/02-specification.md` §1 (revision 6; branch `spec/flow-cli-core` until merged, a copy at `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/6843b882-e9ab-4de2-94de-492c4ebdda5e/scratchpad/fleet/CONTRACTS.md`). Read it first; it wins over anything restated here, and a difference is fixed in specs/claude-account-fleet/02-specification.md in the same PR.

CONTRACT REVISION 6 (fixtures 2.0.0, marketplace `specs/flow-cli-core/02-specification.md` §1.2, branch DOR-2367-ledger-path @ a881d57 until merged; the PR opens only after it merges, and a real change found in its review wins). Adopt EXACTLY: `v: 1` with `runtime` required on write (readers trust the path: a file with no or another runtime reads as the path's; a merge rewrites it); window entries gain optional integer `windowMinutes` (>= 1, anything else invalid); facts `plan { name }`, `credits { hasCredits, unlimited, balance: string | null }`, `spend { periodStart, costUsd, limitUsd: number | null }`, each with its own `observedAt` and `source`, merged like windows: an observation has either a window `key` or a fact `kind` ('plan' | 'credits' | 'spend'); signature `mergeLedger(existing, observations, now, { runtime, accountId })`; sources `statusline | sdk_event | sdk_usage | transcript | rollout | sidecar | provider_api | error`; window keys add `window:<minutes>` (integer >= 1), `credits:<slug>` and `rate_limit:<slug>` (window-less error signals: source error, status rejected, usedPct null); slug rule `^[a-z0-9][a-z0-9._-]*$` with the contract's normalization (runs outside [a-z0-9._-] -> '-', non-alphanumerics trimmed from the start, '-' from the end); `readWindow(entry, now, key)`: stale after 1 h for credits:_/rate_limit:_, else `windowMinutes` or the window:<m> length, else five_hour 5 h / 7 d; a spend fact never goes stale in the ledger. Allow `limitUsd` null. REMOVE the derived `readSpend` month reset for now: the contract's spendRoom has no such rule, and eligibility.cases must match; limitUsd has no writer yet, so nothing is lost (the reset is proposed to the contract). Export `codexObservations(rateLimits, observedAt, source)` per the contract's Codex rule (task 2.6 uses it) and `IMPLICIT_ACCOUNT_ID = 'default'`. AccountUsage gains `runtime`, `plan`, `credits`, `spend`.

Create `packages/shared/src/account-usage.ts`; add `"./account-usage"` to the `exports` map in packages/shared/package.json (same shape as neighbours).

1. Identity helpers: `ACCOUNT_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/`; `DEFAULT_ACCOUNT_COLORS` = 8 lowercase `#rrggbb` values (provisional; the UI track owns them; TSDoc says so); `resolveAccountColor(stored: string | null | undefined, index: number): string` = valid stored value else `DEFAULT_ACCOUNT_COLORS[((index % 8) + 8) % 8]`; `nextAccountColor(taken: Iterable<string>, index: number)` = first palette value not taken, else the positional default; `FLOW_FLEET_SETTINGS_TAB_ID = 'flow:fleet'`.
2. Ledger schemas in the contract's exact rev-6 names and shapes (paragraph above): `LEDGER_SOURCES` (8 sources), `RateLimitStatusSchema`, `LedgerEntrySchema` (usedPct 0-100|null, resetsAt|null, optional integer windowMinutes >= 1, status|null, observedAt, source; usedPct or status non-null), fact schemas for plan/credits/spend, `WINDOW_KEY_PATTERN` (known keys, model:<slug>, window:<m >= 1>, credits:<slug>, rate_limit:<slug>, generic [a-z][a-z0-9_]*), `UsageLedgerSchema` (looseObject: v 1, runtime (required on write, tolerated missing on read), accountId, updatedAt, windows, optional plan/credits/spend). Observations: `{ key, ...entry }` or `{ kind, ...fact }`.
3. `readWindow(entry, now, key): ReadWindow | null` — expired (`resetsAt` set and now >= resetsAt) → usedPct 0, status 'allowed', expired true; stale (`resetsAt` null and now - observedAt > the window length: 1 h for credits:_/rate_limit:_, else windowMinutes, else the window:<m> minutes, else five_hour 5 h and every other key 7 days) → null; else as stored with expired false.
4. `mergeLedger(existing: UsageLedger | null, observations: LedgerObservation[], now: Date, owner: { runtime, accountId }): { ledger; changed: boolean; dropped: { key: string; reason: string }[] }` — per window key AND per fact kind, replace only when observedAt is STRICTLY later; equal keeps stored; observedAt more than 5 min after now → dropped (exactly +5:00 kept); an invalid observation dropped, the rest merge; usedPct clamped 0..100 before validation; sets `runtime` to owner.runtime; updatedAt = now only when changed; unknown keys (window and top-level) preserved. Pure: no logging (callers log `dropped`).
5. `modelWindowKey(displayName)` → `'model:' + slug` where slug = lowercase, runs of chars outside `[a-z0-9._-]` → '-', trimmed of leading/trailing '-'; null when the slug is empty or does not match `^[a-z0-9]`.
6. `AccountUsageSchema` exactly as spec §5.2 (`.openapi('AccountUsage')`) and `toAccountUsage(ledger, identity: { accountId: string | null; path: string; label: string | null; color: string }, now, subscriptionType: string | null = null)`: windows via readWindow (stale omitted), ordered five_hour, seven_day, seven_day_opus, seven_day_sonnet, other keys alphabetically, then model:* alphabetically; labels: five_hour '5-hour window', seven_day 'Weekly', seven_day_opus 'Weekly Opus', seven_day_sonnet 'Weekly Sonnet', seven_day_oauth_apps 'Weekly OAuth apps', overage 'Extra usage', model:x 'Weekly <x>', else the key; `limit` = first readable window with status 'rejected' ({ window: key, resetsAt }); `state` unknown (no readable window) | limited (limit) | warning (any usedPct >= 90 or status 'allowed_warning') | ok.

Tests `packages/shared/src/__tests__/account-usage.test.ts`: readWindow expired/stale/as-stored incl. the 5 h vs 7 d stale boundary; mergeLedger (strictly later wins, equal keeps, a lower usedPct newer observation wins, future +5m01s dropped and +4m59s kept, invalid dropped while others merge, changed false leaves updatedAt, unknown keys kept); modelWindowKey ('Fable' → 'model:fable', ' ' → null); toAccountUsage state table incl. 89.9/90 boundary and ordering; color helpers incl. wrap-around. The contract's own fixture cases are wired in task 4.1.

### Task 1.2: Add session limit, display state, tracker item and fleet fields to the shared session schemas

- Size small, priority high, tracker DOR-2382
- Depends on: nothing
- Parallel with: 1.1, 2.5, 3.3

Tracker: DOR-2382, DOR-2385, DOR-2386. Spec §5.3.

In `packages/shared/src/session-stream.ts`:

- `LimitPlanSchema = z.discriminatedUnion('mode', [ z.object({ mode: z.literal('ask') }), z.object({ mode: z.literal('auto'), target: z.string(), fireAt: z.string() }), z.object({ mode: z.literal('waiting') }), z.object({ mode: z.literal('continued'), sessionId: z.string(), accountId: z.string() }) ]).openapi('LimitPlan')`.
- `SessionLimitSchema = z.object({ accountId: z.string().nullable(), window: z.string(), resetsAt: z.string().nullable(), since: z.string(), plan: LimitPlanSchema.default({ mode: 'ask' }) }).openapi('SessionLimit')`.
- `SessionStatusEventSchema` in schemas.ts (the partial status a mapper yields) gains `limit: SessionLimitSchema.nullable().optional()`.
- `SessionStatusSchema` gains `limit: SessionLimitSchema.nullable().default(null)` with TSDoc: set when the session's account reported a hard limit during the last turn; cleared at the next turn_start; the default keeps older snapshots parsing. Do NOT add a value to `SessionLifecycleSchema`.
- `export function sessionDisplayState(status: Pick<SessionStatus, 'lifecycle' | 'limit'>): SessionLifecycle | 'limited'` → 'limited' when `status.limit` is non-null, else `status.lifecycle`.

In `packages/shared/src/schemas.ts`, `SessionSchema` gains optional fields with TSDoc:

- `accountId: z.string().optional()` — the registry id matching `account`; absent for an unregistered or unknown account.
- `status: z.object({ lifecycle: SessionLifecycleSchema, limit: SessionLimitSchema.nullable() }).optional()` — absent means not live in this server process; read as idle.
- `trackerItem: z.object({ id: z.string(), stage: z.string().optional(), runStatus: z.string().optional() }).optional()` — the work item a flow run serves, read from flow's `flow-state.json` (contract §1.3).
  If importing from session-stream.ts into schemas.ts creates a cycle, define `SessionLimitSchema` in schemas.ts and re-export it from session-stream.ts.
  `SessionListResponseSchema` gains `accountUsage: z.array(AccountUsageSchema).optional()` when task 1.1 has merged; otherwise task 3.5 adds it.
  Fix every client literal typed as a full `SessionStatus` that no longer compiles by adding `limit: null`.

Tests: an old snapshot without `limit` parses to null; sessionDisplayState table; SessionSchema accepts and omits the new fields.

### Task 1.3: Add an account color and the contract's identity rules to the Claude account registry

- Size small, priority high, tracker DOR-2379
- Depends on: 1.1
- Parallel with: 2.1, 2.4

Tracker: DOR-2379 (core part only: routing policy is flow's, operator 2026-09-26). Spec D1. The shared contract is the marketplace spec `specs/flow-cli-core/02-specification.md` §1 (revision 6; branch `spec/flow-cli-core` until merged, a copy at `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/6843b882-e9ab-4de2-94de-492c4ebdda5e/scratchpad/fleet/CONTRACTS.md`). Read it first; it wins over anything restated here, and a difference is fixed in specs/claude-account-fleet/02-specification.md in the same PR. (§1.1a "What DorkOS must do").

1. Rows keep unknown fields (DOR-2379 no data loss): make `ClaudeCodeAccountSchema` a `z.looseObject`. The client only sees what GET /api/config shows, and a PATCH replaces the array, so ALSO: in `applyConfigPatch` (apps/server/src/services/core/operator/config-patch.ts or wherever the merged config is built), for a patch naming `runtimes.claudeCode.accounts`, merge each patched row onto the stored row with the same id (patch-set fields win, `color: null` included; omitted fields survive) and keep every stored row the read rules below skip (non-absolute path, duplicate id): the client never saw them, so omission cannot mean removal. Client: `toWritableAccounts` in `apps/client/src/layers/features/settings/ui/runtimes/sections/ClaudeAccountsSection.tsx` sends each row's color (`null` when `colorIsDefault`). No visual change. Test: store a row with an unknown field plus a skipped hand-edited row, PATCH an add built from the client's view, assert both survive and colors are unchanged. Edge cases to test: a row whose id changed matches its stored row by path as a fallback; a duplicate id merges into the FIRST stored row with that id and leaves the skipped duplicate untouched; say in applyConfigPatch's TSDoc that the operator config_patch tool, which uses the same path, cannot delete a hidden row either.
2. Read rules (contract 1.1a, revision 6) in `readClaudeAccountSettings`: keep today's order, minting missing ids over EVERY object row first (backfillMissingAccountIds, existing ids reserved first), THEN skip a row whose path is missing or not absolute, keep the first of two rows sharing an id, read a bad color as null, each with one logged warning; the write path keeps its duplicate-id refusal.
3. `packages/shared/src/config-schema.ts`: `ClaudeCodeAccountSchema` gains `color: z.string().regex(/^#[0-9a-f]{6}$/).nullable().default(null).catch(null)` with TSDoc (null = the default for this position; a bad value reads as null). `readClaudeAccountSettings` returns rows with `color` resolved by `resolveAccountColor(row.color, index)` (import from account-usage, or move the palette into config-schema.ts and re-export if the import would pull openapi into this dependency-light module). Check the config-manager JSON-schema override that names ClaudeCodeAccountSchema still validates rows with and without color.
4. NO config migration (spec §12): absent = null = positional default. Do not add a key to CONFIG_MIGRATIONS.
5. `describeClaudeCodeAccounts` adds `color` (resolved) and `colorIsDefault: boolean` to each row; `ServerConfigSchema.claudeCode.accounts[]` follows.
6. Id pattern on write: in the config patch path, a patch to `runtimes.claudeCode.accounts` that ADDS a row or CHANGES a row's id must use an id matching `ACCOUNT_ID_PATTERN`, else 400 naming the row index and id. Rows whose id is unchanged are never rejected.
7. Re-read before write: prove (test) that a `PATCH /api/config` naming `runtimes.claudeCode` merges onto the file's CURRENT contents: write the file externally (as `flow accounts add` would) between two server writes and assert the external row survives. If conf or ConfigManager serves a cached copy, read fresh from disk for this section before merging.
8. A config.json flow created (`{"runtimes":{"claudeCode":{"accounts":[{"id":"a","path":"/x","label":null,"color":null}]}}}`, no `__internal__`, no `version`) boots and reads without being reset: test it.
9. `config-disclosure.ts`: `'runtimes.claudeCode.accounts[].color': 'expose'`; pin that config-write-policy keeps `runtimes.claudeCode.accounts` operator-only (agent MCP config tools cannot write it).
10. Docs: `color` row in `contributing/configuration.md` and `docs/getting-started/configuration.mdx` (plain words: "The color DorkOS uses for this account's dot and badge. Leave it empty to use the default for its position.").

Tests: schema (default null, bad value null, unknown row field survives a PATCH), read rules, client color round trip, resolution by position, GET /api/config carries color + colorIsDefault, id-pattern refusal only for new/changed ids, external-write survival, flow-created config, disclosure/write-policy pins.

## Phase 2: Server foundations

### Task 2.1: Keep usage per Claude account in the shared ledger and serve it over REST, MCP and events

- Size large, priority high, tracker DOR-2380
- Depends on: 1.1
- Parallel with: 1.3, 2.4

Tracker: DOR-2380. Spec D2. The shared contract is the marketplace spec `specs/flow-cli-core/02-specification.md` §1 (revision 6; branch `spec/flow-cli-core` until merged, a copy at `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/6843b882-e9ab-4de2-94de-492c4ebdda5e/scratchpad/fleet/CONTRACTS.md`). Read it first; it wins over anything restated here, and a difference is fixed in specs/claude-account-fleet/02-specification.md in the same PR. Validation: two sessions on one account update one record; the ledger matches flow's format; the store survives a restart.

1. `apps/server/src/services/core/usage/ledger-file.ts`: the contract §1.2 "Writing" steps 1-7 EXACTLY, as `writeLedger(dir, accountId, observations, now, opts?)` where `dir` is `<dorkHome>/runtimes/<runtime>/usage` (contract revision 6; created on first write) → `{ written: boolean; dropped; gaveUp?: boolean }`: refuse an accountId failing ACCOUNT_ID_PATTERN; lock `<id>.json.lock` via `fs.open(path, 'wx')` writing token `<pid>:<crypto.randomBytes(16).toString('hex')>`; a lock with mtime older than 10 s is stale (contract revision 4 step 2): read its token, rename it to `<id>.json.lock.stale-<random>`, read the moved file's token; if it is NOT the token judged stale, put it back with `fs.link(moved, <id>.json.lock)` (ignore EEXIST: a newer lock exists); in both cases delete the moved name and retry step 1; never delete a lock by its original name; 25-100 ms jittered retries, give up after 2 s total (return gaveUp, never throw); under the lock read the file (missing = empty; unparsable or schema-invalid = rename to `<id>.json.corrupt-<Date.now()>` and start empty); `mergeLedger`; if unchanged release and stop; write `<id>.json.<pid>.<random>.tmp`, fsync, rename over `<id>.json`; release by reading the lock and deleting it only if it still holds our token. Folder mkdir mode 0700, file 0600. Plus `readLedger(dir, accountId)` (no lock; unparsable → null + warning).
2. `apps/server/src/services/core/usage/account-usage-store.ts` (runtime-neutral pieces live in services/core/usage/; only the Claude SDK mapping, feed and probe stay under claude-code/accounts/) `class AccountUsageStore({ dorkHome, readAccounts, resolveDefaultRoot, now?, broadcast? })`: RUNTIME-NEUTRAL (spec §6 R): records are keyed by (runtime, accountId); a runtime with no registered accounts has the implicit `default` account (Claude Code with an empty registry, and always Codex and OpenCode) which gets a ledger file; Claude Code sessions resolve their account by `path.resolve(root)` against the registry; only two cases are memory-only (accountId null, no file): an unregistered root while other accounts are registered, and a registered row whose legacy id fails ACCOUNT_ID_PATTERN. Registry transitions (spec §6 R), all inside one idempotent `reconcileAccounts()` run at boot, on every 60 s scan (re-read `runtimes.claudeCode` from disk there, because ConfigManager.onChange misses `flow accounts add/remove` and hand edits) and after an in-app config write: first registration whose path equals the ambient root → MERGE default.json into <id>.json under both locks (never delete default.json: contract pruneTargets) and update session_limits account_id default → id; paths differ → merge nothing and null those rows' account_id; last account removed → implicit default returns with its old default.json. `record(runtime, accountKey, observations, meta?)`. Watching: fs.watch takes no glob, so watch each EXISTING `<dorkHome>/runtimes/<runtime>/usage/` dir (debounced 500 ms), discover dirs created later on a 60 s periodic scan that also re-reads files, ignore `.lock`, `.tmp`, `.stale-*` and `.corrupt-*` names, and merge CLI-written readings into memory and broadcast. An id that left the registry (found by reconcileAccounts, which lists the files FIRST and reads the registry LAST, and deletes only files whose mtime is older than 60 s, so a ledger flow writes for a just-added account is never deleted) → delete its ledger file under the contract lock per the contract's `pruneTargets(registered, onDisk)` (never default.json; a missing file is fine; delete NOTHING when config.json cannot be read in full). Keep `pruneTargets(registered, onDisk)` PURE (it is what prune.cases runs); the store's extra 60 s mtime guard is applied OUTSIDE it, filtering its result (its session_limits rows keep their account_id). Test reconcile with an EXTERNAL config write (no onChange), twice (idempotent), and the merge when <id>.json already exists. `record(...)` (meta `{ subscriptionType?, plan?, credits?, spend? }`) merges into memory synchronously and schedules a flush (1 s trailing debounce, one in flight per account) for every file-backed account (registered pattern-valid ids and the implicit `default`; the two memory-only cases above are never flushed, logged once); `list()` (per runtime: registered accounts in registry order, or `default` when the registry is empty, plus for Claude Code with a registry the unregistered ambient root as a memory-only row; no disk work); `peek(accountIds: string[]): AccountUsage[]` (memory only, synchronous); `load()` at boot; `flush()` at shutdown; `onChange(listener)`. Flush give-up or write error: warn at most once per account per hour, keep memory, retry on the next flush. subscriptionType is memory-only. Identity (label, color) resolved from `readAccounts()` on every read.
3. `accounts/account-usage-feed.ts`: `setAccountUsageStore(store)` (mirror `setSessionEventStore`) and `recordSessionUsage(session, observations, meta?)` with root `session.launchedAccountRoot ?? session.accountRoot ?? resolveActiveClaudeRoot()`; no-op without a store.
4. Feed A — `sdk/event-mappers/result-event-mapper.ts` rate_limit_event branch: also build one observation `{ key: rateLimitType, usedPct: utilization*100 (0..1 in), resetsAt: epoch s → ISO or null, status, observedAt: now ISO, source: 'sdk_event' }` (no type → not recorded; overage and seven_day_overage_included recorded under their own keys) and call `recordSessionUsage`. Existing output byte-identical.
5. Feed B — `sdk/subscription-usage.ts`: pure `mapSdkUsageWindows(response, now)` → observations for every present `rate_limits` window keyed by SDK name (five_hour, seven_day, seven_day_oauth_apps, seven_day_opus, seven_day_sonnet) plus each `model_scoped[]` under `modelWindowKey(display_name)` (skip null key), usedPct as given (0..100), status null, source 'sdk_usage'; skip null utilization. `fetchSubscriptionUsage` returns `{ status, observations, subscriptionType }`; update the two call sites (`messaging/message-sender.ts`, `sessions/session-turn-windows.ts`) to keep `session.lastSubscriptionUsage` from status and call `recordSessionUsage`. The warm-process path `sessions/persistent-dispatch.ts` gets usage through its `onUsage` callback (around line 1181), not fetchSubscriptionUsage: carry the observations on that usage object from wherever it is produced and have the onUsage handler call `recordSessionUsage`. `rate_limits_available: false` → no observations.
6. Wire in `apps/server/src/index.ts`: build after config, `await store.load()`, `setAccountUsageStore`, expose to routes the way routes/runtimes.ts gets deps, `store.flush()` on shutdown.
7. `GET /api/runtimes/claude-code/accounts/usage` → `{ accounts }` in routes/runtimes.ts + OpenAPI registration.
8. Event `account_usage` via eventFanOut on AccountUsage change ignoring observedAt, throttled per account to one per 2 s trailing; add `'account_usage'` to the client allowlist in `apps/client/src/layers/shared/lib/transport/stream-manager.ts`.
9. MCP `accounts_usage` in new `mcp-tools/account-tools.ts` (`getAccountTools(deps)`), registered in-session and projected to external /mcp via `registerFromDefinitions` (follow core-tools); `mcp-tool-tiers.ts` entry `{ tier: 'observe', area: null, areaNote: ALWAYS_ON, title: 'Read how much of each Claude account is used' }`, plus mcp-tool-metadata.ts and the shared tool-group map.
10. Compliance guard (invariant 3): `accounts/__tests__/compliance.test.ts` fails if any file in claude-code/accounts/ or services/core/usage/ contains `find-generic-password`, `Keychain`, `.credentials.json`, `oauth/usage`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN`.

Tests: ledger-file (fresh write; held lock → retries then gaveUp without throwing; stale lock broken by rename, never deleted by name; two breakers racing on one stale lock: the second finds a fresh token in the moved file, restores it with link, and both writers never hold the lock at once; a foreign token is never deleted on release; corrupt file renamed; unchanged merge does not rewrite; modes 0600/0700); store (two roots/sessions on one account → one record; restart = new store over the same dir returns the same windows; a flow write between flushes survives; unregistered root has no file and accountId null; peek never touches disk; throttled broadcast); mapper 0.82 → 82 and overage key; mapSdkUsageWindows incl. model_scoped; route; tier tables.

### Task 2.2: Probe an idle Claude account's usage without running a turn

- Size medium, priority medium, tracker DOR-2381
- Depends on: 2.1
- Parallel with: 2.3, 3.1

Tracker: DOR-2381. Spec D3. Validation: a probe on an idle account records its windows and reset times; no model turn is billed; a failed probe reads as unknown.

New `apps/server/src/services/runtimes/claude-code/accounts/account-probe.ts` exporting `probeAccount(accountId, deps?)` → `{ account: AccountUsage; probe: 'ok'|'unavailable'|'failed'|'throttled'; reason?: string }`, with an injectable `queryFactory` (default the SDK `query`).

1. Unknown registry id → typed `UnknownAccountError` (route → 404 `UNKNOWN_ACCOUNT`). With an empty Claude Code registry, the id `default` probes the ambient root. `!isClaudeAccountRoot(path)` → failed, reason 'not-an-account'.
2. Single-flight per account (concurrent callers share one promise); 60 s floor since the last attempt → throttled with the current record.
3. Spawn: `const idle = createIdlePrompt()` (sdk/sdk-utils.ts); `query({ prompt: idle.prompt, options: { cwd: <dorkHome>/cache/account-probe (mkdir -p), settingSources: [], persistSession: false, systemPrompt: { type: 'preset', preset: 'claude_code' }, pathToClaudeCodeExecutable: <the runtime's resolved binary>, env: runtimeEnvironment('claude-code', 'warmup', { ...claudeConfigDirEnv(path) }) } })`; no mcpServers, no plugins (mirror warmCommands in claude-code-runtime.ts).
4. `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` raced with a 15 s timeout.
5. `rate_limits_available === false` → unavailable, nothing recorded. Throw / timeout / missing method → failed with a short reason, nothing recorded. Success → `store.record(root, mapSdkUsageWindows(res, now), { subscriptionType: res.subscription_type })` (source 'sdk_usage', per the contract), ok.
6. `finally`: clear the timer, `idle.close()`, close the query — every path.
   Expose `POST /api/runtimes/claude-code/accounts/:id/probe` (routes/runtimes.ts + OpenAPI) and MCP `accounts_probe` in account-tools.ts (input `{ account: z.string().min(1) }`; tiers `{ tier: 'act', area: null, areaNote: AREA_PENDING_PHASE_3, title: "Check a Claude account's usage without running a turn" }` + metadata + group). Never run at boot or on a timer.

Opt-in live check: `accounts/__tests__/account-probe.live.test.ts`, skipped unless `DORKOS_ACCOUNT_PROBE_LIVE=1` (read at module scope; never add it to turbo.json), probing a real signed-in registered account: asserts windows were recorded and no new transcript appeared under the account's `projects/`. Run it once by hand before closing the task and paste the result in the PR. It runs no turn and spends nothing.

Tests with a fake query factory: the idle prompt yields ZERO messages (no turn), usage called once with skipBehaviors true, windows recorded with resetsAt; unavailable and failed record nothing and the account stays 'unknown'; timeout closes query and prompt; throttle; single-flight; unknown id 404; tier table.

### Task 2.3: Show a hard usage limit on the session and notify once per limit

- Size medium, priority high, tracker DOR-2382
- Depends on: 1.2, 2.1
- Parallel with: 2.2, 3.1

Tracker: DOR-2382. Spec D4. Validation: a hard limit shows as limited with the reset time in the session and on the event stream; the operator is notified once per limit; the previously suppressed error is covered by a test.

1. `sdk/event-mappers/message-event-mapper.ts`: a branch for assistant `error === 'rate_limit'` yielding an `error` event built with `buildApiErrorPart('rate_limit', noticeText)` from `sdk/api-error-record.ts`: message = the CLI's own text, code 'rate_limit', NO category. Comment why rate_limit stays out of SURFACED_ASSISTANT_ERRORS (no DorkOS copy; must stay uncategorised so no Retry shows); update the sdk-error-mapping.ts TSDoc that calls it excluded. api_retry is untouched.
2. Limit status, once per turn (flag on AgentSession reset at turn start), ONLY when the turn actually stopped: on the rate_limit assistant error, or on a `rate_limit_event` with status 'rejected' whose `isUsingOverage` and `overageInUse` are both not true (the SDK also sends rejected while extra usage covers the window and the turn continues; the ledger still records that event as it came), yield `session_status { sessionId, limit: { accountId, window, resetsAt, since } }`: window = the event's rateLimitType, else the account's current rejected window from the store, else 'unknown'; resetsAt likewise, else null; accountId = registry id matching the session root, else null; since = now ISO.
3. `session-event-normalizer.ts` passes `limit` through on status_change; `session-state-projector.ts` holds it like `lastError`: set from the status, cleared at the next turn_start, included in snapshots.
   3b. Persistence (claude-code projectors run in 'record' mode and never hydrate status, see projector-persistence.ts): new `session_limits` table in `packages/db` (+ Drizzle migration): `session_id` PK, `since`, `window`, `scope`, `resets_at`, `account_id`, `account_path`, `plan` (JSON text), `state`, `updated_at`. A small store (`apps/server/src/services/session/fleet/session-limit-store.ts`) with `upsert`, `get`, `getMany(ids)`, `listWaiting()`, `delete`. Upsert when a limit is set (plan `{ mode: 'ask' }`, state 'limited' until task 5.1 computes more); delete at the session's next turn_start; `RuntimeRegistry.rekeySessionSettings` moves the row. A projector created for a session hydrates `limit` from its row. Test: a new store/projector after a simulated restart still shows the limit; turn_start deletes it; rekey moves it.
4. Error-only path: when the window is known and no rejected event came, `recordSessionUsage(session, [{ key: window, usedPct: null, status: 'rejected', resetsAt, observedAt: now, source: 'sdk_event' }])`.
5. Notification kind `'account.limited'`: add to `NOTIFICATION_KINDS` (packages/shared/src/notification-schemas.ts, one-line TSDoc), payload type + registry entry in `services/notifications/notification-registry.ts`: tier 'notable', storage 'event', subjectType 'session', locate → session, title `${accountLabel} is out until ${local reset time}` or `${accountLabel} hit its ${window label} limit` when resetsAt is null (use the time formatter other entries use; else Intl short date-time), actions OPEN_ACTION, dedupeKey `account-limited:${accountId ?? path}:${window}:${resetsAt ?? since truncated to the hour}`, relay 'never'. Payload `{ sessionId, agentId?, sessionLabel, accountId, accountLabel, window, resetsAt }`. Satisfy every exhaustive table the new kind reddens.
6. `services/notifications/emitters/session-lifecycle.ts`: when a status moves to 'error' carrying `limit`, notify `account.limited` instead of `session.error` and do not arm the session.error escalation.

Tests: the rate_limit assistant error yields the uncategorised error frame (fails on current main); rejected event → limit with resetsAt on the stream and in the snapshot; cleared at turn_start; a rejected event with isUsingOverage true sets no limit; three sessions on one account hitting one limit → exactly one account.limited, zero session.error; a non-limit error still raises session.error.

### Task 2.4: Read the work item a flow run serves from flow-state.json and attach it to sessions

- Size small, priority medium, tracker DOR-2386
- Depends on: 1.2
- Parallel with: 1.3, 2.1

Tracker: DOR-2386. Spec D8. The shared contract is the marketplace spec `specs/flow-cli-core/02-specification.md` §1 (revision 6; branch `spec/flow-cli-core` until merged, a copy at `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/6843b882-e9ab-4de2-94de-492c4ebdda5e/scratchpad/fleet/CONTRACTS.md`). Read it first; it wins over anything restated here, and a difference is fixed in specs/claude-account-fleet/02-specification.md in the same PR. (§1.3: DorkOS READS flow-state.json and never writes it.) Validation: a session started by flow shows its tracker item; the link survives a restart; sessions not started by flow are unaffected.

New `apps/server/src/services/session/fleet/flow-run-link.ts`:

- `flowRunsFor(cwd): Promise<Map<sessionId, { identifier: string; stage?: string; status?: string }>>`: main checkout = parent of the git common dir, resolved by `git rev-parse --path-format=absolute --git-common-dir` through the repo's existing git runner (the one `services/workspace/worktree-scan.ts` calls), then `path.dirname` of the result exactly as the contract says (do NOT use `repoPathFromCommonDir`: it is test-only and differs for a git dir not named .git); cache per cwd for the process, a negative result for 60 s; read `<main>/.dork/flow/flow-state.json` with `readTextFileWithin` from `@dorkos/shared/bounded-read` (1 MB cap), cached by mtime; parse leniently: the file is `Record<issueId, FlowRun>`, keep records whose `identifier` and `sessionId` are strings, ignore unknown fields; a file that fails to parse reads as no runs, logged once per mtime. Never writes, never takes the lock.
- `applyTrackerItems(page)`: for each distinct session cwd on the page call flowRunsFor once and set `session.trackerItem = { id: identifier, stage, runStatus: status }` where `session.id` equals a run's sessionId. Called by task 3.5's overlay; export it for that.

Tests (temp git repo + worktree fixtures): a session named by a run gets trackerItem (validation 1); a new module instance reads it again (validation 2, restart); a session no run names is deep-equal to before (validation 3); a worktree cwd resolves to the main checkout's file; corrupt file → no runs; non-git cwd → no runs; one read per distinct cwd.

### Task 2.6: Record Codex usage from the rollout record DorkOS already reads

- Size medium, priority high, tracker DOR-2380
- Depends on: 2.1
- Parallel with: 2.2, 2.3, 2.7

Tracker: DOR-2380 (every runtime records usage, spec §6 R). Codex has one implicit account, `default`. The PR opens after contract revision 6 merges (build against the DOR-2367-ledger-path text now).

1. `apps/server/src/services/runtimes/codex/turn-context-usage.ts` already reads the rollout tail's `event_msg` / `token_count` record at turn end. Extend that SAME bounded read (no new file access) to also parse `payload.rate_limits` when present: `primary` and `secondary` (`used_percent`, `window_minutes`, `resets_at` or `resets_in_seconds`), `plan_type`, `credits`, `rate_limit_reached_type`. Tolerant schema (missing parts omitted, never a throw); pin the shape with a fixture from a real rollout line (redacted).
2. Map with the shared `codexObservations(rateLimits, observedAt, 'rollout')` (task 1.1), which implements the contract's Codex rule: only the main limit (`limit_id` 'codex' or none) maps to plain windows keyed by window_minutes (300 five_hour, 10080 seven_day, else window:<m>); any other limit becomes ONE `model:<slug>` bucket (slug from limit_name else limit_id) holding its tightest window (highest used_percent, tie to the longer window); status 'rejected' when rate_limit_reached_type is not null; plan_type → plan fact, credits → credits fact; a window with no integer length or numeric percent is skipped. Record via the D2 store as (codex, 'default').
3. Limit (spec D4 for every runtime): the contract says `rate_limit_reached_type` only sets status rejected and is null in real events even at 100%, so a Codex limit is detected when a plain window reads `rejected` OR `usedPct >= 100`, or a `turn.failed` is a rate limit; window = that entry (seven_day before five_hour, else 'unknown'), resetsAt from that entry; it sets the session `limit` through the same status path task 2.3 added, so `account.limited` and D9 apply. Codex has no carry-over target, so D9 reaches wait-only.

Tests: a real-shaped rollout record maps to five_hour and seven_day with plan and credits facts; a non-main limit_id becomes a model:<slug> bucket and never overwrites five_hour/seven_day; an unknown window length becomes window:<minutes>; a reached limit sets rejected and the session limit; a record at 100% with a NULL rate_limit_reached_type still sets the session limit (seven_day preferred); a record without rate_limits changes nothing; the existing context-usage behavior is unchanged.

### Task 2.7: Record OpenCode spend per turn and treat rate or credit errors as a limit

- Size small, priority medium, tracker DOR-2380
- Depends on: 2.1
- Parallel with: 2.2, 2.3, 2.6

Tracker: DOR-2380 (spec §6 R). OpenCode has one implicit account, `default`. The PR opens after contract revision 6 merges. Memory seeds `costUsd` from the ledger file at load (the store's boot load), so a restart does not reset the month.

1. Where the OpenCode runtime already maps a turn's cost (USD) for the pay-as-you-go `UsageStatus`, also add it to the ledger's `spend` for (opencode, 'default'): `periodStart` = the current UTC calendar month start (a new month resets `costUsd` to this turn's cost), `costUsd` accumulated, `observedAt` now, source `sidecar` (a `spend` fact, `limitUsd` null); `limitUsd` unset (a provider budget lookup is a follow-up).
2. A turn that fails with a rate-limit or credit/quota error (classify with the runtime's existing error mapping; add a narrow classifier if none) records a window-less error signal: key `rate_limit:<provider slug>` for a 429, `credits:<provider slug>` for payment required / out of credits (source `error`, status `rejected`, usedPct null, resetsAt when the provider says) and sets the session `limit` (window 'unknown' unless the error names one) through task 2.3's status path.

Tests: two turns accumulate spend; a new month resets it; a rate-limit error sets rejected and the session limit; an ordinary error does neither.

### Task 2.8: Add the supportsAccounts runtime capability

- Size small, priority medium, tracker DOR-2379
- Depends on: nothing
- Parallel with: 1.3, 2.1, 2.4

Tracker: DOR-2379 (UI gating data, spec §6 R and programme R7).

`RuntimeCapabilities` (packages/shared/src/agent-runtime.ts) gains `supportsAccounts: boolean` with TSDoc (the runtime can run sessions on more than one registered billing account; the account chip, dots and badge are gated on it). Declare it in every runtime's constants: claude-code true; codex, opencode, test-mode false. Add it to the shared conformance suite (`runtimeConformance` in @dorkos/test-utils) and to any exhaustive capability tables or fake runtimes that no longer compile. It is already served wherever capabilities are (check GET runtime capabilities and the OpenAPI schema).

Tests: each runtime declares the expected value; the conformance suite checks it is a boolean.

### Task 2.5: Extract the session launch path from the messages route and add the agent-launch origin

- Size medium, priority high, tracker DOR-2383
- Depends on: nothing
- Parallel with: 1.1, 1.2, 3.3

Tracker: DOR-2383 (prerequisite refactor). Spec D5 "Extract the launch service first".

1. Move the body of `POST /api/sessions/:id/messages` in `apps/server/src/routes/sessions.ts` (agentPath verification against Mesh, workspace binding, `resolveSessionCwdWithRoom`, `resolveRuntimeTypeForNewSession`, `persistSessionRuntime`, the session_created usage event, account-hint gating, runtime resolve, dispatch id + `recordDispatchStart`, projector creation and cwd stamp, `runInDispatch(... dispatchMessage(...))`) verbatim into `apps/server/src/services/session/launch/launch-session.ts#dispatchSessionMessage(opts)`. `opts` carries the parsed request fields, `clientId`, `meshCore`, `roomSessionPlace`, an optional `onSettled`, and a REQUIRED `origin: TurnOrigin`. It returns the dispatch result or a typed refusal `{ refused: 'INVALID_AGENT_PATH' | 'UNKNOWN_RUNTIME'; message: string }` the route maps to today's exact status codes and messages. Move every comment with the code it explains.
2. The route becomes parse → `dispatchSessionMessage({ ..., origin: { kind: 'interactive' } })` → the unchanged 202 body. The ALS rule (`runInDispatch` wraps `dispatchMessage`) must stay true: `sessions-dispatch-correlation.test.ts` passes unmodified.
3. `services/session/origin/turn-origin.ts`: add `| { readonly kind: 'agent-launch' }` with TSDoc (an agent started this session through `session_start`; nobody chose a trust stop for it) and map it to `'none'` in `permissionSeedForOrigin`. Update `__tests__/turn-origin-call-sites.test.ts` only if it enumerates members.

Proof: every existing sessions route test passes with no edits. New unit tests for the refusals and the new origin's seed.

## Phase 3: Launching and routing

### Task 3.1: Give server extensions dork-home, read access to Claude accounts and usage, and an account advisor seam

- Size medium, priority high, tracker n/a
- Depends on: 2.1
- Parallel with: 2.2, 2.3, 3.3

Tracker: DOR-2383 and DOR-2384 (the account check), for the Flow extension. Spec §6 X1-X3 and D9 "Ranking".

1. `packages/extension-api/src/server-extension-api.ts` `DataProviderContext` gains, with TSDoc:
   - `readonly dorkHome: string` — the resolved DorkOS data directory, so an extension can keep a file other tools also read (the Flow extension's `<dorkHome>/flow/fleet.json`).
   - `readonly claudeAccounts: { list(): Promise<ClaudeAccountSummary[]>; usage(): Promise<AccountUsage[]>; onUsage(listener: (usage: AccountUsage) => void): () => void; registerAdvisor(advisor: AccountAdvisor): () => void }`, `ClaudeAccountSummary = { id; path; label; color }` (color resolved).
   - The advisor types exactly as spec §6 X3: `AccountAdvisor { rank(candidates, ctx); onLimited?(info); modelFallback?(info) → { model } | null; carryOver?(info, targetAccountId) }`, `LimitedPlan = { mode: 'auto'; target; delaySeconds } | { mode: 'wait'; resumeAt? } | { mode: 'ask' }`, `LimitedSessionInfo = { sessionId; cwd; accountId; window; resetsAt; scope: 'account' | 'model'; model; trackerItem? }`, `AccountCandidate`, `AdvisorContext { purpose: 'launch' | 'continue'; caller: 'person' | 'agent' | 'relay' | 'advisor'; cwd; runtime; sessionId?; excludeAccountId? }`, `AdvisorRanking { accounts: { id; eligible; reason; badge?: 'recommended' | 'reserved' }[]; recommendedId }`, `LimitedSessionInfo`, `LimitedPlan`, `CarryOverSeed { seedContext; prompt? }`. AccountUsage from `@dorkos/shared/account-usage`.
2. New `apps/server/src/services/core/usage/account-advisor.ts`: `registerAccountAdvisor(ownerId, advisor)` → unregister fn. ONE advisor: a second registration replaces the first and logs a warning naming both owners; an unregister removes only its own advisor. `callAdvisor(method, args)` bounds every call at 2 s and returns `undefined` on throw/timeout (logged). Validation helpers: drop ranking ids that are not registered; clamp `delaySeconds` to 0..3600; reject an `auto` target that is unregistered or equals the limited account; reject a seed longer than `SEED_CONTEXT_MAX_LENGTH`.
3. New `apps/server/src/services/core/usage/account-ranking.ts`: `rankAccounts(ctx): Promise<{ accounts: { id, label, color, usage, eligible, reason, badge? }[]; recommendedId }>`: with an advisor, its ranking (validated; omitted ids hidden); without one, or on failure, the DEFAULT: every registered account except `ctx.excludeAccountId`; eligible when `AccountUsage.state !== 'limited'`; eligible first ordered by weekly headroom (100 − seven_day usedPct; unknown weekly after known), then 5-hour headroom, then registry order; ineligible after; reasons "58% of the week left" / "Usage unknown" / "Out until <local short time>"; recommendedId = first eligible or null. And `checkAccountLaunch({ accountId, cwd, runtime, caller: 'agent' | 'relay' })`: NO advisor → deny "Agents can pick an account only after Flow is set up to say which accounts they may use."; advisor failure → deny "The account policy could not be checked."; else allow iff the advisor's ranking (purpose 'launch') marks the id eligible, deny with its reason otherwise.
4. `services/extensions/extension-server-api-factory.ts` builds `dorkHome` and `claudeAccounts` (list via `readClaudeAccountSettings`, usage/onUsage via the D2 store, registerAdvisor keyed by extension id). `extension-server-lifecycle.ts` removes that extension's listeners and advisor on shutdown and reload.
5. Document all of it in `contributing/extension-authoring.md`: one advisor at a time; a person's pick is never refused by it; without it core uses defaults and refuses agent/relay account picks.

Tests: the factory exposes dorkHome and the account API; one-advisor rule (second replaces first with a warning; stale unregister does not remove the new one); 2 s bound; default ranking table (headroom order, unknown last, limited ineligible, excluded account absent, reasons, recommendedId); advisor ranking validated (unknown id dropped, hidden ids absent); checkAccountLaunch with no advisor, failing advisor, eligible, ineligible; shutdown/reload unregister.

### Task 3.2: Add the session_start MCP tool that starts a session on a named account

- Size large, priority high, tracker DOR-2383
- Depends on: 2.5, 3.1
- Parallel with: 3.3, 3.4, 3.5

Tracker: DOR-2383. Spec D5. Validation: an agent can start a session on a named account through MCP; account and cwd are validated and scope rules are respected; covered by the MCP tool tests.

New `mcp-tools/session-tools.ts` (`getSessionTools(deps)`, projected to external /mcp by `registerFromDefinitions`) with tool `session_start`. Input (zod):

- `prompt: z.string().min(1)`; `cwd: z.string()` — absolute and inside the boundary (lib/boundary.ts, as the route checks), else refuse;
- `account?: z.string().min(1)` — for a runtime with `supportsAccounts` (task 2.8): a registry id, or `default` when that runtime's registry is empty; unknown → error "No Claude account with id <x> is registered." and nothing starts (invariant 6). For any other runtime: omitted or `default` only, else 400;
- `runtime?`, `model?`, `effort?` (EffortLevelSchema), `permissionMode?` (PermissionModeSchema), `seedContext?` (the SendMessageRequestSchema limits), `agentPath?` (must be a registered Mesh agent directory).
  Flow: mint `sessionId = crypto.randomUUID()`; if account → `checkAccountLaunch({ accountId, cwd, runtime, caller: 'agent' })` (task 3.1: asks the account advisor; no advisor = refused), refuse with its reason on deny; enforce `AGENT_LAUNCH_MAX_LIVE = 8` live agent-launched turns (in-memory set in launch-session.ts, added at dispatch, removed via onSettled) → refuse "Too many agent-started sessions are running (8). Try again when one finishes."; write model, effort and the clamped permission mode (`clampSchedulePermissionMode`, never bypassPermissions) to the new session's settings row the way the pre-launch PATCH does; then `dispatchSessionMessage({ sessionId, content: prompt, cwd, runtime, account, agentPath, seedContext, clientId: 'mcp:session_start', origin: { kind: 'agent-launch' } })`. Result JSON `{ sessionId: <canonical>, runtime, account: { id, label } | null, status: 'started' }`.
  One Activity entry per call (actor = the calling agent resolved from the calling session's cwd via Mesh, else 'external MCP'), naming the account and the cwd, following an existing activity writer's shape.
  Tier `session_start: { tier: 'act', area: null, areaNote: AREA_PENDING_PHASE_3, title: 'Start a new agent session' }` + mcp-tool-metadata (not read-only, not idempotent) + tool group.

Tests (FakeAgentRuntime): a named account's root reaches the launch (accountHint in the message opts, resolved by resolveLaunchAccountRoot); unknown account, codex + account, out-of-boundary cwd, unregistered agentPath each refuse with nothing dispatched; advisor marks ineligible, advisor throws, advisor times out → refused; no advisor refuses a call naming an account while a call without account still starts; bypassPermissions clamps to acceptEdits; the 9th concurrent launch refuses and succeeds after one settles; the agent-launch row seeds no permission mode; tier and metadata tables; external /mcp lists the tool.

### Task 3.3: Let a schedule name the Claude account its runs use

- Size medium, priority medium, tracker DOR-2384
- Depends on: nothing
- Parallel with: 1.1, 1.2, 2.5, 3.1

Tracker: DOR-2384 (schedules half). Spec D6 "Schedules". Validation: a schedule with an account runs on that account; changing its account follows the existing re-approval rules; no account keeps today's behavior.

1. `packages/skills/src/schedule-schema.ts`: `account: z.string().min(1).optional().catch(undefined)` with TSDoc (a Claude account registry id; only claude-code runs use it; absent follows the agent, then the default); the serializer writes it back like `model`.
2. `packages/db/src/schema/tasks.ts` `pulse_schedules`: nullable `account` text column + Drizzle migration (next number; check for a newer one first). Map it in the task row mappers; `Task` wire gains `account: string | null`; OpenAPI regenerated.
3. `services/tasks/schedule-permission-clamp.ts`: `ScheduleSettings.account: string | null` (TSDoc bullet: which subscription pays for the run); `scheduleSettingsOf` reads `source.account ?? null`; `scheduleContentKey` appends `settings.account` (10 parts); `CONTENT_KEY_PARTS = 10`; `parseContentKey` reads it (nullable text); `upgradeLegacyContentKey` ALSO upgrades a 9-part key by appending `current.account` (keep the 2- and 3-part paths); `approvalChanges` names an account change ("Account").
4. `task-write-policy.ts`: classify `account` with `model` and `runtime`. `tasks_create`, `tasks_update` and the task HTTP routes accept `account`.
5. Sticky lock: in the task update path, when `task.sticky` and its sticky session already started (the same check the runner uses for `hasStarted`) and `account` changes → 400 `STICKY_ACCOUNT_LOCKED`, message "This schedule keeps one conversation, so it stays on the account it started on. Turn off 'Keep one conversation' to change it." (MCP returns the same text as a tool error).
6. Relay path: schedules can also run through `services/tasks/relay-dispatch.ts`, whose `TaskDispatchPayload` carries only model and effort. Add `account?: string` to `TaskDispatchPayloadSchema` (`packages/shared/src/relay-envelope-schemas.ts`), set it in relay-dispatch.ts, and have `packages/relay/src/adapters/claude-code/task-handler.ts` put it as `accountHint` into its `executionSettings` (spread into BOTH ensureSession and sendMessage, per that file's own comment). No guard on either path: a schedule's account is the operator's approved choice.
7. Direct path, the runner (`task-scheduler-service.ts`): add `accountHint: task.account ?? undefined` to `execution.settings` so it reaches both `ensureSession` and `sendMessage`, and confirm `MessageOpts.accountHint` reaches `launch-resolver.ts` for scheduled runs (extend whatever settings type drops it). An unregistered id falls through the ladder with the existing warning; add that fall-through to the run's Activity detail.

Tests: a relay-dispatched scheduled run carries account into sendMessage; a scheduled run with account resolves that account's root at launch; no account → the launch env is identical to today; changing account on an approved schedule re-parks it (the DOR-2323 test shape); a stored 9-part key upgrades and stays approved; parseContentKey 10 parts; sticky lock; frontmatter round-trip.

### Task 3.4: Let relay messages name the account a new conversation runs on

- Size small, priority medium, tracker DOR-2384
- Depends on: 3.1
- Parallel with: 3.2, 3.5

Tracker: DOR-2384 (relay half). Spec D6 "Relay".

1. `packages/relay`: the payload read in `adapters/claude-code/agent-handler.ts` accepts optional `account: string`. `ExecutionSettingsResolver` opts gain `requestedAccount?: string`; `TurnExecutionSettings` gains `accountHint?: string` (extend the Omit type). agent-handler passes `payload.account` as `requestedAccount` and spreads the returned `accountHint` into the `sendMessage` opts.
2. `apps/server/src/services/relay/turn-execution-settings.ts`: when `requestedAccount` is set, return `accountHint` only if the id is registered AND `checkAccountLaunch({ accountId, cwd: agentDirectory ?? '', runtime: runtimeType, caller: 'relay' })` allows; otherwise log at info and return no hint. Never throw; never drop the message.
3. `relay_send`, `relay_send_async`, `relay_send_and_wait` (in-session and external) gain optional `account` (registry id) setting the payload field; the descriptions say it applies only when the message starts a new conversation.

Tests: a relay turn on a new conversation with account → accountHint reaches sendMessage; an existing conversation (accountRoot set) ignores it; advisor refusal or no advisor → the turn runs without the hint; unknown id → no hint; the MCP tools accept and forward `account`.

### Task 3.5: Put status, account id, account usage and the tracker item on the session list

- Size small, priority high, tracker DOR-2385
- Depends on: 1.2, 2.1, 2.3, 2.4
- Parallel with: 3.2, 3.4

Tracker: DOR-2385 (and the D8 read path). Spec D7. Validation: GET /api/sessions includes status and account usage per session; the OpenAPI docs are updated; no extra per-session calls.

1. New `apps/server/src/services/session/fleet/session-fleet-overlay.ts#applySessionFleetOverlay(page, { store, readAccounts, projectorFor, applyTrackerItems })`: `accountId` where `session.account` matches a registered account (`path.resolve` equality); `status: { lifecycle, limit }` from `projectorFor(session.id)?.status` when present, absent otherwise; `trackerItem` via task 2.4's `applyTrackerItems(page)`; returns `accountUsage = store.peek(distinct accountIds)` or undefined when none.
2. `routes/sessions.ts` GET `/`: call it after `applySessionOriginOverlays`; respond `{ sessions, warnings?, accountUsage? }`, omitting empty keys as `warnings` does. GET `/:id`: the same overlay for one session.
3. If task 1.2 did not add `accountUsage` to `SessionListResponseSchema`, add it here. Register in OpenAPI and run `pnpm docs:export-api`; commit whatever regenerated output the repo tracks (check what the openapi freshness check compares).

Also: for sessions with no live projector, read their `session_limits` rows in ONE `getMany` call (task 2.3) and put `limit` on `status`.

Tests: the list carries accountId, status, trackerItem and accountUsage; a session with a persisted limit and no projector shows it; a spy proves `store.peek` is called once and `store.list` and disk never; a session with no projector has no status; a single-account machine with the account unregistered has no accountId and no accountUsage; the OpenAPI export contains AccountUsage and SessionLimit.

### Task 5.1: When an account runs out, let a person continue on another account or wait, and let an advisor automate it

- Size large, priority high, tracker DOR-2382
- Depends on: 2.1, 2.3, 2.5, 3.1
- Parallel with: 3.2, 3.4, 3.5

Tracker: DOR-2382 (and the server half of DOR-2388, "continue on another account"; the UI half is S5). Spec D9. Works fully WITHOUT flow; the advisor only changes answers. No UI here (S5 renders it).

0. Eligibility for carry-over, from a SERVER-HELD fact, deny by default (Session.origin is best-effort and not a security boundary; do NOT use it for this): add a nullable `launch_origin` text column to `session_metadata` (`packages/db/src/schema/sessions.ts` + Drizzle migration). `RuntimeRegistry.persistSessionRuntime(sessionId, runtime, origin, agentPath)` writes `origin.kind` in the same first-write-wins statement (on INSERT; on the claim of an unbound row only when `launch_origin` is still null, reusing the existing `fillNullsWith` pattern; never overwrite); `rekeySessionSettings` moves it with the row. Carry-over allowed ONLY for `interactive`, `agent-launch`, `account-handoff`. Every other kind (room, schedule, relay-binding, agent-dm, connector-event, test-harness) and a row with NO launch_origin (bound before this change): do not call onLimited; plan `{ mode: 'ask', carryOver: false }`; `POST /continue` → 409 "This conversation did not start here, so it can only wait for the reset." (Session.origin may only color that wording). Add `carryOver?: false` to the `ask` member of LimitPlanSchema (task 1.2's schema; add it here if 1.2 has merged).
   0b. Schema (extend task 1.2's in packages/shared): LimitPlan `waiting` member becomes `{ mode: 'waiting'; resumeAt: string | null; autoResume: boolean; resetConfirmedAt?: string; unconfirmed?: true }`; SessionLimit gains `scope: 'account' | 'model'`, `state: 'limited' | 'wait-only' | 'model-limited' | 'all-accounts-out' | 'handing-off' | 'moved' | 'waiting-reset' | 'reset-ready'`, `modelFallback?: string`, `allOut?: { accountId: string; resetsAt: string | null }`; add `sessionAccountState(status, accountUsage)` returning 'near-limit' when there is no limit and the account's state is 'warning', else `limit.state`, else null. `scope` is 'model' for seven_day_opus, seven_day_sonnet and model:* windows.
   0c. States (spec D9 table): a pure `deriveLimitState(limit, ranking, accountUsage, registeredCount)` in fleet/ with this PRECEDENCE: moved > handing-off > reset-ready > waiting-reset > model-limited > wait-only (carryOver:false, or no other registered account) > all-accounts-out (others exist, none eligible) > limited. Every plan/state change is written to the `session_limits` row (task 2.3) as well as the status; recompute and re-emit the status when the plan changes and on `account_usage` for the session's account or any candidate. model-limited: scope model, the account's five_hour and seven_day have room, and a fallback exists (`callAdvisor('modelFallback', info)`, else default 'sonnet' when the window is seven_day_opus or a model:* bucket not Sonnet's). The model-only continue runs with the session's stored permission mode, and the model must be one the session's runtime offers (else 400). all-accounts-out: plan ask and no eligible account; allOut = earliest resetsAt among registered accounts.
1. Plan on limit: where task 2.3 sets `limit`, compute `plan`: `callAdvisor('onLimited', info)` (task 3.1; `info = { sessionId, cwd, accountId, window, resetsAt, trackerItem? }`) → validated `auto` (registered target ≠ limited account; `fireAt = now + clamp(delaySeconds, 0, 3600)`), `wait` (→ `{ mode: 'waiting', resumeAt: answer.resumeAt ?? limit.resetsAt, autoResume: true }`; task 5.2 arms it) or `ask`; no advisor / failure / invalid → `{ mode: 'ask' }`. Store it on `limit.plan` via a status update. A persisted snapshot whose plan is `auto` hydrates as `ask` (timers do not survive a restart).
2. New `apps/server/src/services/session/fleet/continue-service.ts` (subfolder: services/session is over the dir-size limit): `continueOptions(sessionId)`, `continueOnAccount(sessionId, accountId, by: 'person' | 'advisor')`, `waitForReset(sessionId)`, `cancelAuto(sessionId)`, and the auto timer registry (one timer per session, cleared by wait/cancel/continue/turn_start/shutdown).
3. Routes in `routes/sessions.ts` (thin; OpenAPI-registered): `GET /api/sessions/:id/continue-options` → `{ plan, ranking }` (rankAccounts with caller 'person', purpose 'continue', excludeAccountId = the session's account; a person may pick any registered account, eligible or not); `POST /api/sessions/:id/continue` `{ account?, model? }` → 202 `{ sessionId }` (with account: carry-over, model sets the new session's model; with only model: set the SAME session's model through the existing settings writer and send the continue turn as a person's message (origin interactive, allowed for any launch origin); neither → 400) (400 unknown/unregistered account or non-claude-code session; 409 while streaming; 409 when the session has no current `limit`; idempotent per limit episode via an in-flight marker keyed by (sessionId, limit.since) set SYNCHRONOUSLY before any await and shared with the auto timer: a second caller awaits the first promise and gets the same new session id; after a restart the `continued` plan in the session_limits row answers with that id; for sessions without a live projector every route reads the row); `POST /api/sessions/:id/wait` `{ autoResume?: boolean }` → plan `waiting` (resumeAt = limit.resetsAt; autoResume default = true only if the advisor's onLimited said wait, else false; true requested for an ineligible launch origin → 400), cancels any auto timer, and hands the plan to task 5.2's resume timer; `POST /api/sessions/:id/continue/cancel` → `auto` becomes `ask`. Both answer 409 when the session has no current `limit`.
4. Auto fire: at `fireAt`, re-rank (caller 'advisor', purpose 'continue'); target still eligible → `continueOnAccount(…, 'advisor')`; else plan → `ask` and raise `account.limited` again with detail "could not move it automatically" (new dedupe suffix). At most one automatic carry-over per limit episode. Automatic carry-overs count against `AGENT_LAUNCH_MAX_LIVE` (the in-memory live set from task 3.2 in launch-session.ts; if 3.2 has not landed, add the set there); a fire that finds it full drops to `ask` and repeats the notification. Automatic carry-overs pass `unattendedApprovals: true` (and `unattended: true` to ensureSession) like a timer-fired schedule, so an approval card never waits on nobody; a person's continue does not.
5. `apps/server/src/services/session/fleet/carry-over.ts`: new session id; copy the source row's model, effort and permission mode onto the new session's settings row before the send; new `TurnOrigin` member `{ kind: 'account-handoff' }` mapped to `'none'` in `permissionSeedForOrigin` (TSDoc: the copied row is the power; the origin adds none); `dispatchSessionMessage({ sessionId, content: seed.prompt ?? 'Continue the work from the previous session. The background says where it stopped.', cwd: source cwd, runtime: 'claude-code', account: target, agentPath: source agentPath, seedContext, origin: { kind: 'account-handoff' } })`. Seed: `callAdvisor('carryOver', info, target)` when present and valid, else the DEFAULT SUMMARY. Source plan → `{ mode: 'continued', sessionId: <new canonical>, accountId: target }`. One Activity entry: who (person or advisor), from which account to which, source and new session ids.
6. Default summary (`fleet/carry-over-summary.ts`): mechanical, and NO model call on any path (the exhausted account cannot run one). Contents: previous session id and account label; limit window and reset; cwd, git branch, `git status --short` and `git diff --stat` (run through the repo's git runner, each bounded to ~2 KB, failures omitted); files touched (paths from Edit/Write/NotebookEdit tool calls in the transcript tail); the last tool step (name + target); the first user message; the last 6 user and assistant text messages (each ~800 chars); then the pointer: the previous transcript's absolute path and session id plus "If you need more than this summary, read the end of that file first." (It helps attended carry-overs only: the file is outside the new cwd and an unattended session refuses the read; the summary must stand alone.) Cap at `SEED_CONTEXT_MAX_LENGTH`, dropping the oldest of the last-6 first, then the diff stat. The transcript-reading part is pure over messages; git and path lookups are injected.

Tests (FakeAgentRuntime; fake timers):

- WITHOUT an advisor: a limit gives plan ask; continue-options ranks by weekly headroom with the limited account excluded; continue starts a new claude-code session in the same cwd whose launch resolves the chosen account, seeded with the default summary, with the source's model/effort/mode copied; a second continue returns the same session; wait sets waiting and nothing else happens; 409 while streaming; 400 for an unregistered account.
- Origins: launch_origin written by persistSessionRuntime for each TurnOrigin kind and moved by rekey; interactive, agent-launch, account-handoff carry over; one test for each other kind AND for a row with no launch_origin: ask/carryOver:false, onLimited not called, 409 on continue. No limit → 409 on continue, wait and cancel. A person call racing the auto timer, and two concurrent person calls, start exactly one session. Auto fire with the cap full → ask + notification. Auto carry-over runs unattended.
- WITH an advisor: its ranking (hidden, badges, reasons) is served; onLimited auto fires exactly once at fireAt and carries over with the advisor's seed and prompt; target turned ineligible at fire time → plan ask + repeated notification; advisor throw/timeout → defaults; oversized seed → default summary; cancel and wait stop the timer; a restart-hydrated auto reads as ask.
- The summary builder: every section present; touched files and last tool step extracted; the pointer names the transcript path; cap order (oldest message, then diff stat); tool output excluded; a spy proves no model/runtime query is created.
- States: each state from its condition; all-accounts-out names the earliest reset; model-limited with the default fallback and with an advisor fallback; `continue { model }` switches the same session's model and sends one turn; sessionAccountState near-limit.

### Task 5.2: Wait for an account's reset, confirm it with a reading, and resume the session by itself

- Size medium, priority high, tracker DOR-2382
- Depends on: 5.1, 2.2
- Parallel with: 3.2, 3.4, 3.5

Tracker: DOR-2382 (and the server half of DOR-2388). Spec D9 "Wait, then resume by itself". Works without flow (auto-resume is then off unless a person turns it on); no UI.

1. `apps/server/src/services/session/fleet/resume-service.ts`: for each session whose plan is `waiting`, a timer at `resumeAt` clamped to >= the limit's resetsAt and >= now + 60 s (null resumeAt → no timer; state stays waiting-reset). Cleared by continue, cancel, a new turn_start, and shutdown. On boot, scan `session_limits` (task 2.3's store, `listWaiting()`) and re-arm every waiting row (past → check now); `auto` rows become `ask`.
2. Confirmation, never the clock, and only when the window MOVED ON: the newest store reading for the account's root, else `probeAccount` when the account can be probed (a Claude Code ledger id: registered or `default`) (task 2.2; bypass its 60 s throttle for this caller if the last attempt was before resumeAt). Confirmed iff that reading's `resetsAt` is later than the episode's resetsAt, or (source with no reset time) it was observed after the episode's resetsAt and reads under 90% and not rejected. Registered account unconfirmed → re-check every 10 minutes, at most 6 times. Two fallbacks, each ending in `reset-ready` with `plan.unconfirmed: true` and NO automatic resume: (a) an account that cannot be probed (a memory-only Claude root, or any Codex/OpenCode account) is confirmed only from store readings, and if none confirms by 15 minutes after resumeAt it becomes unconfirmed reset-ready then; (b) a registered account still unconfirmed after its 6th re-check becomes unconfirmed reset-ready at that moment. Confirmed → set `resetConfirmedAt`.
3. On confirmation: if `autoResume` and the session's launch_origin is in the carry-over allowlist (task 5.1 step 0) → `dispatchSessionMessage` to the SAME session with content "Your account's usage has reset. Continue where you left off.", unattended approvals, and a new TurnOrigin member `{ kind: 'account-resume' }` mapped to 'none' in permissionSeedForOrigin (TSDoc: the session is already bound; its row decides power). It counts against AGENT_LAUNCH_MAX_LIVE; cap full → retry in 60 s (while the plan stays waiting). AT MOST ONE automatic resume per session per window reset: record `last_auto_resume_for = <episode resetsAt>` in a new nullable column on `session_metadata` (Drizzle migration; it must survive the session_limits row being deleted at the resumed turn's own turn_start) before dispatch, and have every new episode read it; if the resumed turn hits the limit again in the same window, the new episode can reach only `reset-ready`. Otherwise → state `reset-ready`.
4. Notification kind `'account.reset'` (NOTIFICATION_KINDS + registry): tier 'notable', storage 'event', subjectType 'account' if the registry supports it (else 'session' of the first waiting session), payload `{ accountId, accountLabel, pausedCount, resetsAt }`, title `${accountLabel} is back: ${pausedCount} paused session(s) can continue` (singular/plural), dedupeKey `account-reset:${accountId ?? path}:${resetsAt ?? resetConfirmedAt truncated to the hour}`, relay 'never'. Raised once per account per reset at the first confirmation; pausedCount = sessions on that account whose plan is waiting at that moment.

Tests (fake timers, FakeAgentRuntime, fake probe): a restart between wait and resumeAt still resumes (boot scan of session_limits); a 99% reading and a reading taken before the real reset do NOT confirm; a resumed turn that re-hits the limit in the same window gets only reset-ready (no loop, no second auto turn); the unregistered root confirms from a store reading, else becomes unconfirmed reset-ready 15 minutes after resumeAt; an advisor wait with a past resumeAt is clamped; timer at resumeAt; confirmation by a newer store reading and by a probe; unconfirmed → 6 retries then stop; autoResume sends exactly one turn to the same session with unattended approvals and origin account-resume; autoResume off → reset-ready; ineligible launch origin never auto-resumes; cap full → retried a minute later; one account.reset for three waiting sessions with pausedCount 3; a restart re-arms waiting plans and a past resumeAt checks at once; continue/cancel/new turn clear the timer.

### Task 5.3: Show each session its account's cached usage from the moment it opens, and keep every session on the account in step

- Size medium, priority high, tracker DOR-2380
- Depends on: 1.2, 2.1
- Parallel with: 3.2, 3.4, 3.5, 5.1

Tracker: DOR-2380 (and DOR-2385). Spec §6 U. Works for every runtime and for one account.

1. `SessionStatusSchema` (packages/shared/src/session-stream.ts) gains `accountUsage: AccountUsageSchema.nullable().default(null)` (TSDoc: account-wide cached usage for the account this session bills; `updatedAt`/`observedAt` show freshness).
2. `services/session/fleet/session-account.ts#billingAccountFor(sessionId)`: claude-code → the session's derived `account` root, else the root `resolveLaunchAccountRoot` would pick from the agent and default rungs (the per-session hint only arrives with the first send: re-stamp then), mapped to a registry id or `default`; a memory-only root is read with a new `store.peekByRoot(runtime, root)`; codex/opencode → `default`. Cache per session; invalidate on registry change and on the first send.
3. On projector creation (subscribe, snapshot, first send) stamp `accountUsage` from `store.peek` so the cold snapshot carries it. Updates NEVER go through session streams (codex/opencode projectors persist every event; a usage delta there would pile up in session_events and replay on reconnect): they travel only on the global `account_usage` event (task 2.1), which carries runtime and accountId; clients apply it to every session whose accountUsage names that account, matching on (runtime, accountId), or (runtime, path) when accountId is null. On `store.onChange`, live projectors whose session bills that account update their held `accountUsage` IN MEMORY only (no event), so the next snapshot is current. A watcher-picked CLI reading and a probe go through the same path.
4. Write-through: claude-code's subscription `session_status.usage` is derived from the store record (the binding window, the rule `mapSdkUsageResponse` uses today, now over the store's windows) plus the session's own cost; `session.lastSubscriptionUsage` is no longer the source (keep it only as a fallback while the store has no record). OpenCode's pay-as-you-go `usage` stays per session.
5. `GET /api/sessions/:id` includes `status.accountUsage`.

Tests: open a session (no turn) → snapshot has accountUsage (registered account; implicit default; codex default; memory-only root via peekByRoot); one reading → one account_usage event, and both live sessions' next snapshots carry it; a watcher-picked CLI ledger likewise; an idle codex (history-mode) session writes ZERO session_events rows for usage changes; a session on another account is unaffected; the first send re-stamps with the hint's account; claude-code usage shows the store's binding window without a turn of its own; throttle.

### Task 5.4: Keep each session's context usage so it shows on open and after a restart

- Size small, priority medium, tracker DOR-2385
- Depends on: 1.2
- Parallel with: 5.3, 3.5

Tracker: DOR-2385. Spec §6 U "Context usage is per session".

1. New `session_context` table (`session_id` PK, `context_tokens`, `context_max_tokens`, `observed_at`; Drizzle migration), NOT columns on session_metadata: writing there could create a runtime-less row that persistSessionRuntime reads as an existing conversation, changing first-launch seeding. `rekeySessionSettings` moves the row (add it beside the session_metadata move).
2. Write-through: when a session's status carries context figures (contextTokens and contextMaxTokens, typically the terminal status of a turn), upsert them with observedAt now.
3. Hydrate: a projector created with a cold status fills `contextUsage` from the row. With no row, derive once from the runtime's own record: claude-code from the transcript tail's last main-thread assistant usage (reuse the bounded tail read behind the list's `contextTokens`) plus the model's context window; codex from the rollout's last token_count record via `readCodexTurnContextUsage` (needs the thread id); opencode none. Write the derived value to session_context.

Tests: after a turn the row holds the figures; a new projector after a simulated restart shows them with no transcript read (spy); no row → derived from a transcript fixture and written; codex derivation from a rollout fixture; rekey moves the row; opening a session with no session_metadata row creates none.

## Phase 4: Contract conformance

### Task 4.1: Vendor the flow fleet conformance fixtures and run DorkOS's implementation against them

- Size small, priority high, tracker DOR-2380
- Depends on: 1.1, 1.3, 2.1, 2.4
- Parallel with: nothing

Tracker: DOR-2380 (validation "the ledger file matches flow's format"). Spec §11 "Contract conformance". The shared contract is the marketplace spec `specs/flow-cli-core/02-specification.md` §1 (revision 6; branch `spec/flow-cli-core` until merged, a copy at `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/6843b882-e9ab-4de2-94de-492c4ebdda5e/scratchpad/fleet/CONTRACTS.md`). Read it first; it wins over anything restated here, and a difference is fixed in specs/claude-account-fleet/02-specification.md in the same PR.

The fixture folder `plugins/flow/conformance/fleet/` is merged on marketplace `main` (PR #57; contract revision 6 moves it to CONTRACT_VERSION 2.0.0: vendor the newest merged commit, and if revision 6 has not landed yet, wait for it rather than vendor an older version). Vendor it from the current `origin/main` commit.

1. `scripts/sync-flow-conformance.ts`: `--from <marketplace checkout> --commit <sha>` copies `plugins/flow/conformance/fleet/` at that commit (via `git -C <checkout> archive <sha> plugins/flow/conformance/fleet`) into `packages/shared/src/__fixtures__/flow-fleet-conformance/`, and writes `SOURCE.json` `{ "repo": "dork-labs/marketplace", "commit": "<sha>", "contractVersion": "<CONTRACT_VERSION>" }`. Run it once at the merged commit and commit the vendored files.
2. `packages/shared/src/__tests__/account-usage.conformance.test.ts`: for each case file DorkOS implements, feed `input` (with its `now`) to DorkOS's own function and deep-equal `expected`: `account-id.cases.json` → `claudeAccountId`; `identity.cases.json` → `readClaudeAccountSettings` (+ color resolution where the case expects it); `accounts.cases.json` → the store's per-runtime account list with implicit defaults; `window-read.cases.json` → `readWindow`; `ledger-merge.cases.json` → `mergeLedger`; `codex-rate-limits.cases.json` → `codexObservations`; `prune.cases.json` → DorkOS's prune decision; `eligibility.cases.json` → `toAccountUsage` state where the case is about spend/local room (if its shape does not map, skip it BY NAME with a comment); `flow-run.cases.json` → the lenient reader in apps/server `flow-run-link.ts` (put its pure parse function in shared, or run that one case file from an apps/server test). Validate every ledger in the cases against the vendored `usage-ledger.schema.json` (a JSON-Schema validator already in the tree, e.g. Ajv) AND against `UsageLedgerSchema`, and assert both agree. `fleet-policy.cases.json` and `room.cases.json` are flow-only: skip them BY NAME so a new case file fails the test until someone decides.
3. Fail with a clear message when `CONTRACT_VERSION`'s major is not the one this spec adopts: 2 (contract revision 6, fixtures 2.0.0).
4. Add a README in the fixture folder: where it comes from, how to re-sync, and that a re-sync is a contract change reviewed in both repos.

Tests: the suite itself; prove it can fail by changing one expected value locally (do not commit that).
