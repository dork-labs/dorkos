# Implementation Summary: Rich Text in the Composer

**Created:** 2026-08-08
**Last Updated:** 2026-08-08
**Spec:** specs/composer-rich-text/02-specification.md
**Branch:** `composer-rich-text`
**Work item:** DOR-948

## Progress

**Status:** Phases 1-4 complete. Phase 5 (docs, changelog, e2e, full gate) outstanding.
**Tasks completed:** 4.1-4.5 this session; 1.1-3.8 in earlier sessions.

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

## What phase 5 needs to know

1. **Changelog fragments are NOT minted.** Phase 5 consolidates. One user-facing change to
   describe: the message box can format as you type, off by default, switch in Settings → Advanced.
2. **Browser verification of both flag states is NOT done** and is part of 4.5's acceptance. The
   checklist is in task 4.5: flag off behaves as today; flag on formats and keeps every ladder rung;
   `> ` and ` ``` ` visibly do nothing; flipping the switch off with a formatted draft restores the
   markdown source. A screenshot of the flag-on composer showing bold, a heading and a two-item
   list is still owed to the work item.
3. **Docs.** `contributing/configuration.md` is updated. User-facing docs under `docs/` are not —
   phase 5 owns whether a Fumadocs page mentions this. `docs/getting-started/configuration.mdx` was
   deliberately left alone: it carries no `ui` preference table at all (neither `ui.theme` nor
   `ui.statusBar` appear in it), so a row there would be the only one of its kind.
4. **The playground entry exists** (`/dev`, Chat → Input, `composer-input`) with a flag-on variant.
5. **The graduation criteria are unmet by design.** Criterion 6's number is recorded (93,598 B
   gzip). Criteria 4 (IME) and 5 (screen reader) need a person and a real browser and are not
   automatable. Rooms, dashboard and onboarding graduate in a follow-up work item, which should be
   captured when this one closes.
6. **e2e:** no Playwright test drives the rich field yet. The page objects
   (`apps/e2e/pages/ChatPage.ts`, `RoomsPage.ts`) locate the composer by
   `getByRole('combobox')`, which the rich field preserves, so they keep working with the flag off
   and should keep working with it on.
