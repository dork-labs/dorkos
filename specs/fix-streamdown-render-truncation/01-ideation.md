---
slug: fix-streamdown-render-truncation
number: 101
created: 2026-03-07
status: ideation
---

# Fix streamdown Render Truncation of `[]`-Containing Inline Code

**Slug:** fix-streamdown-render-truncation
**Author:** Claude Code
**Date:** 2026-03-07
**Branch:** preflight/fix-streamdown-render-truncation

---

## 1) Intent & Assumptions

- **Task brief:** streamdown@2.3.0 truncates streamed markdown when inline backtick code contains `[]` (e.g. TypeScript array types like `number[]`). The last bullet item and any following paragraph are cut off during streaming; hard reload renders the content correctly.
- **Assumptions:** The bug originates in the `remend@1.2.1` preprocessor (bundled with streamdown@2.3.0), which interprets `[]` inside inline code as an incomplete link reference and discards trailing content. Upgrading to `streamdown@2.4.0` (which bundles `remend@1.2.2`) resolves the issue.
- **Out of scope:** Relay-mode history polling (503 storm) and missing messages after navigate-back — these are covered by spec #100 (`fix-relay-streaming-bugs`). Non-relay markdown rendering paths.

---

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/ui/StreamingText.tsx`: Thin wrapper around `<Streamdown>`. Passes accumulated `content` string, `shikiTheme`, and `linkSafety` props. `parseIncompleteMarkdown` prop exists and defaults to `true` in streamdown, enabling remend preprocessing.
- `apps/client/package.json`: `"streamdown": "latest"` — NOT pinned to a semver range; resolved to 2.3.0 via lockfile.
- `pnpm-lock.yaml` (lines 7078–7083, 14344–14358): `streamdown@2.3.0` resolved with dependencies `clsx@2.1.1`, `hast-util-to-jsx-runtime@2.3.6`, `html-url-attributes@3.0.1`, `marked@17.0.1`, `react@19.2.4`, `react-dom@19.2.4`, `rehype-harden@1.1.8`, and `remend@1.2.1`.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` (lines 128–153): `text_delta` handler performs immutable concat `lastPart.text + text`. Text accumulation confirmed correct — bug is downstream in the renderer.
- `apps/client/src/layers/features/chat/__tests__/StreamingText.test.tsx`: Mocks streamdown entirely (`vi.mock('streamdown', ...)`). No edge-case tests for array type syntax.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Streaming status managed via `statusRef.current`. No role in this bug.
- `decisions/`: No ADR directly covering third-party markdown library version pinning.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/chat/ui/StreamingText.tsx` — wraps `<Streamdown>`, primary affected component
- `apps/client/package.json` — declares `"streamdown": "latest"` (needs to become a pinned version)
- `pnpm-lock.yaml` — resolves `streamdown@2.3.0` + `remend@1.2.1`

**Shared Dependencies:**

- `remend@1.2.1` (transitive via streamdown) — the remend preprocessor that misparsing `[]`
- `marked@17.0.1` (transitive via streamdown) — underlying markdown parser

**Data Flow:**

```
stream-event-handler.ts: text_delta → accumulate (correct)
  ↓
StreamingText.tsx: passes accumulated string to <Streamdown>
  ↓
remend@1.2.1: preprocesses for incomplete markdown (MISPARSING HERE)
  ↓
Streamdown renderer: renders what remend returns (truncated)
```

**Feature Flags/Config:**

- `parseIncompleteMarkdown` prop on `<Streamdown>` — defaults to `true`, enabling remend. Disabling it would be a workaround but breaks other incomplete-markdown handling during streaming.

**Potential Blast Radius:**

- Direct: `apps/client/package.json` (version bump), `pnpm-lock.yaml` (auto-updated by pnpm)
- Indirect: Any component rendering `<Streamdown>` (only `StreamingText.tsx` in this codebase)
- Tests: `StreamingText.test.tsx` (may need a new test for the `number[]` edge case; existing mock is unaffected)

---

## 4) Root Cause Analysis

**Repro steps:**

1. Enable relay mode (`DORKOS_RELAY_ENABLED=true`)
2. Start a session and send: `Add TypeScript types to the function`
3. Observe the streaming response — the last bullet item containing `\`number[]\``renders as just`**Array**`; the closing paragraph is absent

**Observed vs Expected:**

- Observed: `<li>` contains only `<span class="font-semibold">Array</span>`; no closing paragraph rendered
- Expected: Full `**Array literals**: \`numbers\` is typed as \`number[]\`` and the following paragraph both rendered

**Evidence:**

- DOM inspection during streaming: `li25.textContent = "Array"` (truncated)
- DOM inspection after hard reload: `li25.textContent = "Array literals: numbers is typed as number[]"` (correct)
- JSONL raw text is correct: `- **Array literals**: \`numbers\` is typed as \`number[]\``
- `stream-event-handler.ts:136`: immutable concat is correct — truncation is NOT in text accumulation

**Root-cause hypotheses:**

1. **remend@1.2.1 misidentifies `[]` as incomplete link reference** (HIGH CONFIDENCE — SELECTED)
   - remend's preprocessing converts `\`number[]\``to a broken state: the`[`inside backtick code triggers the incomplete-link handler, which then discards everything from`[`onward looking for a`](url)` close
   - remend@1.2.1 does not correctly respect that `[]` appears inside a complete inline code span; it fires the link completion handler based on `[` presence alone
   - The bug only triggers at chunk boundaries — when a chunk ends with `\`number[]\``, remend sees an incomplete `[...]` in a partial document and fires its completion logic incorrectly
   - Hard reload works because the full text is passed to remend at once; `[]` inside a complete code span is unambiguous and handled correctly

2. **streamdown@2.3.0 marked parser issue** (LOW CONFIDENCE)
   - Unlikely: marked@17.0.1 is a well-tested library; the streaming-only nature of the bug points to the incremental preprocessor (remend), not the parser

**Decision:** Root cause is `remend@1.2.1`'s incomplete-link detection firing inside inline code spans. Fixed in `remend@1.2.2` which "fixes emphasis completion handlers incorrectly closing markers inside complete inline code spans."

---

## 5) Research

**Potential Solutions:**

**1. Upgrade streamdown to 2.4.0 (pins remend@1.2.2)**

- Description: Bump `"streamdown": "latest"` to `"streamdown": "2.4.0"` in `apps/client/package.json`. `streamdown@2.4.0` bundles `remend@1.2.2` which contains the fix for incorrectly closing markers inside complete inline code spans.
- Pros:
  - Clean fix — addresses root cause, no workaround code
  - No changes to `StreamingText.tsx` — component stays unchanged
  - remend@1.2.2 also fixes other related inline-code edge cases
  - Eliminates the "latest" risk for future unintended upgrades
- Cons:
  - Requires testing that streamdown@2.4.0 doesn't introduce regressions
  - Need to verify the lockfile resolves correctly with `pnpm install`
- Complexity: Low
- Maintenance: Low

**2. Disable `parseIncompleteMarkdown` during streaming**

- Description: Pass `parseIncompleteMarkdown={false}` to `<Streamdown>` when `isStreaming` is true in `StreamingText.tsx`. After streaming completes, re-render with `parseIncompleteMarkdown={true}`.
- Pros: No dependency change; guaranteed to stop the misparse
- Cons: Unclosed bold/italic/code markers (common during streaming) will render as raw markdown characters, degrading the visual experience significantly. Introduces a prop toggle that complicates `StreamingText.tsx`.
- Complexity: Low
- Maintenance: Medium (fragile to future streamdown changes)

**3. Pre-process accumulated text to escape `[]` inside backtick spans**

- Description: Before passing text to `<Streamdown>`, find all backtick-delimited spans containing `[]` and escape or transform them to prevent remend from misfiring.
- Pros: No dependency change; surgical fix for the specific pattern
- Cons: Regex-on-markdown is notoriously fragile; any edge case in the regex (nested backticks, escaped backticks) could cause new bugs. Adds complexity to `StreamingText.tsx`. Doesn't fix the underlying library bug.
- Complexity: Medium
- Maintenance: High

**Recommendation:**

Approach 1 — upgrade streamdown to 2.4.0. The fix is in the library and the upgrade is a single line change. Additionally, pin the version to `"2.4.0"` (exact) rather than `"latest"` to prevent future unintended upgrades causing new regressions.

**Secondary fix:** The `"latest"` specifier in `package.json` is an anti-pattern for a pinned production UI library. Pin to `"^2.4.0"` (patch-compatible) or `"2.4.0"` (exact) during this change.

---

## 6) Decisions

No interactive clarification was needed — the fix approach converges unambiguously on upgrading the library.

| #   | Decision                         | Choice                                                | Rationale                                                                                                                                            |
| --- | -------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fix approach for `[]` truncation | Upgrade streamdown to 2.4.0                           | Root cause is in remend@1.2.1; remend@1.2.2 (bundled in streamdown@2.4.0) contains the inline-code span fix. Single-line change, no workaround code. |
| 2   | Version specifier for streamdown | Pin to `"^2.4.0"`                                     | Replace `"latest"` with a semver range to prevent unintended upgrades while still receiving patch fixes.                                             |
| 3   | Test coverage                    | Add one streaming-path test to StreamingText.test.tsx | Currently mocked away; add a test that verifies `number[]` content is passed through to Streamdown untruncated. Low effort, prevents regression.     |
