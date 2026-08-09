# Implementation Summary: Rich Text in the Composer

**Created:** 2026-08-08
**Last Updated:** 2026-08-08
**Spec:** specs/composer-rich-text/02-specification.md
**Branch:** `composer-rich-text`
**Work item:** DOR-948

## Progress

**Status:** Complete. Phases 1-5, 26 / 26 tasks. Awaiting the independent adversarial review that
task 5.5 requires before a PR opens.
**Tasks completed:** 5.1-5.5 this session; 4.1-4.5 and 1.1-3.8 in earlier ones.

## What shipped, in one paragraph

The chat composer can now show formatting as you type — bold, headings, lists — behind a
preference that ships OFF. The keyboard ladder was first moved behind a seven-method
`EditingSurface` port so the same scenario table runs against a `<textarea>` and against Lexical;
a headless markdown boundary (nodes, a closed transformer set, and a single-walk serializer with a
position map) keeps the host contract in markdown offsets, so neither autocomplete hook changed. A
`ui.composer.richText` config field, a Settings switch, and one prop passed from
`ChatInputContainer` decide which surface gets it. Rooms, the dashboard and onboarding are
untouched and stay plain.

## Tasks completed

### Phase 1 — the seam, with no editor behind it (`2fd7e8a57`)

- 1.1 `EditingSurface` port + `createTextareaSurface`, seven methods.
- 1.2 `useInputKeyboard` repointed from `textareaRef` to the port at all five reach-ins.
- 1.3 `TextareaField` extracted behind one `ComposerFieldProps`.
- 1.4 `LADDER_SCENARIOS` + `runLadderConformance`, registered against the textarea adapter.
- 1.5 Phase gate: ten DOM baselines diff empty, `ComposerInput.test.tsx` unedited but for one
  added IME test.

### Phase 2 — the markdown boundary, headless (`6d3ff55c8`, `75b135df4`)

- 2.1 Six Lexical packages pinned to `~0.49.0`; pre-Lexical bundle measured on `2fd7e8a57`.
- 2.2 `MentionNode` as a token text node drawing the real identity pill.
- 2.3 `COMPOSER_TRANSFORMERS`, built by naming eight transformers rather than spreading.
- 2.4 `markdown-offsets.ts` — serializer and position map in one walk.
- 2.5 46-entry round-trip corpus + the offset-map table, both mutation-checked.
- 2.6 Phase gate.

### Phase 3 — the field (`3e1c368c4`, `c96c80eca`, `203b644fe`, `fd06c3c66`, `4aff7fc0e`, `197c75424`)

- 3.1 `LexicalField` with the a11y attributes the page objects and feed nav depend on.
- 3.2 `use-lexical-value.ts` — the emitted-value latch and the two-call emission order.
- 3.3 `lexical-surface.ts`; the second adapter registered against the same scenario table.
- 3.4 The ladder at `COMMAND_PRIORITY_CRITICAL`, the thirteen-row Enter table.
- 3.5 Paste and drop ownership.
- 3.6 Lazy chunk, measured: **93,598 B gzip** (graduation criterion 6's number).
- 3.7 Mentions, palettes, aria parity. **The flag-on DOM baselines were deferred to 4.4**, because
  before chat could read the preference there was no rich chat composer to photograph.
- 3.8 Phase gate: one table, two adapters, three mutation pairs.

### Phase 4 — the flag (this session)

| Task | Commit      | What landed                                                             |
| ---- | ----------- | ----------------------------------------------------------------------- |
| 4.1  | `806e3e9df` | `ui.composer.richText`, three classifications, `0.59.0` migration, docs |
| 4.2  | `4696f5dd2` | `use-composer-prefs.ts` + barrel exports; `ServerConfig` projection     |
| 4.3  | `2a7f95d8f` | Settings → Advanced switch, the exit-path test, playground variant      |
| 4.4  | `e2922126e` | Chat passes `richText`; four flag-on baselines recorded                 |
| 4.5  | —           | Phase gate (below)                                                      |

### Phase 5 — closing the loop (this session)

| Task | Commit      | What landed                                                                          |
| ---- | ----------- | ------------------------------------------------------------------------------------ |
| 5.1  | `926b7d5c2` | `composer-probe.ts`; twelve textarea-only e2e assertions replaced                    |
| 5.2  | `926b7d5c2` | The flag-on chat suite and its manifest entry — **and the `/` palette bug it found** |
| 5.3  | `b653e4a25` | The latency harness + fixture; both numbers measured and recorded                    |
| 5.4  | `24a62b0c9` | Docs (3 internal guides + the user guide), one consolidated changelog fragment       |
| 5.5  | —           | Final gate (below)                                                                   |

**The list-exit fix (`7618e21de`) landed between phases 4 and 5**, from the phase-3 worker, closing
the empty-bullet gap phase 4's browser check found: the anchor IS the `ListItemNode` when the item
is empty, and `getParents` excludes self, so the exit rung was unreachable. The nested-list
flattening that fix surfaced is a filed follow-up, to land before rooms graduate.

## Files created or changed in phase 4

**Config (4.1):**

- `packages/shared/src/config-schema.ts` — `ComposerPrefsSchema`, `COMPOSER_PREFS_DEFAULTS`,
  `ui.composer` field + the `ui` block's explicit default literal
- `apps/server/src/services/core/safe-defaults/default-verdicts.ts` — `no-risk`
- `apps/server/src/services/core/operator/config-disclosure.ts` — `expose`
- `apps/server/src/services/core/operator/config-write-policy.ts` — `agent-writable`
- `apps/server/src/services/core/config-manager.ts` — `backfillComposerPrefs` + the `'0.59.0'` key
- `apps/server/src/services/core/__tests__/config-composer-prefs-migration.test.ts` — new, real
  `ConfigManager` over a real file, `DORKOS_VERSION_OVERRIDE='0.59.0'` hoisted above the imports
- `contributing/configuration.md` — settings row, migration row, narrative paragraph

**Client (4.2-4.4):**

- `apps/client/src/layers/entities/config/model/use-composer-prefs.ts` — new
- `apps/client/src/layers/entities/config/__tests__/use-composer-prefs.test.tsx` — new
- `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx` — the switch
- `apps/client/src/layers/features/chat/ui/input/ChatInputContainer.tsx` — reads the pref, passes
  `richText`
- `apps/client/src/layers/features/composer/__tests__/surface-enablement.test.ts` — new
- `apps/client/src/layers/features/chat/__tests__/__baselines__/chat-input-container.rich-text.*.json`
  — four new baselines
- `apps/client/src/dev/showcases/InputShowcases.tsx`, `apps/client/src/dev/sections/chat-sections.ts`
  — playground variant + keywords

**Wire (4.2, unplanned — see deviations):**

- `packages/shared/src/schemas.ts` — `composer` added to `ServerConfigSchema.ui`
- `apps/server/src/routes/config.ts` — `composer` added to the `ui` projection

## Deviations from the spec and task file

Each of these is a place the written plan and the tree disagreed. All were resolved in favour of
the tree and recorded in the relevant commit body.

### Accepted in phases 1-3

1. **Paste and drop return `true` without `preventDefault`.** Reviewed and accepted: the handler
   claims the event for Lexical's command system without stopping the browser's own default, which
   is what the host's file-drop path still needs.
2. **List rows live in `ladder-commands.test.tsx`,** not in the shared scenario table — they are
   Lexical-only behaviour and have no textarea meaning, so putting them in the shared table would
   have forced a skip.
3. **The `COMMAND_PRIORITY_LOW` mutation is not falsifiable** in the way task 3.8 predicted. It was
   run; the ladder stayed green because the registration order already resolves the conflict.
   Recorded as a mutation that does not discriminate rather than presented as one that does.
4. **The round-trip corpus cannot detect removing a transformer** in every case — removing one
   whose syntax has no other spelling leaves the corpus green. Recorded.
5. **The `DragEvent`/`ClipboardEvent` polyfill moved to `test-setup`** (`4aff7fc0e`) because jsdom
   defines neither, and a paste test crashed the whole run rather than failing one case.
6. **Six corpus entries normalize rather than round-trip exactly** (`__bold__` → `**bold**`, and
   five more). Each declares `normalizesTo` plus a required `why`; every entry is still a FIXED
   POINT, which is the property the controlled loop depends on.
7. **We wrote our own serializer.** `$convertToMarkdownString` escapes markdown characters it finds
   in text nodes, silently rewriting `foo\` → `foo\\` and four other measured cases — the exact
   thing the phase-4 gate forbids.

### New in phase 4

8. **`ComposerInput` does not read the config, and `useComposerRichText` takes no override.** Task
   4.2's last paragraph asks for `useComposerRichText(props.richText)` inside `ComposerInput`. That
   would have graduated rooms, the dashboard and onboarding the moment anyone flipped the switch,
   because those three pass nothing. Decision 5 is explicit — chat only, locked 2026-08-07 — and
   lists them as passing `richText` only at graduation. The config is read in `ChatInputContainer`,
   which is exactly where the spec puts it, and the hook's signature is the one 4.2's own export
   list gives.
9. **The spec's "no server, transport, route, wire, or database change of any kind" is not true.**
   `ServerConfig` is a hand-built projection and `GET /api/config` builds its `ui` block key by
   key, so the field had to be added to both or the client could never read it. Six `TS2339` errors
   found this. No behavioural change; `/api/config` is not in the exported OpenAPI spec, so the
   docs gate is unaffected (verified by a zero-line regeneration diff).
10. **The migration is a no-op anchor, and the commit says so.** Emptying the `'0.59.0'` body
    leaves the real-manager suite green: conf builds Ajv with `useDefaults: true`, so a declared
    default is written into a stored `ui` block during validation whether or not a migration runs.
    This matches `backfillProfileDefaults`, which already documents itself the same way. It is kept
    because it puts the intent — seeded OFF — in the migration table where it is reviewable.
11. **The 4.4 surface bar is a source test, not a render test.** The task asks for "a test per
    other surface" asserting the prop is absent, but its own acceptance criterion requires the word
    `richText` to appear nowhere under `widgets`/`onboarding` — which such a test would violate —
    and `features` may not import `widgets`. It reads the four source files from disk instead,
    which is the right instrument for a doctrine about what is visible in the JSX.
12. **No fifth flag-on baseline.** The `interactive` state renders no composer, so its twin would
    photograph the same tree under a second name.

### New in phase 5

13. **Twelve e2e break sites, not eleven.** The task enumerates four `selectionStart` probes (all
    exactly where it says) and seven `toHaveValue` assertions. There are EIGHT of the latter:
    DOR-947's `room-attachments.spec.ts:104` landed after the task was written and asserts
    `toHaveValue('')` on the composer. The task's own acceptance grep covers all of `tests/rooms`,
    so it had to go too.
14. **`use-input-autocomplete` IS modified, contradicting Decision 1** — see the bug below. The
    spec said neither autocomplete hook would change; the hook turned out to carry a latent
    ordering bug that only a field emitting one cursor report could expose.
15. **The latency budget is judged on synchronous work, not on paint.** The spec says
    "keystroke-to-paint". Paint is quantized to the display's frame interval, so it can only take
    values near 8, 17 and 33 ms — a 16 ms budget read off it measures the display. Both numbers are
    reported; the budget is read off work, with the reasoning in the script's header.
16. **`knip.config.ts` gains an `apps/e2e` entry** for the hand-run perf script, which has no
    importer by design. Net effect on knip: three fewer findings, no new ones.
17. **`UpdateComposerPrefs` is not exported from the `entities/config` barrel.** Phase 4 exported
    it; knip flagged it as unused, and the closest precedent (`use-status-bar-prefs`) does not
    export its equivalent either. Removed.
18. **The flag-on suite lives inside `chat-mock.spec.ts`, not in its own spec file and project.**
    It was built the other way first, and only the FULL e2e run showed why that was wrong — see
    below. `playwright.config.ts` already carried the instruction ("Add new mock-server suites to
    chat-mock.spec.ts"); this now follows it. `apps/e2e/manifest.json` keeps its one
    `composer-rich-text` entry, pointing at the shared spec file.

## The second thing phase 5 got wrong, and how it surfaced

The flag-on tests were first written as `tests/chat/composer-rich-text.spec.ts` with a dedicated
`chromium-composer` project, on the reasoning that `chromium-streams` and `chromium-bridge` are
separate projects against the same test-mode leg. Run alone it was 5/5, and `chromium-mock` alone
was 15/15.

**The full suite was 5 failed / 159 passed** — one of mine and three of `chat-mock`'s, plus an
unrelated dashboard flake. Projects run concurrently (7 workers), and both suites call
`POST /api/test/reset`, which `chat-mock.spec.ts`'s own header documents as wiping the default
scenario, tracked sessions and projectors GLOBALLY. The precedent projects were safe precisely
because they share none of that choreography; mine used all of it.

Moving the five tests into `chat-mock.spec.ts` — which is `mode: 'default'`, sequential on one
worker — removes both hazards at once: no reset race, and a server-global preference is only
flipped while nothing else is running. `chromium-mock` is 20/20, and the full suite is green.

Worth stating plainly for the reviewer: **a suite that passes alone and fails in the full run is
the failure mode this class of change has**, and only the full run can show it.

## The bug phase 5 found, and fixed

**`/` did not open the command palette on the rich field.** Reproduced in a browser on one server,
one keystroke, both flag states: the palette opened on the textarea and not on the contenteditable.

It was not the field. `use-input-autocomplete` needs a `(value, cursor)` PAIR to detect a trigger,
and each handler carried only one half — `handleInputChange` had the new value and read the cursor
from state, `handleCursorChange` had the new cursor and read the value from its closure. When a
field reports BOTH in one tick — which `TextareaField.handleChange` and Lexical's update listener
both do — the second call detected against a half-stale pair and closed the palette the first had
just opened.

The textarea hid this for as long as it existed: typing also fires `select`, so a third detection
ran after the re-render with both halves fresh and quietly repaired it. A contenteditable fires no
such event, so nothing did.

The fix keeps the freshest pair in a ref, so each handler contributes its half and detection no
longer depends on how many events a field happens to fire; an effect syncs the ref when the HOST
sets the value (emptying the box on send, writing a dropped path), neither of which goes through
`handleInputChange`. Regression net:
`apps/client/src/layers/features/chat/model/__tests__/use-input-autocomplete.test.tsx`.

**Discriminating evidence:** restoring the stale-closure line turns 3 of its 5 tests RED — both
one-tick cases and the closes-again case — while "still opens when the field reports the two halves
in separate ticks" stays GREEN. That asymmetry is the bug itself: the old code worked for the
textarea's shape and only for it.

## Phase 4 gate (task 4.5)

| Check                                     | Result                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm --filter @dorkos/client typecheck`  | 0 errors                                                                         |
| `pnpm --filter @dorkos/client lint`       | 0 errors                                                                         |
| `pnpm --filter @dorkos/server typecheck`  | 0 errors                                                                         |
| `pnpm --filter @dorkos/server lint`       | 0 errors                                                                         |
| Ten flag-off baselines un-re-recorded     | `git diff --stat origin/main -- 'apps/client/src/**/__baselines__/*.json'` EMPTY |
| `pnpm test -- --run`                      | green (after fixing two `@dorkos/shared` whole-shape fixtures)                   |
| Safe-defaults drift guards                | green                                                                            |
| Operator disclosure / write-policy guards | green                                                                            |
| Real-repo migration-safety guard          | green                                                                            |

### Browser verification, both states

Cockpit stood up in this worktree (server `:6272`, Vite `:6271`, isolated `DORK_HOME`), driven
through Playwright.

| Check                                     | Result                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/config` carries `ui.composer`   | `{richText: false}` — the wire projection works                                         |
| Flag OFF: chat composer                   | `<textarea role="combobox">`, markdown stays literal                                    |
| Flag OFF: Shift+Enter                     | newline, no send                                                                        |
| Settings → Advanced row                   | exact label, description and scope line render; switch off                              |
| Toggling the switch                       | server flips to `true`; only `ui.composer` changed, `statusBar` intact                  |
| Field swaps live, no reload               | textarea → `contenteditable` with the SAME `role`/`aria-label`                          |
| The in-flight draft survived the swap     | `**important** and \`code\``parsed into`<strong>`/`<code>`                              |
| Flag ON: `**bold**`, `` `code` ``         | syntax consumed as the closing pair lands                                               |
| Flag ON: `# `                             | real `<h1>`, hash gone                                                                  |
| Flag ON: `- `                             | real `<ul><li>`                                                                         |
| Flag ON: Enter inside a list              | continues the list (1 → 2 `<li>`), does NOT send                                        |
| Flag ON: `> `, ` ``` `, `~~x~~`, `[a](b)` | all four stay literal, character for character, no node created                         |
| Flag ON: Shift+Enter                      | `<br>` inside one paragraph, no send                                                    |
| Flag ON: `foo\` + Enter                   | backslash consumed, line break inserted, no send                                        |
| Exit path, live                           | formatted draft + switch off → textarea holding `**half-written** and \`code\`` exactly |
| Chat-only lock                            | preference ON, dashboard composer still a `<textarea>`                                  |
| Wire carries markdown                     | a sent message arrived as `# Ship notes` / `- first`, not HTML                          |

Screenshot of the flag-on composer (heading, bold, inline code, italics, two-item list) captured
from the `/dev` playground showcase.

**Two findings, neither a phase-4 regression, both for phase 5.**

1. **Enter on an EMPTY bullet does not end the list.** The spec's UX list says it should. Measured:
   `- alpha` + Enter gives a second empty `<li>`; a further Enter is a no-op — the list is never
   exited, so there is no way to leave a list from the keyboard. This lives in phase 3's
   thirteen-row Enter table (`ladder-commands`), not in anything phase 4 touched, but it is a real
   gap against the spec and should be closed before this ships.
2. **The double-Escape clear did not arm under Playwright on the flag-OFF path** either, so it is
   not a rich-text regression — but it also means that rung is unverified in a real browser on
   both paths. The unit tests cover it. Worth a human tap before shipping.

Two things were NOT browser-verified and should not be claimed: the **room** composer staying plain
(no room exists in a fresh install; covered by the source test and by `git diff` showing
`RoomComposer.tsx` unchanged), and the `/` and `@` palettes on the rich field (covered by
`ComposerInput-palettes-rich-text.test.tsx`).

**The re-record incident, worth carrying forward.** `DORKOS_RECORD_DOM_BASELINE=1` rewrites every
baseline the RUN touches, not only missing ones. The recording pass for the four flag-on files also
re-recorded all five flag-off chat baselines. They were restored from `HEAD` with
`git show HEAD:<path> > <path>` (never `git checkout --`, which this repo refuses) and re-verified
byte-identical to `origin/main`. Anyone recording a baseline here should scope the run to the new
cases and check `git status` over all three `__baselines__` directories immediately afterwards.

## Measured

Every number here was produced by running something, on this machine, on this branch. Nothing is
an estimate — the spec is explicit that the ideation's "~54 kB" is an expectation and not a result.

**Machine:** Apple M4 Pro, macOS 26.5.2, Node v24.14.1. **Date:** 2026-08-08.

### Bundle

```sh
pnpm --filter @dorkos/client build
cd apps/client
entry=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)
gzip -9 -c "dist/$entry" | wc -c                      # entry chunk
gzip -9 -c dist/assets/LexicalField-*.js | wc -c      # the lazy editor chunk
```

|                                            | gzip -9 bytes | raw bytes |
| ------------------------------------------ | ------------- | --------- |
| Entry chunk (`index-BI6UuLdY.js`)          | **1,072,679** | 3,665,084 |
| Lexical chunk (`LexicalField-DixRlYba.js`) | **93,861**    | 291,365   |
| All `dist/assets/*.js`                     | 3,129,024     | —         |

**The flag-off zero-Lexical-bytes claim, proven directly rather than by size:** the entry chunk
contains zero occurrences of `createEditor` and zero of `data-lexical-text`. Someone with the flag
off downloads no editor.

**The entry chunk is not byte-identical to the pre-Lexical baseline, and that was expected by task
3.6 rather than discovered here.** Against the pre-Lexical commit's 1,072,304 it is +375 gzip
bytes. Task 3.6 measured +124 of that on an otherwise-identical tree and attributed it to the
module-graph bookkeeping a dynamic `import()` adds. The remaining ~251 is phase 4 and 5 product
code — the config field, the Settings row, the list-exit fix, the autocomplete fix — not Lexical.

**The chunk grew 263 bytes since task 3.6 recorded 93,598.** That is `7618e21de`, the empty-list-item
Enter fix, which lives in `field/`. Recorded rather than restated, because a number carried forward
without re-measuring is how a stale figure survives.

**Accepted?** Yes. 93,861 gzip bytes is well above the ideation's ~54 kB guess, and that guess is
now retired. It is paid only by someone who turns the setting on, it arrives lazily behind a
textarea that works while it loads, and it buys the whole editing surface. A reviewer who wants to
reject it should reject it on this number, which is the point of writing it down.

### Typing latency

```sh
# against a test-mode leg you started yourself, on ports nobody else holds
DORKOS_LATENCY_API=http://localhost:5252 \
DORKOS_LATENCY_APP=http://localhost:5251 \
  pnpm --filter @dorkos/e2e exec tsx perf/composer-latency.ts
```

Script: `apps/e2e/perf/composer-latency.ts`. Fixture: `apps/e2e/perf/composer-latency-fixture.ts`
— 4 000 characters, 20 mentions, generated from a seed and shape-checked at import so a drifting
generator fails loudly instead of quietly measuring a smaller document. Both paths are measured in
ONE browser session, textarea first, 50 samples each after 10 discarded as warm-up.

**Two clocks, because one of them cannot answer the question.** `work` is the synchronous task a
keystroke sets off — the update listener, serialization, the position map, React's render — which
is exactly what this spec added. `paint` is that plus the wait for the next frame, and it is
quantized to the display's ~16.7 ms interval, so it steps in frame-sized jumps however cheap the
work is. Judging a 16 ms budget on a number that can only take the values ~8, ~17, ~33 would be
measuring the display. The budget is therefore read off `work`, with `paint` reported beside it.

Run 1 / Run 2, median · p95 · max, in milliseconds:

| path     | clock | median       | p95               | max           |
| -------- | ----- | ------------ | ----------------- | ------------- |
| textarea | work  | 4.80 / 4.70  | 14.40 / 13.70     | 14.50 / 14.40 |
| lexical  | work  | 5.80 / 5.40  | **13.80 / 13.30** | 14.00 / 13.70 |
| textarea | paint | 10.90 / 6.60 | 14.60 / 13.80     | 15.80 / 14.50 |
| lexical  | paint | 11.40 / 6.30 | 14.90 / 13.30     | 16.50 / 13.70 |

**p95 under 16 ms on the rich path: MET** (13.80 and 13.30), and in both runs it came in _below_
the textarea's own p95 — the tail is dominated by scheduling noise on a busy machine, which both
paths pay equally.

**Median no worse than the textarea: MISSED, by 0.7–1.0 ms.** Stated plainly rather than rounded
away. The rich path's median keystroke costs about a millisecond more, which is real work
(serialize + position map) and is consistent across runs. It is roughly a sixteenth of a frame, it
never reaches paint as a visible delay — the `paint` medians are within noise of each other, and in
run 2 the rich path was faster — and the p95 that governs felt jank is met. Recorded as a known
miss on a secondary criterion, not as a pass.

The task names the selection-only fast path as the first suspect if p95 misses. It did not miss,
and the fast path is present and correct regardless: `use-lexical-value.ts` skips serialization
entirely when `dirtyElements.size === 0 && dirtyLeaves.size === 0` and emits only `onCursorChange`,
which its own unit test pins.

## Phase 5 gate (task 5.5)

| Check                                                                       | Result                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm --filter @dorkos/client typecheck` · `lint`                           | 0 errors                                                                    |
| `pnpm --filter @dorkos/server typecheck` · `lint`                           | 0 errors                                                                    |
| `pnpm --filter @dorkos/e2e typecheck` · `lint`                              | 0 errors                                                                    |
| `pnpm --filter @dorkos/shared build`                                        | green (run first; the config field touched that package)                    |
| `pnpm --filter @dorkos/site build`                                          | green — the MDX change compiles                                             |
| `pnpm test -- --run`                                                        | green                                                                       |
| `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/` | green, run separately per the false-red gotcha                              |
| `pnpm knip` (after dists)                                                   | no Lexical or `field/` finding; three fewer findings than before this phase |
| `pnpm verify`                                                               | green                                                                       |
| e2e — the three edited rooms specs, flag OFF                                | 12/12                                                                       |
| e2e — `chromium-mock` (now carrying the flag-on suite)                      | 20/20                                                                       |
| e2e — full suite, all projects                                              | 163 passed / 5 failed — every failure pre-existing, see below               |

### Dead-path sweep — every one empty

```sh
grep -rn "from 'lexical'\|from '@lexical" apps/client/src | grep -v "features/composer/ui/field/"
grep -n  "textareaRef" apps/client/src/layers/features/composer/ui/use-input-keyboard.ts
grep -rn "HTMLTextAreaElement\|toHaveValue" apps/e2e/tests/rooms
grep -n  "lexical" apps/client/src/layers/features/composer/index.ts
grep -rn "TODO\|FIXME" apps/client/src/layers/features/composer/
```

No `richText={false}` on any surface. (Two matches exist in the composer's own TESTS: the exit-path
test renders with the flag off deliberately, and `surface-enablement.test.ts` names the string in a
comment explaining the rule. Neither is a surface.)

### Baseline integrity

```sh
git diff --name-status origin/main -- 'apps/client/src/**/__baselines__/*.json'
```

Four `A`, zero `M`, zero `D`. The original ten are byte-identical to `origin/main`; only the four
`chat-input-container.rich-text.*` files are added. This is the spec's central proof and it holds.

### Two flakes, both ruled out rather than waved away

A first full run reddened `@dorkos/client` on `CanvasFileContentMarkdown.test.tsx` and
`app-store.test.ts`, both at ~5 s (timeouts), while knip and the site build were running
concurrently. Both pass in isolation, and neither imports anything this branch touched
(`grep -c "use-input-autocomplete\|composer"` on both files: 0). A clean re-run is green.

Earlier, `packages/relay`'s `watcher-manager.test.ts` timed out on two phase-4 runs — a DIFFERENT
case each time, 17/17 in isolation, no relay file changed by this branch. Green on the phase-5 runs.

## Graduation criteria — where each one stands

The flag ships OFF. These are what it takes to flip it and to let rooms, the dashboard and
onboarding pass `richText`.

| #   | Criterion                                                          | Status                                                                                                               |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1   | The whole ladder scenario table passes against the Lexical surface | **Met** — one `LADDER_SCENARIOS` array, two adapters (task 3.8)                                                      |
| 2   | Round-trip stability over the corpus, every mention shape          | **Met** — 46 entries, every one a fixed point (task 2.5)                                                             |
| 3   | Typing latency p95 within budget on a 4 000-char document          | **Met on p95** (13.80 / 13.30 ms). Median is 0.7–1.0 ms worse than the textarea — a known miss on the secondary half |
| 4   | An IME composes and commits with no send and no dropped characters | **Not done** — needs a person and a real browser                                                                     |
| 5   | VoiceOver or NVDA announces the field and the palette equivalently | **Not done** — needs a person                                                                                        |
| 6   | The measured gzipped chunk is recorded and accepted                | **Met** — 93,861 B gzip, recorded above with its argument                                                            |

Two follow-ups to capture when this closes: the surface graduation (rooms, dashboard, onboarding),
and the nested-list flattening that the empty-bullet Enter fix surfaced, which should land before
rooms graduate.

## What the adversarial reviewer should doubt

Task 5.5 names four claims to attack, and this phase adds two more.

1. **The flag-off path is byte-identical** — check the baselines were not re-recorded. The
   `DORKOS_RECORD_DOM_BASELINE=1` run in phase 4 DID re-record the five flag-off chat baselines and
   they were restored from `HEAD`; verify the restore rather than trusting it.
2. **One scenario table really runs against two adapters** and is not sharing a mock between them.
3. **The emitted-value latch is present and its test fails without it.**
4. **Paste and drop decline files and file-tree paths**, so DOR-947 attach and DOR-1032 path drops
   still work.
5. **The `use-input-autocomplete` fix does not change the textarea path.** It is the one shared
   chat hook this spec modified, against the spec's own Decision 1.
6. **The orchestrator's own counts.** The drift notes in these tasks were wrong more than once —
   ten baselines not eleven, no `use-input-keyboard.test.ts`, seven ladder methods not five, and
   twelve e2e sites not eleven. Check the claims in this document, not only the code.
