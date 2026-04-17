# Task Breakdown: Terminal Reason Chip

Generated: 2026-04-17
Source: specs/terminal-reason-chip/02-specification.md
Last Decompose: 2026-04-17

## Overview

Surface the SDK's non-`completed` `terminal_reason` as an informational Shadcn Badge rendered between `ChatMessageArea` and `ChatStatusStrip`. Server plumbing already landed in spec 245; this work is purely a new client component, a tiny pure-logic label module, a barrel export, a one-line `ChatPanel` wire-up, and tests.

## Phase 1: Implementation

### Task 1.1: Create terminal-reason-labels module

**Size**: small
**Priority**: high
**Dependencies**: None
**Can run parallel with**: none (everything else either imports from this or validates after it)

**Files**:

- `apps/client/src/layers/features/chat/ui/status/terminal-reason-labels.ts` (new)

**Implementation**:

- Define a frozen `KNOWN_LABELS` record mapping all 12 documented `TerminalReason` values to their English labels (see spec §6.3 copy table).
- Export `isVisibleReason(reason?)` — returns `false` for `undefined` and `'completed'`, `true` otherwise. Narrows type via `reason is TerminalReason`.
- Export `formatTerminalReason(reason)` — returns curated label for known values, delegates to private `humaniseRawReason` for forward-compat `string` fallbacks.
- Private `humaniseRawReason` transforms snake/kebab → Sentence case, returns `'Ended'` on empty input.
- Import only `type { TerminalReason } from '@dorkos/shared/types'`.

**Acceptance Criteria**:

- [ ] File exists at the specified path.
- [ ] `isVisibleReason(undefined)` and `isVisibleReason('completed')` both return `false`.
- [ ] `formatTerminalReason('max_turns')` returns `'Max turns reached'`.
- [ ] `formatTerminalReason('some_future_reason')` returns `'Some future reason'`.
- [ ] `formatTerminalReason('FOO_BAR_BAZ')` returns `'Foo bar baz'`.
- [ ] `KNOWN_LABELS` is frozen.
- [ ] `pnpm lint` and `pnpm typecheck` pass for this file.

---

### Task 1.2: Create TerminalReasonChip component

**Size**: small
**Priority**: high
**Dependencies**: 1.1
**Can run parallel with**: none (1.3/1.4 need the file to exist; 1.5 imports it)

**Files**:

- `apps/client/src/layers/features/chat/ui/status/TerminalReasonChip.tsx` (new)

**Implementation**:

- Named export `TerminalReasonChip({ terminalReason }: TerminalReasonChipProps)`.
- Uses `isVisibleReason` to gate rendering; `formatTerminalReason` to derive the label.
- Wraps a Shadcn `Badge` (variant `secondary`) inside `AnimatePresence` + `motion.div` with `key={terminalReason}`, 200ms ease-out fade + 4px y-translate.
- Container classes `flex justify-center px-4 py-1 md:justify-start`.
- `data-testid="terminal-reason-chip"` on the motion container; `aria-label={` `Session ended: ${label}` `}` on the Badge.
- No local state, no effects, no timers. Pure display.
- Imports only from `motion/react`, `@dorkos/shared/types`, `@/layers/shared/ui`, and `./terminal-reason-labels`.

**Acceptance Criteria**:

- [ ] File exists at the specified path.
- [ ] Returns empty DOM when `terminalReason` is `undefined` or `'completed'`.
- [ ] Renders the formatted label inside a `secondary` Badge otherwise.
- [ ] `data-testid` and `aria-label` match the spec strings exactly.
- [ ] FSD imports respected (no cross-feature imports, no SDK imports).
- [ ] `pnpm lint` and `pnpm typecheck` pass.

---

### Task 1.3: Re-export TerminalReasonChip from status barrel

**Size**: small
**Priority**: high
**Dependencies**: 1.2
**Can run parallel with**: 1.5 (test file imports from the direct path, not the barrel)

**Files**:

- `apps/client/src/layers/features/chat/ui/status/index.ts` (modified — append one export)

**Implementation**:

- Append `export { TerminalReasonChip } from './TerminalReasonChip';` preserving existing exports.

**Acceptance Criteria**:

- [ ] New export present in the barrel.
- [ ] No pre-existing exports altered.
- [ ] `import { TerminalReasonChip } from '@/layers/features/chat/ui/status'` resolves.

---

### Task 1.4: Wire TerminalReasonChip into ChatPanel

**Size**: small
**Priority**: high
**Dependencies**: 1.3
**Can run parallel with**: 1.5 (1.5 does not depend on ChatPanel wiring)

**Files**:

- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` (modified — 1 import, 1 element)

**Implementation**:

- Import `TerminalReasonChip` from `'./status'`.
- Insert `<TerminalReasonChip terminalReason={sessionStatus?.terminalReason} />` between `<ChatMessageArea ... />` and `<ChatStatusStrip ... />`.
- No other changes. No new props anywhere else.

**Acceptance Criteria**:

- [ ] Import added, element rendered in the correct slot.
- [ ] No changes to `MessageList`, `MessageItem`, `AssistantMessageContent`, `ChatStatusSection`, or `ChatStatusStrip`.
- [ ] Existing `ChatPanel.test.tsx` continues to pass (adjust a DOM-count assertion only if one exists and fails).

---

### Task 1.5: Write TerminalReasonChip component tests

**Size**: medium
**Priority**: high
**Dependencies**: 1.2
**Can run parallel with**: 1.3, 1.4, 1.6

**Files**:

- `apps/client/src/layers/features/chat/__tests__/TerminalReasonChip.test.tsx` (new)

**Implementation**:

- `@vitest-environment jsdom` directive at the top.
- Six test blocks with `// Purpose:` comments per project convention:
  1. Renders nothing when `terminalReason` is `undefined`.
  2. Renders nothing when `terminalReason` is `'completed'`.
  3. Table-driven `it.each` over all 11 curated non-`completed` labels.
  4. Humanises unknown raw string reasons (forward-compat).
  5. Exposes `aria-label` with `"Session ended:"` prefix.
  6. Exposes `data-testid="terminal-reason-chip"` when visible.
- `afterEach(cleanup)` — no persistent DOM between cases.
- Imports `TerminalReasonChip` from `'../ui/status/TerminalReasonChip'`.
- No Transport mock (component has no data dependencies).

**Acceptance Criteria**:

- [ ] All 6 blocks / 16 assertions pass.
- [ ] Scoped run: `pnpm vitest run apps/client/src/layers/features/chat/__tests__/TerminalReasonChip.test.tsx` exits 0.
- [ ] No regressions in the wider chat feature test suite.

---

### Task 1.6: Write terminal-reason-labels pure-function tests

**Size**: small
**Priority**: medium
**Dependencies**: 1.1
**Can run parallel with**: 1.2, 1.3, 1.4, 1.5

**Files**:

- `apps/client/src/layers/features/chat/__tests__/terminal-reason-labels.test.ts` (new)

**Implementation**:

- Pure Node test (no jsdom directive).
- Three `formatTerminalReason` fallback cases:
  - `'FOO_BAR_BAZ'` → `'Foo bar baz'`.
  - `'foo-bar'` → `'Foo bar'`.
  - `'ended'` → `'Ended'`.

**Acceptance Criteria**:

- [ ] All 3 assertions pass.
- [ ] `pnpm vitest run apps/client/src/layers/features/chat/__tests__/terminal-reason-labels.test.ts` exits 0.

---

### Task 1.7: Final validation — lint, typecheck, scoped vitest

**Size**: small
**Priority**: high
**Dependencies**: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
**Can run parallel with**: none (terminal gate)

**Files**:

- No edits. Validation-only task.

**Implementation**:

- Run in order: `pnpm lint`, `pnpm typecheck`, `pnpm vitest run apps/client/src/layers/features/chat`.
- Confirm regression surface (spec §8.3): `MessageList.test.tsx`, `ChatStatusSection-configure.test.tsx`, `ChatStatusStrip.test.tsx`, and `ChatPanel.test.tsx` still pass.
- Expected vitest delta = previous pass count + 19 new assertions (16 from component tests + 3 from label tests).
- Optional: manual dev-playground smoke (`pnpm dev`, force `max_turns`, confirm chip renders and clears as specified).

**Acceptance Criteria**:

- [ ] `pnpm lint` exits 0.
- [ ] `pnpm typecheck` exits 0.
- [ ] Scoped vitest run exits 0 with the expected new pass count.
- [ ] No unrelated files touched (Appendix A unchanged list respected).
- [ ] Manual verification run or explicitly deferred with reason.
