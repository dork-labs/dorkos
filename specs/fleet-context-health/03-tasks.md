# Tasks — Fleet-level context health (per-session gauge + fleet summary)

**Spec:** `specs/fleet-context-health/02-specification.md` · **Slug:**
`fleet-context-health` · **Tracker:** DOR-113 (task→feature, size 5) · **Mode:**
full · **Generated:** 2026-07-17

13 tasks across 4 phases. **Phase 1 (shared client source) and Phase 2
(server + DTO) run fully in parallel** — P1 is client-only; P2 is
shared/server/test-utils; they share zero files. The two new DTO fields are
**optional** (additive, non-viral), so **no compile-gate task is needed** — the
workspace stays green after every task boundary, unlike DOR-109's required-field
change. Phase 1 lands the single shared percent/threshold source **first** so no
later phase can add a fifth percent copy, and every migrated percent site keeps
its existing tests passing against the shared module. Phase 3 (client data +
merge) joins P1 and P2; Phase 4 (surfaces + docs/changelog/ADR) sits on top.
Tests live in the phase that verifies them (`__tests__/` alongside source),
never bunched at the end.

## Dependency graph

```
Phase 1 (client):   1.1 → 1.2
Phase 2 (server):   2.1 → { 2.2 ∥ 2.3 }
                    Phase 1 ∥ Phase 2   (client vs shared/server/test-utils — zero file overlap)

Phase 3 (client):   3.1                 (independent — needs only the shipped
                                         SessionContextUsage; may start at once)
                    3.2 ← { 1.1, 2.1, 3.1 }   (the confluence: P1 + P2 + store)
                    3.3 ← 3.2

Phase 4:            4.1 ← 3.2   ∥   4.2 ← 3.3        (the two surfaces, parallel)
                    { 4.3, 4.4, 4.5 } ← { 4.1, 4.2 }   (e2e ∥ prose ∥ ADR)
```

Compact form:
`(1.1→1.2) ∥ (2.1→{2.2∥2.3}); 3.1 indep; 3.2←{1.1,2.1,3.1}; 3.3←3.2; (4.1←3.2 ∥ 4.2←3.3); {4.3,4.4,4.5}←{4.1,4.2}`.

**Critical path (5 deep):** `{1.1|2.1} → 3.2 → 3.3 → 4.2 → {4.3|4.4|4.5}`.

**Mutually independent (parallelizable):**

- **All of Phase 1 ∥ all of Phase 2** (no shared files).
- **`3.1` ∥ Phases 1 and 2** — the store retention needs only the shipped
  `SessionContextUsage` type; it can run at any time and is the data-layer
  foundation `3.2` builds on.
- Within Phase 2, **`2.2` ∥ `2.3`** after `2.1` (transcript-reader vs
  test-utils/aggregation — different packages).
- Within Phase 4, **`4.1` ∥ `4.2`** (gauge in `entities/session/ui` vs bar in
  `features/session-list/ui`), and **`4.3` ∥ `4.4` ∥ `4.5`** (e2e, prose, ADR).

No task reaches `xl`, so none is promoted to its own sub-issue (threshold `xl`).

---

## Phase 1 — Shared client source (client-only; ∥ Phase 2)

### Task 1.1: `entities/session/lib/context-health.ts` — the ONE percent/threshold/severity module + unit tests

New pure module in `entities/session/lib` (the lowest FSD layer every consumer
reaches). Exports `CONTEXT_WARNING_PERCENT` (80), `CONTEXT_CRITICAL_PERCENT`
(95), `ContextSeverity`, `contextSeverity`, `deriveContextPercent`
(`min(100, round(tokens/maxTokens*100))`, null on missing/non-positive), and
`resolveDisplayContextPercent` (prefer the SDK `contextUsage.percentage`, else the
estimate). Barrel-exported. Unit tests: formula + null/zero-window + 100-cap;
severity boundaries 79/80/94/95; display-resolver preference. Lands **first**.

- size: sm · priority: high · deps: none · ∥ 2.1, 2.2, 2.3, 3.1 · cites spec §Detailed Design 4

### Task 1.2: Migrate the four percent sites + the compaction-chip threshold onto `context-health`

De-dup the four existing copies + the chip threshold onto 1.1, **no behavior
change** (each site's existing tests keep passing): `ContextItem.tsx:22,24`,
`use-compaction-chip.ts:23` (delete `COMPACTION_CHIP_THRESHOLD_PERCENT` + its
caveat), `derive-status-bar.ts:39-43`, `use-session-status.ts:92-94`,
`ChatStatusSection.tsx:264-269`. Cross-slice sites import from the
`entities/session` barrel; the same-slice `use-session-status.ts` imports the
sibling `../lib/context-health` (no self-barrel). After this, exactly one formula
and one threshold set exist.

- size: md · priority: high · deps: 1.1 · ∥ 2.1, 2.2, 2.3, 3.1 · cites spec §Detailed Design 4, Acceptance Criteria

---

## Phase 2 — Server + DTO (shared/server/test-utils; ∥ Phase 1)

### Task 2.1: `SessionSchema` — new optional `lastAutoCompactAt` + documented `contextTokens` + OpenAPI regen

Two **optional, additive, non-viral** changes to `SessionSchema`
(`schemas.ts:112-127`): TSDoc the existing `contextTokens` (semantics broadened
to a list-carried best-effort reading), add new
`lastAutoCompactAt: z.string().datetime().optional()`. Flat fields (no nested
object), no `maxTokens`, no `RuntimeCapabilities`/conf/SQLite change. Regenerate
OpenAPI (`pnpm --filter @dorkos/shared build && pnpm docs:export-api`) so
`docs/api/openapi.json` lands and openapi-fresh stays green. Workspace green after
this task alone — **no compile-gate task needed.**

- size: sm · priority: high · deps: none · ∥ 1.1, 1.2, 3.1 · cites spec §Detailed Design 2

### Task 2.2: claude-code `transcript-reader` — extend `readTailStatus`, fold tail into `extractSessionMeta`, simplify `getSession` + tests

Fold the existing tail read into the mtime-cached list path
(`transcript-reader.ts`). (a) `readTailStatus` also returns `lastAutoCompactAt`
(most recent `compact_boundary` with `trigger:'auto'`, manual ignored) in the same
16 KB scan. (b) `extractSessionMeta` folds the tail read so the cached `Session`
carries `contextTokens` + `lastAutoCompactAt`; cache contract: hit → `fs.stat`
only; miss → one 8 KB head + one 16 KB tail (`O(changed files)`). (c) simplify
`getSession` to return `extractSessionMeta` directly (delete the now-redundant
overlay — no half-migration). Tests: reading present; auto vs manual boundary;
mtime cache no-re-read then re-read on bump; no-tokens → omit.

- size: md · priority: high · deps: 2.1 · ∥ 1.1, 1.2, 2.3, 3.1 · cites spec §Detailed Design 1, §Testing (Server — tail read + cache)

### Task 2.3: `FakeAgentRuntime` + fixtures carry the reading; aggregation/degradation tests (ADR-0310)

Give `FakeAgentRuntime`/mock-factories the ability to emit rows that carry
`contextTokens`/`lastAutoCompactAt` (claude-code-shaped) or omit them
(codex/opencode-shaped) — never forced. Aggregation tests against
`aggregate-session-list.ts`: merged list carries readings only for claude-code,
others omit; a rejecting runtime → `warnings[]` + zero rows, never fails the
aggregate. Confirm `runtimeConformance` forces no reading.

- size: md · priority: high · deps: 2.1 · ∥ 1.1, 1.2, 2.2, 3.1 · cites spec §Testing (Server — aggregation/degradation), ADR-0310

---

## Phase 3 — Client data + merge (joins P1 + P2)

### Task 3.1: `session-list-store` — retained `contextReadings` map + `useSessionContextReading` selector + store tests

Add a retained-per-session `contextReadings: Record<string, SessionContextReading>`
(set on any `session_status` with `contextUsage`) that survives settle — the
existing `statuses`/`statusCwds` idle/interrupted prune stays **exactly as today**
(two-map split, Decision 3). Clear it on `session_removed`, rekey-retire, and
`resetStatuses`. New `useSessionContextReading` selector, barrel-exported. Tests:
populate; retain across settle while `statuses` prunes; clear on
remove/rekey/reset. **Needs only the shipped `SessionContextUsage`** — no hard P1/P2
edge, so it may start immediately.

- size: md · priority: high · deps: none · ∥ 1.1, 1.2, 2.1, 2.2, 2.3 · cites spec §Detailed Design 5, §Testing (store retention)

### Task 3.2: `useSessionContextHealth` — the list-vs-live merge resolver (live wins) + hook tests

Per-session resolver (`entities/session`) with **live-wins** precedence: live
reading (`contextReadings`) → `deriveContextPercent(totalTokens, maxTokens)`,
`fresh:true`; else `session.contextTokens` → `deriveContextPercent(tokens, window)`
via `useModels` catalog window, `fresh:false`, `asOf:updatedAt`; else `unknown`
(never 0%). `severity` from `contextSeverity`; `autoCompactedAt` from
`session.lastAutoCompactAt`. Tests: live wins; list-only via catalog + `fresh:false`;
unknown when no reading and when the model window is absent. **The confluence of
P1 + P2 + the store.**

- size: md · priority: high · deps: 1.1, 2.1, 3.1 · cites spec §Detailed Design 6, §Testing (merge rule)

### Task 3.3: `useFleetContextRollup` — runtime-neutral fleet counts + tests

Fold `useSessionListSessions()` through the §6 rule (reuse 3.2's resolution — no
new copy; extract a pure core if hooks-in-fold forbids) into
`{ total, known, unknown, warning, critical, autoCompacted }`. "Near full" =
`warning+critical`. Runtime-neutral + surface-agnostic (the staged dashboard tile
reuses it). Tests: mixed-fleet counts; near-full sum; unknown never counted as a
reading; auto-compacted counted regardless of percent.

- size: md · priority: high · deps: 3.2 · cites spec §Detailed Design 7, §Testing (rollup)

---

## Phase 4 — Surfaces + docs/changelog/ADR

### Task 4.1: `SessionContextGauge` on `SessionRow` — quiet gauge + auto-compacted marker + honest unknown + a11y + RTL

Small gauge (`entities/session/ui`) fed by `useSessionContextHealth`, placed in
the `SessionRowFull.tsx:151` icon cluster. Known → severity-tinted compact percent
(ring/bar, not a loud badge); auto-compacted → discreet marker + "Auto-compacted
{relative time} to free up context."; unknown → muted glyph + "Context usage isn't
available for this session yet. Open it to see live usage." (never 0%); stale list
reading adds "as of {relative updatedAt}." a11y labels; must not steal the row's
click. RTL for all states.

- size: md · priority: high · deps: 3.2 · ∥ 4.2 · cites spec §Detailed Design 8a, §9, §User Experience

### Task 4.2: `FleetContextBar` on the Sessions/Overview tab — multi-count summary + all-healthy/hidden states + a11y + RTL

`RelayHealthBar`-shaped bar (`features/session-list/ui`) fed by
`useFleetContextRollup`. Copy: "All sessions have room." / "{n} near full · {m}
auto-compacted" (drop a zero clause; **hidden entirely** when zero known and zero
pressure). **Placement decision:** top of `SessionsView`'s scroll region above the
list, beside the ADR-0310 `warnings[]` block (`SessionsView.tsx:64-70`); component
stays placement-agnostic. RTL: multi-count, all-healthy, hidden, dropped clause,
`aria-hidden` dots.

- size: md · priority: high · deps: 3.3 · ∥ 4.1 · cites spec §Detailed Design 8b, §User Experience

### Task 4.3: E2E (optional) — gauge on rows + summary bar + honest unknown row

Playwright (`apps/e2e`, test-mode-backed): rows show a gauge, the tab shows the
summary bar, an unknown row reads muted (aria-label "Context usage unknown"), not
broken/0%. Resilient to fixture data (assert presence + honest unknown, not exact
percentages). Optional-but-recommended per the spec.

- size: md · priority: medium · deps: 4.1, 4.2 · ∥ 4.4, 4.5 · cites spec §Testing (E2E, optional)

### Task 4.4: User-facing prose — docs note + changelog fragment (Added)

Docs note on the session-list page: per-row gauge + fleet summary, honest that some
runtimes read "unknown" until opened (register a new page in `contributing/INDEX.md`
if added; keep `docs:coverage` green). Changelog fragment
`changelog/unreleased/<YYMMDD-HHMMSS>-fleet-context-health.md` (id from
`.claude/scripts/id.ts`), **`### Added`** — a headline differentiator, benefit-first,
honest per-runtime coverage, no unverified end-to-end claim. Both in
`writing-for-humans` voice.

- size: sm · priority: medium · deps: 4.1, 4.2 · ∥ 4.3, 4.5 · cites spec §Documentation

### Task 4.5: Draft ADR (proposed) — fleet-level context health (extends ADR-0310)

`/adr:from-spec` (preferred) or by hand: status **proposed**, title "Fleet-level
context health — best-effort list reading + live override, honest per-runtime
degradation". Capture the two-layer data path (tail-read list reading + live
`session_status` override, live wins), the single shared client percent source, and
the field-absence + `warnings[]` honesty model that **extends ADR-0310**. Cross-link
ADR-0263/0264, reference DOR-112 and DOR-100. Add the `decisions/manifest.json`
`proposed` entry.

- size: sm · priority: low · deps: 4.1, 4.2 · ∥ 4.3, 4.4 · cites spec §Related ADRs

---

## Verification (VERIFY stage)

Per-task `Verify:` commands are targeted (`pnpm --filter <pkg> typecheck`,
`pnpm vitest run <path>`, `pnpm docs:export-api`). Whole-feature close-out:
`pnpm verify` (affected typecheck + lint + test), plus the spec's acceptance
criteria — one client percent/threshold source (four copies gone); a listed
claude-code session carries `contextTokens` + `lastAutoCompactAt` (mtime-cached, no
re-read on unchanged transcript); codex/opencode closed rows omit them and render
"unknown"; live wins over list while a settled session retains its reading; a model
with no catalog window → "unknown", not 0%; no `RuntimeCapabilities`/conf/SQLite
change and `runtimeConformance` passes for every runtime; the dashboard tile,
durable compaction persistence, a codex registry patch, and opencode sidecar reads
are **not** built (out of scope).
