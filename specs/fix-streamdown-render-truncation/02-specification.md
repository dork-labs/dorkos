---
slug: fix-streamdown-render-truncation
number: 101
created: 2026-03-07
status: draft
ideation: specs/fix-streamdown-render-truncation/01-ideation.md
---

# Fix streamdown Render Truncation of `[]`-Containing Inline Code

**Status:** Draft
**Authors:** Claude Code, 2026-03-07
**Ideation:** [specs/fix-streamdown-render-truncation/01-ideation.md](./01-ideation.md)

---

## Overview

`streamdown@2.3.0` bundles `remend@1.2.1`, whose incomplete-markdown preprocessor silently discards content after inline backtick code that contains `[]` (e.g. TypeScript array types like `` `number[]` ``) when processing partial text at streaming chunk boundaries. Hard reload renders correctly; the truncation is visible only during live streaming. Upgrading to `streamdown@2.4.0` (which bundles `remend@1.2.2`) fixes the root cause. Total change: one line in `package.json`, one `pnpm install`, and one new regression test.

---

## Background / Problem Statement

DorkOS renders assistant messages via `StreamingText.tsx`, which wraps the `<Streamdown>` component. `Streamdown` accepts a `content` string and passes it through `remend`'s incomplete-markdown preprocessor before handing it to `marked`. This preprocessor is designed to handle gracefully unclosed markdown constructs at the trailing edge of an in-progress stream.

`remend@1.2.1` has a bug: when it encounters `[` inside an already-complete inline code span, it misidentifies it as the start of an incomplete link reference and discards everything from that `[` onward. This produces silent content truncation at streaming chunk boundaries:

- **During streaming:** remend receives partial text where the chunk boundary falls anywhere after a backtick code span containing `[]`. It treats `[` as an incomplete `[link](url)` start and discards the remainder. The last bullet point or following paragraph goes missing.
- **After hard reload:** The full completed text is passed to remend at once. The `[]` is unambiguously inside a closed code span and remend handles it correctly.

`remend@1.2.2` release notes: _"fixes emphasis completion handlers incorrectly closing markers inside complete inline code spans."_ `streamdown@2.4.0` bundles this fix.

**Evidence from DOM inspection:**

- Streaming: `li25.textContent === "Array"` — content truncated
- After reload: `li25.textContent === "Array literals: numbers is typed as number[]"` — correct
- JSONL raw bytes: `- **Array literals**: \`numbers\` is typed as \`number[]\`` — data is intact

---

## Goals

- Inline backtick code containing `[]` (e.g. `` `number[]` ``, `` `string[]` ``, `` `Array<T>[]` ``) renders fully during streaming
- `apps/client/package.json` no longer uses `"latest"` for `streamdown` — pinned to `"^2.4.0"`
- One regression test guards against future library downgrades re-introducing the bug
- No changes to `StreamingText.tsx` or any other component

---

## Non-Goals

- Relay-mode SSE 503 storm and missing messages after navigate-back (covered by spec #100)
- Non-relay markdown rendering paths (unaffected)
- Other `streamdown` prop configuration changes
- Upgrading `lucide-react` or other `"latest"` dependencies (separate concern)

---

## Technical Dependencies

| Dependency   | Current                     | Target               | Notes                            |
| ------------ | --------------------------- | -------------------- | -------------------------------- |
| `streamdown` | `latest` → resolves `2.3.0` | `^2.4.0`             | `remend@1.2.2` bundled           |
| `remend`     | `1.2.1` (transitive)        | `1.2.2` (transitive) | Auto-resolved by pnpm after bump |

No new direct dependencies. No API surface changes.

---

## Detailed Design

### Change 1: Bump `streamdown` version specifier

**File:** `apps/client/package.json`
**Location:** Line 53

```diff
-    "streamdown": "latest",
+    "streamdown": "^2.4.0",
```

The `"latest"` specifier is an anti-pattern for production UI libraries: any future major or minor bump could silently introduce regressions on the next fresh install. `"^2.4.0"` (patch-compatible) is the preferred specifier — it receives patch fixes but not minor/major changes that could break the integration.

### Change 2: Regenerate lockfile

Run `pnpm install` from the repo root. This updates `pnpm-lock.yaml` to resolve `streamdown@2.4.0` and `remend@1.2.2` instead of `streamdown@2.3.0` and `remend@1.2.1`. No other dependencies are expected to change.

### Change 3: Regression test

**File:** `apps/client/src/layers/features/chat/__tests__/StreamingText.test.tsx`

Add one test case to the existing `StreamingText` describe block:

```typescript
it('passes TypeScript array type syntax through without truncation', () => {
  // Purpose: Regression guard for the streamdown@2.3.0/remend@1.2.1 bug where `[]`
  // inside inline code spans caused trailing content to be silently dropped during
  // streaming. Verifies the full content string—including array brackets—reaches
  // <Streamdown> unchanged. This test CAN fail if the dependency is downgraded to 2.3.x.
  const content =
    '- **Array literals**: `numbers` is typed as `number[]`\n\nThis paragraph must also render.';
  render(<StreamingText content={content} />);
  expect(screen.getByTestId('streamdown').textContent).toBe(content);
});
```

The existing `vi.mock('streamdown', ...)` renders children as-is into a `data-testid="streamdown"` div. `textContent` of that div equals the `content` prop passed to `<StreamingText>`. If `remend` truncation were to regress, the content reaching `<Streamdown>` would be shorter and the assertion would fail.

### Data Flow

No flow changes — the fix is entirely at the dependency level:

```
text_delta → stream-event-handler accumulates (unchanged)
  ↓
StreamingText.tsx: passes accumulated string to <Streamdown> (unchanged)
  ↓
remend@1.2.2: preprocesses for incomplete markdown (FIXED — no longer misfires on [] in code spans)
  ↓
Streamdown renderer: renders full content (correct)
```

---

## User Experience

- **Before:** In any streaming response where the assistant uses a TypeScript array type in inline code (`` `number[]` ``, `` `string[]` ``, etc.), the bullet item containing that code and any content following it vanishes mid-stream. Users see truncated, incomplete answers. Hard reload reveals the missing content.
- **After:** Content containing array type syntax streams fully and correctly without reload.

---

## Testing Strategy

### New test: `apps/client/src/layers/features/chat/__tests__/StreamingText.test.tsx`

One test case added to the existing `StreamingText` describe block (detailed above in Detailed Design). The test:

- Renders `<StreamingText>` with content containing `` `number[]` `` followed by a trailing paragraph
- Asserts that the full content string, including the `[]` and the trailing paragraph, appears in the Streamdown mock's output unchanged
- Will fail if remend truncation regresses

### Existing tests to verify pass

- All existing `StreamingText.test.tsx` tests — no behavioral changes to the component
- Full `pnpm test` suite
- `pnpm typecheck` — no TypeScript changes expected

### What the test does NOT cover

The mock isolates `StreamingText` from the real `remend` preprocessor — this is intentional. The test validates the prop-passing contract between `StreamingText` and `Streamdown`, not `remend`'s parsing behavior. The real end-to-end fix is validated by manual streaming with a response that contains `` `number[]` `` (or any array-type inline code) and confirming no truncation occurs.

---

## Performance Considerations

None. A dependency version bump with no API surface changes has zero runtime performance impact.

---

## Security Considerations

None. `streamdown@2.4.0` is a patch-level upgrade to a markdown rendering library with no network-facing API and no changes to `linkSafety` or other security-relevant props.

---

## Documentation

No user-facing documentation changes required. This is a transparent bug fix — users experience correct rendering without any behavioral or API changes.

---

## Implementation Phases

### Phase 1: Complete fix (this spec)

1. **`apps/client/package.json` line 53** — Change `"streamdown": "latest"` to `"streamdown": "^2.4.0"`
2. **`pnpm install`** — Regenerate lockfile to resolve `streamdown@2.4.0` + `remend@1.2.2`
3. **`StreamingText.test.tsx`** — Add one regression test case for array-type inline code

---

## Open Questions

None. All decisions were resolved during ideation. See [01-ideation.md Section 6](./01-ideation.md#6-decisions).

---

## Related ADRs

- No existing ADRs directly govern third-party markdown library version pinning. No new ADR warranted — this is a bug fix with a single-library targeted upgrade, not an architectural decision.

---

## References

- Ideation: `specs/fix-streamdown-render-truncation/01-ideation.md`
- Related spec (Relay streaming bugs): `specs/fix-relay-streaming-bugs/02-specification.md`
- streamdown npm: https://www.npmjs.com/package/streamdown
- remend changelog (1.2.2 fix): https://www.npmjs.com/package/remend
