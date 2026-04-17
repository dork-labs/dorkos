---
slug: status-aware-loading-affordance
number: 248
created: 2026-04-17
status: specified
---

# Status-Aware Loading Affordance for `system_status.status`

**Status**: Specified
**Authors**: Claude Code (2026-04-17)
**Related Ideation**: None — this spec extracts a deferred UI task (5.4) from spec 245 (`claude-agent-sdk-upgrade-0.2.112`).
**Related Spec**: `specs/claude-agent-sdk-upgrade-0.2.112/02-specification.md` (completed Phase 5 backend plumbing; visual variant deferred here).

---

## 1) Overview

The Claude Agent SDK (≥ 0.2.108) now emits a structured `status` field on `system.status` events — currently two values, `'requesting'` and `'compacting'` — that narrates what phase of work the model is in. Spec 245 wired that value end-to-end: `SystemStatusEventSchema.status` is optional-string, the server mapper forwards it verbatim, and the client stream handler receives it. Today the client throws the structured value away and renders only the human-readable `message` string through the existing `system-message` priority rung in `ChatStatusStrip`.

This spec threads `system_status.data.status` into the per-session Zustand store and adds a single conditional branch in `ChatStatusStrip` so the structured value can drive calmer, more deliberate copy (`'requesting'` → "Thinking…", `'compacting'` → "Compacting context…") instead of the mapper's generic fallback string (`"Status: requesting"`). When `status` is absent the strip falls back to its current behaviour — no regression for pre-0.2.108 SDKs, relay adapters, or future runtime backends that never emit the field.

## 2) Background / Problem Statement

### What exists today

- **Shared schema** (`packages/shared/src/schemas.ts:581-592`): `SystemStatusEventSchema` carries both a `message: string` and an optional `status?: string`. `status` is deliberately `z.string().optional()` rather than a closed enum so forward-compat to future SDK values ("planning", "tool_waiting", etc.) is schema-free.
- **Server mapper** (`apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts:115-128`): reads `msg.status` and forwards it on the outbound event. When the SDK sends only `status` (no human body), the mapper synthesizes `"Status: <status>"` so the existing renderer has _something_ to show.
- **Client stream handler** (`apps/client/src/layers/features/chat/model/stream/stream-event-handler.ts:254-258`): destructures only `{ message }` from the `SystemStatusEvent` and drops it into `setSystemStatus(message)`. The structured `status` field is ignored.
- **Store** (`apps/client/src/layers/entities/session/model/session-chat-store.ts:70,120`): `SessionState.systemStatus` is typed `string | null` — there is no structured slot.
- **Renderer** (`apps/client/src/layers/features/chat/ui/status/ChatStatusStrip.tsx`): the `system-message` priority rung (priority 3) wins over `streaming` whenever `systemStatus` is truthy. `deriveSystemIcon` picks `RefreshCw` when the message contains "compact", `Shield` for "permission", otherwise `Info`. The streaming rung otherwise shows the rotating-verb UX (`useRotatingVerb` cycles through `DEFAULT_THEME.verbs` every `verbInterval` ms).

### What's missing

The structured signal is on the wire but isn't shaping the UI. Three concrete consequences:

1. **Awkward copy for `'requesting'`**: when the SDK sends `status: 'requesting'` with no `body`, users see "Status: requesting" — the mapper's literal fallback. The rotating-verb UX would read better ("Thinking…", "Reasoning…") but it's suppressed because the system-message rung outranks streaming.
2. **String-matching for icons**: `deriveSystemIcon` inspects `message.toLowerCase()` for substrings. That's fragile — a future SDK message change can silently break icon selection even though the structured `status` field is stable.
3. **No forward-compat hook**: when the SDK adds a third value (say, `'tool_waiting'`), we have no clean extension point. Extending the switch on `status` is one `case` statement; extending a regex ladder is riskier.

### Why a conditional variant, not a new state

The current state machine has six top-level states (`rate-limited`, `waiting`, `system-message`, `streaming`, `complete`, `idle`). Adding a seventh state for "status-aware system message" would duplicate 80% of the `system-message` renderer and complicate the priority stack. Instead we extend the existing `system-message` state with an optional `status` discriminator and let the renderer choose copy conditionally. This is the minimum diff that delivers the semantic improvement.

### Alternative considered — mark as won't-do

The brief explicitly permits marking this spec won't-do if the existing rotating-verb UX is judged adequate. It is not, for two reasons:

- The rotating-verb UX only runs when `systemStatus === null` (priority 3 outranks priority 4). Whenever the SDK fires `system.status` — which is _every_ turn in 0.2.108+ — the strip is in system-message mode, not streaming mode. The rotating verbs never appear during normal inference.
- "Status: requesting" is visibly worse than the rotating verbs _and_ worse than a deliberate "Thinking…". The minimum quality bar is matching what we'd show with no status at all.

Recording this decision here rather than in Open Questions because it is load-bearing for whether the spec proceeds.

## 3) Goals

- Thread `system_status.data.status` through the stream-event handler into `SessionState` so the renderer can read it without re-wiring SSE.
- Render a status-specific variant of the `system-message` rung with calm copy:
  - `'requesting'` → "Thinking…"
  - `'compacting'` → "Compacting context…"
  - Any other string (forward-compat) → fall back to the existing `message` text.
- Preserve the existing behaviour exactly when `status` is absent or null.
- Ship one component-level unit test that covers the `'requesting'` conditional branch end-to-end through `ChatStatusStrip`.
- Keep the `system-message` state as the single rung that handles this — do not add a new top-level state.

## 4) Non-Goals

- **Rebuilding the `ChatStatusStrip` state machine.** Priority stack, state names, and rung semantics are untouched.
- **Adding per-status icons or spinner variants.** `deriveSystemIcon` stays as-is; status-aware copy reuses whichever icon `deriveSystemIcon(message)` picks.
- **Status values beyond the two SDK 0.2.108 emits.** No speculative support for `'planning'`, `'tool_waiting'`, etc. Forward-compat is delivered by falling back to `message`, not by enumerating values.
- **Relay adapter / external agent support.** This spec only shapes the Claude Code runtime's `system.status` pass-through. Relay and Codex adapters don't emit the field.
- **Reordering or gating the rotating-verb UX.** Whether rotating verbs should ever show for `'requesting'` is a separate question handled in Open Questions.
- **Internationalization of the new copy.** The strip copy is English-only today; status-aware copy inherits that.

## 5) Technical Dependencies

No new dependencies. All hooks into code already in the tree:

| Package                 | File                                                                      | Current state                                                                       |
| ----------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `@dorkos/shared`        | `packages/shared/src/schemas.ts`                                          | `SystemStatusEventSchema.status` optional-string (landed in spec 245)               |
| `apps/server`           | `services/runtimes/claude-code/sdk-event-mapper.ts`                       | Forwards `status` conditionally (landed in spec 245)                                |
| `apps/client` (entity)  | `layers/entities/session/model/session-chat-store.ts`                     | `SessionState.systemStatus: string \| null` — extend to include structured status   |
| `apps/client` (feature) | `layers/features/chat/model/use-session-store-actions.ts`                 | `setSystemStatus(message: string \| null)` — extend signature or add sibling action |
| `apps/client` (feature) | `layers/features/chat/model/stream/stream-event-handler.ts:254-258`       | Currently discards `status` — must forward it                                       |
| `apps/client` (feature) | `layers/features/chat/model/use-chat-session.ts:40-55,225`                | Exposes `systemStatus` today — must add structured sibling                          |
| `apps/client` (feature) | `layers/features/chat/ui/ChatPanel.tsx:220-230`                           | Passes `systemStatus` into the strip — must pass structured sibling                 |
| `apps/client` (feature) | `layers/features/chat/ui/status/ChatStatusStrip.tsx`                      | `StripStateInput.systemStatus` & `deriveStripState` — extend                        |
| Test utility            | `apps/client/src/layers/features/chat/__tests__/ChatStatusStrip.test.tsx` | Existing test bed; add one conditional-branch test                                  |

React 19 + Motion (no change). No new library ids to resolve via Context7.

## 6) Detailed Design

### 6.1 Data model: `systemStatus` becomes a struct

The `SessionState.systemStatus` slot becomes a small tagged record instead of a bare string. This is the single source of churn; everything else downstream is a straight forward.

```ts
// packages/shared or client-local — choose client-local to avoid cross-package churn.
// apps/client/src/layers/features/chat/model/chat-types.ts (or a sibling)

/**
 * Per-session system-status payload surfaced on the chat store.
 *
 * `message` is the human-readable fallback used by the `system-message` rung's
 * renderer. `status` is the raw SDK discriminator (SDK 0.2.108+) used by the
 * renderer to pick status-aware copy. Both may be present independently.
 */
export interface SystemStatusState {
  /** Human-readable body. Always set when the record is non-null. */
  message: string;
  /** Raw SDK status value (e.g. `'requesting'`, `'compacting'`). Optional. */
  status: string | null;
}
```

`SessionState.systemStatus: SystemStatusState | null` replaces `string | null`.

### 6.2 Store action: `setSystemStatus` accepts the struct

The existing action has two callers (`setSystemStatus` direct, `setSystemStatusWithClear`). We widen the parameter type:

```ts
// apps/client/src/layers/features/chat/model/use-session-store-actions.ts

export interface SessionStoreActions {
  // ... unchanged siblings ...

  /** Writes systemStatus immediately. Pass `null` to clear. */
  setSystemStatus: (payload: SystemStatusState | null) => void;
  /** Writes systemStatus with auto-dismiss after SYSTEM_STATUS_DISMISS_MS. */
  setSystemStatusWithClear: (payload: SystemStatusState | null) => void;
}
```

All internal call sites are updated to pass `{ message, status }` or `null`.

### 6.3 Stream handler: forward `status` verbatim

One call site changes (`stream-event-handler.ts:254-258`):

```ts
case 'system_status': {
  const { message, status } = data as SystemStatusEvent;
  setSystemStatus({ message, status: status ?? null });
  break;
}
```

No other event handlers touch `systemStatus`, so this is the full wire-up. The `setSystemStatus(null)` call at line 381 (the `isRemapping` guard) stays as-is.

### 6.4 Prop drilling: `use-chat-session` → `ChatPanel` → `ChatStatusStrip`

- `use-chat-session.ts:51,226` returns `systemStatus: SystemStatusState | null` instead of `string | null`.
- `ChatPanel.tsx:220-230` passes the whole object through:
  ```tsx
  <ChatStatusStrip
    ...
    systemStatus={systemStatus}   // now SystemStatusState | null
  />
  ```
- `ChatStatusStripProps.systemStatus: SystemStatusState | null` (was `string | null`).

### 6.5 Renderer: one conditional branch

`deriveStripState` and `StripStateInput` accept the structured value. The `system-message` state gains one derived field:

```ts
// In ChatStatusStrip.tsx

/** Map raw SDK status → calm, deliberate copy. Unknown values return null. */
export function deriveStatusCopy(status: string | null | undefined): string | null {
  switch (status) {
    case 'requesting':
      return 'Thinking\u2026'; // "Thinking…"
    case 'compacting':
      return 'Compacting context\u2026';
    default:
      return null;
  }
}

export interface StripStateInput {
  // ... unchanged siblings ...
  systemStatus: SystemStatusState | null; // was: string | null
}

// ... inside deriveStripState ...

// Priority 3: System message (shown regardless of streaming status)
if (input.systemStatus) {
  const { message, status } = input.systemStatus;
  const copy = deriveStatusCopy(status) ?? message;
  return {
    type: 'system-message',
    message: copy,
    icon: deriveSystemIcon(copy), // icon still keyed on the final rendered string
  };
}
```

Key properties:

- **No state proliferation** — the existing `system-message` state is reused; only its `message` field is derived differently.
- **Icon logic is unchanged** — `deriveSystemIcon` still picks `RefreshCw` for "compacting context" (substring match hits), `Info` for "thinking" (default fallback).
- **Forward-compat is free** — an unknown future status value returns `null` from `deriveStatusCopy` and the `message` fallback kicks in.

### 6.6 End-to-end data flow

```
SDK (0.2.108+)
  │  msg.status = 'requesting' | 'compacting' | …
  ▼
server/sdk-event-mapper.ts
  │  emits { type: 'system_status', data: { message, status? } }
  ▼
SSE → client/stream-event-handler.ts
  │  setSystemStatus({ message, status: status ?? null })
  ▼
useSessionChatStore.sessions[sid].systemStatus  ← { message, status }
  │
  ▼
useChatSession → ChatPanel → ChatStatusStrip props
  │
  ▼
deriveStripState({ systemStatus, … })
  │  copy = deriveStatusCopy(status) ?? message
  ▼
<SystemMessageContent state={{ message: copy, icon }}/>
```

### 6.7 File touch list

| File                                                                        | Nature of change                                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/client/src/layers/entities/session/model/session-chat-store.ts`       | `SessionState.systemStatus` type + `DEFAULT_SESSION_STATE`                 |
| `apps/client/src/layers/features/chat/model/chat-types.ts`                  | Add `SystemStatusState` interface (or export from existing types module)   |
| `apps/client/src/layers/features/chat/model/use-session-store-actions.ts`   | Setter signature widens to `SystemStatusState \| null`                     |
| `apps/client/src/layers/features/chat/model/stream/stream-event-handler.ts` | Destructure `status`, pass struct to setter                                |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts`            | Return type of `systemStatus` widens                                       |
| `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`                     | Prop pass-through type changes                                             |
| `apps/client/src/layers/features/chat/ui/status/ChatStatusStrip.tsx`        | `StripStateInput.systemStatus` type, `deriveStatusCopy`, priority-3 branch |
| `apps/client/src/layers/features/chat/__tests__/ChatStatusStrip.test.tsx`   | One new test covering the `'requesting'` branch                            |

No server-side changes. No shared-package changes (the wire schema is already correct from spec 245).

## 7) User Experience

### 7.1 Visible behaviour

| SDK payload                                               | Today                                       | After this spec                              |
| --------------------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| `{ message: "Reading knowledge files…" }` (no status)     | "Reading knowledge files…" + `Info` icon    | "Reading knowledge files…" + `Info` icon     |
| `{ message: "Status: requesting", status: "requesting" }` | "Status: requesting" + `Info` icon          | "Thinking…" + `Info` icon                    |
| `{ message: "Compacting…", status: "compacting" }`        | "Compacting…" + `RefreshCw` icon            | "Compacting context…" + `RefreshCw` icon     |
| `{ message: "...", status: "tool_waiting" }` (future)     | "..." + whatever `deriveSystemIcon` returns | Identical to today — falls back to `message` |

### 7.2 Copy rationale

- **"Thinking…"** is calm, human, and matches one of the existing rotating verbs — so users who see both flavours experience consistency, not whiplash.
- **"Compacting context…"** is more specific than "Compacting…" and clarifies that no user-visible data is lost.
- Ellipsis (`\u2026`) matches the typographic convention used elsewhere in the strip (`verbInterval` copy, waiting state).

### 7.3 Motion & timing

No change. The existing crossfade between strip states already handles the transition from `streaming` → `system-message` → `streaming` gracefully. Status-aware copy lives _inside_ the `system-message` state, so the outer animation layer is untouched.

## 8) Testing Strategy

### 8.1 Unit test — `deriveStatusCopy` pure function

Co-locate with existing `ChatStatusStrip.test.tsx`:

```ts
describe('deriveStatusCopy', () => {
  it('returns "Thinking…" for requesting', () => {
    expect(deriveStatusCopy('requesting')).toBe('Thinking\u2026');
  });

  it('returns "Compacting context…" for compacting', () => {
    expect(deriveStatusCopy('compacting')).toBe('Compacting context\u2026');
  });

  it('returns null for unknown status (forward-compat)', () => {
    expect(deriveStatusCopy('tool_waiting')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(deriveStatusCopy(null)).toBeNull();
    expect(deriveStatusCopy(undefined)).toBeNull();
  });
});
```

Purpose: lock the mapping so a future SDK-copy change cannot silently regress it.

### 8.2 Unit test — `deriveStripState` with structured `systemStatus`

```ts
it('prefers derived status copy over raw message when status is known', () => {
  const state = deriveStripState({
    ...baseInput,
    systemStatus: { message: 'Status: requesting', status: 'requesting' },
  });
  expect(state.type).toBe('system-message');
  if (state.type === 'system-message') {
    expect(state.message).toBe('Thinking\u2026');
  }
});

it('falls back to raw message when status is unknown', () => {
  const state = deriveStripState({
    ...baseInput,
    systemStatus: { message: 'Reading knowledge files…', status: null },
  });
  expect(state.type).toBe('system-message');
  if (state.type === 'system-message') {
    expect(state.message).toBe('Reading knowledge files…');
  }
});
```

Purpose: verify the priority-3 branch honours `status` when known and does not regress the null-status path.

### 8.3 Component test — the required conditional-branch test

This is the test called out explicitly in the acceptance criteria:

```tsx
it("renders 'Thinking…' when systemStatus.status is 'requesting'", () => {
  render(
    <ChatStatusStrip
      status="streaming"
      streamStartTime={Date.now()}
      estimatedTokens={0}
      systemStatus={{ message: 'Status: requesting', status: 'requesting' }}
    />
  );
  expect(screen.getByTestId('chat-status-strip-system-message')).toHaveTextContent(
    'Thinking\u2026'
  );
});
```

Purpose: prove the structured value propagates through `deriveStripState` → `SystemMessageContent` → DOM.

### 8.4 Regression guard — existing test suite

The existing `ChatStatusStrip.test.tsx` test bed uses `systemStatus: null` in its `baseInput`. After the type widens, those tests continue to exercise the null path, which is exactly the "no regression when `status` is absent" acceptance criterion. Run the full `ChatStatusStrip.test.tsx` suite to confirm.

### 8.5 Stream-event-handler test

The existing `stream-event-handler-status.test.ts` suite tests the current string-only setter. Add one case that asserts the structured value is passed through:

```ts
it('forwards system_status.status into setSystemStatus payload', () => {
  // Arrange: mock setSystemStatus, fire a synthetic system_status event with status
  // Assert: setSystemStatus was called with { message, status: 'requesting' }
});
```

Purpose: catch a regression where the destructure loses the `status` field (the exact bug spec 245 prepared for).

### 8.6 Manual smoke

- Start a chat session against a live SDK ≥ 0.2.108.
- Watch the strip during the first turn: confirm "Thinking…" shows during `requesting` and "Compacting context…" shows when context fills.
- Simulate an older SDK (or relay agent) by mocking `status: undefined` in the transport; confirm no regression.

## 9) Performance Considerations

- Widening `SessionState.systemStatus` from `string | null` to an object of two strings adds ~O(1) memory per session. No allocation hot path is affected.
- `deriveStatusCopy` is an O(1) switch; it runs once per `deriveStripState` call, which is once per re-render of the strip. Re-renders are already bounded by Zustand selectors — no new subscriptions are added.
- No new motion primitives, network calls, or timers.

## 10) Security Considerations

- The `status` field is client-trusted, server-forwarded-from-SDK. It never crosses a trust boundary that `message` doesn't already cross.
- `deriveStatusCopy` is a pure closed-enum lookup — user/SDK strings cannot inject DOM or script content. `message` was already rendered as text, so the fallback path is unchanged.
- No PII surface area.

## 11) Documentation

- `contributing/design-system.md` — no change; the strip's calm-tech posture is unchanged.
- `contributing/state-management.md` — mention `SystemStatusState` under the Zustand store schema if the file enumerates `SessionState` fields (it does not today; no update needed).
- No external MDX docs (`apps/site/docs/`) reference the strip copy; no change.
- Update `specs/claude-agent-sdk-upgrade-0.2.112/04-implementation.md` "Deferred items" section to note that task 5.4 is now tracked here.

## 12) Implementation Phases

This is a single-PR change — no phasing. The order of file edits that keeps the tree compiling at each step:

1. **Type first** — add `SystemStatusState` to `chat-types.ts`. Export from a stable path.
2. **Store** — widen `SessionState.systemStatus` + `DEFAULT_SESSION_STATE`.
3. **Setter** — widen `use-session-store-actions.ts` signature. Compile errors guide the next steps.
4. **Stream handler** — destructure `status`, pass struct to setter.
5. **Hook pass-through** — `use-chat-session.ts` return type.
6. **Prop** — `ChatStatusStrip` + `ChatPanel` props.
7. **Derived copy** — `deriveStatusCopy` + `deriveStripState` branch.
8. **Tests** — add the unit + component tests described above.
9. **Verify** — `pnpm test`, `pnpm typecheck`, `pnpm lint`.

## 13) Open Questions

1. **Should rotating verbs ever run during `'requesting'`?** Arguably yes — "Thinking…", "Reasoning…", "Considering…" rotating every ~2s would feel more alive than a static "Thinking…". Out of scope here; filed as a future UX iteration. The decision to keep it static for now is conservative: static copy is the minimum-viable differentiation.
2. **Where should `SystemStatusState` live — `chat-types.ts` (feature) or `@dorkos/shared`?** Both work. Feature-local keeps the blast radius small and matches the fact that only the client surfaces this distinction. Proposed: feature-local; promote to shared only when a second consumer appears.
3. **Forward-compat: should we log unknown `status` values to `console.warn` during development so SDK additions surface quickly?** Probably yes, dev-only. Decide during implementation; one-line addition.

## 14) Related ADRs

- None directly constrain this spec. The broader "strip as single status container" posture is described in `specs/unified-status-strip/` and implicitly honoured by not adding new state-machine states.

## 15) References

- Spec 245 — `specs/claude-agent-sdk-upgrade-0.2.112/02-specification.md`, §5.4 (original "status-aware loading affordance" task, marked optional/deferred).
- Spec 245 implementation notes — `specs/claude-agent-sdk-upgrade-0.2.112/04-implementation.md` (Phase 5 backend plumbing: schema, mapper, fallback message synthesis).
- Spec 247 — `specs/terminal-reason-chip/02-specification.md` (sibling follow-up spec; same "landed the signal, render the pixels" pattern).
- Source files:
  - `packages/shared/src/schemas.ts:581-592` — `SystemStatusEventSchema`.
  - `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts:115-128` — server mapper.
  - `apps/client/src/layers/features/chat/model/stream/stream-event-handler.ts:254-258` — client consumer.
  - `apps/client/src/layers/features/chat/ui/status/ChatStatusStrip.tsx` — renderer.
- Claude Agent SDK 0.2.108+ — `SDKStatus` type (`'requesting' | 'compacting' | null`).
