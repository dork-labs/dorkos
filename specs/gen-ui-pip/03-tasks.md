# Tasks: Live gen-UI widgets in PIP — play tic-tac-toe while you work

Spec: `specs/gen-ui-pip/02-specification.md`
Slug: `gen-ui-pip`
Generated: 2026-07-11T17:58:04-05:00
Mode: full

One PR; phases are ordering, not separate PRs.

## Phase 1 — Liveness plumbing

### Task 1.1: Add a pinned background session slot to StreamManager

- **Priority:** high · **Size:** large · **Dependencies:** none · **Parallel with:** 1.2, 2.1

Give `StreamManager` (`apps/client/src/layers/shared/lib/transport/stream-manager.ts`) a second, independently-liveable session connection so a PIP'd session keeps streaming even after the operator switches the active session elsewhere. This is the risk-concentration piece of the feature and must land first, on its own.

Add three private fields alongside the existing `sessionConnection`/`attachedSessionId`/`attachedCwd` (lines 190-192):

```ts
private pinnedSessionId: string | null = null;
private pinnedCwd: string | null = null;
private pinnedConnection: SSEConnectionLike | null = null;
```

**Invariant to hold at all times:** when `pinnedSessionId === attachedSessionId`, the two "slots" share the ACTIVE connection and `pinnedConnection` is `null` (exactly one owner per `SSEConnectionLike`, never two references to the same connection). `pinnedConnection` is non-null ONLY while the pinned session differs from the attached one.

Add this public API, TSDoc'd like the surrounding methods:

- `pinSession(sessionId: string, cwd?: string | null): void` — idempotent: re-pinning the SAME `sessionId` is a no-op (mirrors `attachSession`'s idempotency guard at lines 450-455, which stays unchanged). If `sessionId === this.attachedSessionId`: record the pin as shared (`this.pinnedSessionId = sessionId; this.pinnedCwd = cwd ?? null; this.pinnedConnection = null`) — no new connection opens. Otherwise open a fresh connection via the existing `this.openSessionStream(sessionId, cwd ?? null)` (same private helper `attachSession` already uses, lines 469-487) and `.connect()` it, storing it as `pinnedConnection`. If a DIFFERENT session was already pinned, unpin it first via `unpinSession()` before pinning the new one (single-instance panel → single pin, mirrors row 5 of the transition table below).
- `unpinSession(): void` — if `pinnedConnection` is non-null, `.destroy()` it and null it out; always clear `pinnedSessionId`/`pinnedCwd` to `null`. Never touches `sessionConnection`/`attachedSessionId` (the shared case leaves the active connection alone — the pinned slot was never its own connection to begin with).
- `getPinnedSessionId(): string | null` — returns `this.pinnedSessionId`, symmetric with the existing `getAttachedSessionId()` (lines 245-248).

**Rework `attachSession` (lines 448-466) to respect the pin.** Its current body destroys the outgoing active connection unconditionally via `closeSessionStream()`. That must now branch on whether the outgoing connection can be TRANSFERRED into the pinned slot instead of destroyed, and whether the new target is itself the currently (separately) pinned session and can ADOPT that connection instead of opening a duplicate. Transfers move the `SSEConnectionLike` reference between the two private fields without ever calling `.close()`/`.connect()`/`.destroy()` on it — the connection object is session-bound, so re-targeting which field holds it is pure bookkeeping. This is the same avoid-flicker principle as the existing "single-transition rule" comment at lines 418-420 (`setSource`'s reattach path), applied to the pin/attach boundary instead of the source-switch boundary.

Every row of this transition table needs its own dedicated unit test — this is the exact contract, not a paraphrase:

| Current state                          | Event                                          | Result                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| pinned A, attached A (shared)          | `attachSession(B)`                             | The active connection is transferred to the pinned slot (no close/reopen, zero gap), then a fresh active connection opens for B                    |
| pinned A, attached B (own pinned conn) | `attachSession(A)`                             | The pinned connection is transferred to the active slot (adopted), `pinnedConnection` becomes `null` (shared again); no duplicate connection opens |
| pinned A, attached B                   | `attachSession(C)`                             | Normal active re-target B→C; pinned connection untouched                                                                                           |
| pinned A (any)                         | `unpinSession()`                               | Own pinned connection closed if present; shared case leaves the active connection alone                                                            |
| pinned A, attached B                   | `pinSession(C)`                                | Unpin A (close its connection), then pin C per `pinSession` rules                                                                                  |
| any pinned state                       | transport rebuild (`setSource`, lines 401-431) | The rebuild path must also rebuild the pinned connection, mirroring its active-session reattach logic; pin state survives the rebuild              |

`closeSessionStream()` (the existing private helper, lines 494-499) must only run when the outgoing active connection is NEITHER shared-with-the-pin NOR transferable into the pin — i.e. exactly the third table row's case (normal re-target with an unrelated or absent pin) and the ordinary no-pin path every existing `attachSession` test already covers.

**Rework `setSource` (lines 401-431) for the sixth table row.** Before it calls `this.closeSessionStream()`, capture whether the pin currently holds ITS OWN connection (`pinnedSessionId !== null && pinnedConnection !== null`) — the shared case needs no separate handling because the active-session reattach already re-establishes it as shared. If the pin has its own connection, destroy and null it out at the same point `closeSessionStream()` tears down the active one, then after the active reattach block (lines 426-429) re-open a fresh `pinnedConnection` for the captured pinned session id/cwd via `openSessionStream` + `.connect()`. Pin state (`pinnedSessionId`/`pinnedCwd`) itself is never cleared by a source switch — only the connection object is rebuilt.

Unit tests in `apps/client/src/layers/shared/lib/transport/__tests__/stream-manager.test.ts`, following the existing `FakeConnection`/`setup()` fixture pattern already in that file (a fake connection factory recording every constructed connection, `connect`/`destroy` as `vi.fn()`s so identity and call-count are assertable):

- Every row of the transition table above, asserting BOTH the resulting `getAttachedSessionId()`/`getPinnedSessionId()` state AND that `destroy()`/`connect()` were called (or NOT called) on the exact connection objects the row implies — in particular, the two transfer rows must assert `destroy()` was NEVER called on the transferred connection (identity preserved, not recreated).
- No duplicate connection opens when `pinSession` is called for the session that is already the attached one (assert `connections` array length).
- Unpinning a SHARED pin (pinned === attached) leaves the active connection's `destroy()` uncalled and `getAttachedSessionId()` unchanged.
- A transport-rebuild (`useHttpSource`/`useTransportSource` called a second time with a different source) with both an attached AND a differently-pinned session restores both slots as two connections against the new source.

### Task 1.2: Add an LRU eviction pin to the stream store

- **Priority:** high · **Size:** small · **Dependencies:** none · **Parallel with:** 1.1, 2.1

An idle PIP'd session must never be evicted from `useSessionStreamStore` while it is popped out, or its projection (and the widget board it's showing) disappears even though `StreamManager` is still streaming it live. This task adds the eviction guard; task 1.1 adds the stream-liveness guard — they are set together by the same lifecycle (task 2.2).

In `apps/client/src/layers/entities/session/model/session-stream-store.ts`:

- Add `pinnedSessionId: string | null` to `SessionStreamStoreState` (alongside the existing `sessions`/`sessionAccessOrder` fields, ~line 202), initialized to `null` in the store creator (~line 452, next to `sessions: {}, sessionAccessOrder: [],`).
- Add to `SessionStreamActions`: `setPinnedSession: (sessionId: string | null) => void;` with a TSDoc note that this is set/cleared by the SAME lifecycle that calls `streamManager.pinSession()`/`unpinSession()` (task 2.2's `LiveSessionWidget`), so store retention and stream liveness always agree — never call one without the other.
- Implement it as a plain `set()` action (no immer producer needed for a scalar field, but stay consistent with the file's existing `set((state) => {...}, false, 'session-stream/actionName')` triple-argument devtools-labeled style): `setPinnedSession: (sessionId) => set((state) => { state.pinnedSessionId = sessionId; }, false, 'session-stream/setPinnedSession'),`
- Update `touchAndGet` (lines 300-313): the eviction loop currently deletes an over-limit entry when `state.sessions[id].inProgressTurn.length === 0`. Add `&& id !== state.pinnedSessionId` to that condition so the pinned session survives eviction regardless of its `inProgressTurn` state — a pinned session showing a completed (non-streaming) widget board is exactly the idle-but-must-not-evict case this exists for.

Unit tests in `apps/client/src/layers/entities/session/model/__tests__/session-stream-store.test.ts` (extend the existing file — do not create a second test file for this store):

- Seed 21+ idle sessions (no `inProgressTurn`) via `applySnapshot` or `ensureSession` + `applyEvent` to populate `sessionAccessOrder` past `MAX_RETAINED_SESSIONS` (20), call `setPinnedSession` on the OLDEST one (the one `touchAndGet`'s LRU would otherwise evict first), then trigger a `touchAndGet` pass (e.g. via `applyEvent` on a 22nd session) and assert the pinned session's entry still exists in `sessions` and its id still appears in `sessionAccessOrder`.
- Calling `setPinnedSession(null)` after the above makes that same session evictable again on the next over-limit `touchAndGet` pass — assert it is gone after one more session is added past the limit.
- `setPinnedSession` updates `useSessionStreamStore.getState().pinnedSessionId` to the given id, and to `null` when cleared.

## Phase 2 — The live view

### Task 2.1: Add the findLatestWidgetFence pure scanner

- **Priority:** high · **Size:** medium · **Dependencies:** none · **Parallel with:** 1.1, 1.2

Add a pure function that scans a session's projected stream state for its newest `dorkos-ui` widget fence, so the PIP view (task 2.2) can render "whatever board the agent posted most recently" without duplicating the chat feature's message-array composition logic.

**Why this can't just call into `features/chat`:** `apps/client/src/layers/features/chat/model/stream/project-session-turn.ts`'s `projectSessionMessages()` already builds the exact `ChatMessage[]` `MessageList` renders (completed history + optimistic user message + a folded in-progress assistant bubble), but `.claude/rules/fsd-layers.md` forbids a feature's model/lib code from importing another feature's model code (`gen-ui` importing from `features/chat/model/*` is exactly the forbidden case — UI composition across features is allowed, model/hook cross-imports are not). So this task re-derives, LOCALLY inside `gen-ui`, the minimal slice of that same composition gen-ui actually needs: an ordered list of raw message text to scan for fences, ending in the same "what counts as the newest message" answer `MessageList.tsx:153`'s positional rule (`virtualRow.index === messages.length - 1`) gives.

New file `apps/client/src/layers/features/gen-ui/lib/find-latest-widget-fence.ts`:

````ts
import type { SessionStreamState } from '@/layers/entities/session';

/** The newest ` ```dorkos-ui ` fence found in a session's projected message stream. */
export interface LatestWidgetFence {
  /** The fence's raw body (not yet parsed — feed to WidgetFence, which owns parsing). */
  code: string;
  /** True when the fence has no closing delimiter yet (still streaming open). */
  isIncomplete: boolean;
  /** Stable identifier of the message the fence came from (for keying/testing). */
  sourceMessageKey: string;
  /** True when the source message is the newest message in the session's projection. */
  isLatest: boolean;
  /** True when the source message is the trailing in-progress (still-streaming) turn. */
  isStreaming: boolean;
}

export function findLatestWidgetFence(state: SessionStreamState): LatestWidgetFence | null {
  /* ... */
}
````

Algorithm:

1. Build an ordered list of `{ key: string; content: string; isStreaming: boolean }` virtual messages, OLDEST FIRST, mirroring `projectSessionMessages`'s ordering without importing it:
   - Every entry of `state.messages` (`HistoryMessage[]`), in order: `{ key: m.id, content: m.content, isStreaming: false }`. `HistoryMessage.content` (`packages/shared/src/schemas.ts` `HistoryMessageSchema`) is the raw markdown source — the same text `StreamingText`/streamdown parses `dorkos-ui` fences out of, so a plain substring/regex scan over it is correct.
   - If `state.optimisticUserMessage` is non-null, append `{ key: '__optimistic_user__', content: optimisticUserMessage.content, isStreaming: false }` (a user message never carries a widget fence, but it still occupies the newest-message SLOT the same way it does in `MessageList`'s array — so its presence can supersede an earlier assistant board, exactly like the live transcript).
   - If `state.inProgressTurn` contains any `text_delta` events, concatenate their `.text` fields in seq order into one string; if that concatenation is non-empty, append `{ key: '__in_progress_turn__', content: concatenatedText, isStreaming: true }`. These two synthetic keys deliberately mirror (without importing) the `OPTIMISTIC_USER_ID`/`IN_PROGRESS_ASSISTANT_ID` constants in `project-session-turn.ts` — same concept, independently re-derived per the FSD constraint above.
2. Scan the list NEWEST FIRST (reverse iteration). For the first virtual message whose `content` contains the literal marker ` ```dorkos-ui ` (any fence-language marker match is enough — do not require a full markdown parse), stop scanning further (older) messages — "newest-message-wins", even if an older message also has a fence.
3. Within that one message, find the LAST occurrence of a ` ```dorkos-ui ` fence (a single message can contain more than one; take the last). Extract its body: everything after the marker's line up to the next line that is exactly a closing ` ``` ` fence, or end-of-string if no closing fence follows (`isIncomplete: true` in that case, `false` otherwise).
4. Return `{ code, isIncomplete, sourceMessageKey: <that message's key>, isLatest: <that message is the LAST entry in the full ordered list>, isStreaming: <that message's key === '__in_progress_turn__'> }`. Return `null` if no virtual message contains the marker at all.

Unit tests at `apps/client/src/layers/features/gen-ui/__tests__/find-latest-widget-fence.test.ts` (pure function, no React, no store — plain `describe`/`it` with hand-built `SessionStreamState` fixtures, extending `DEFAULT_SESSION_STREAM_STATE` from `entities/session`):

- Newest-message-wins: two completed messages both carry a fence; the function returns the LATER message's fence, ignoring the earlier one, with `isLatest: true`.
- An older completed message carries a fence, but the newest virtual message (e.g. a later completed message, or the optimistic user message) has none: the function still returns the older fence but with `isLatest: false` (superseded — this is what feeds `isLatestMessage={false}` into `WidgetFence`).
- Last-fence-within-message: a single message's content contains two ` ```dorkos-ui ` fences; the function returns the SECOND one's body.
- Streaming/incomplete: `inProgressTurn` carries `text_delta` events whose concatenated text contains an OPENED but not yet closed ` ```dorkos-ui ` fence; the function returns `{ isIncomplete: true, isStreaming: true, isLatest: true }`.
- No fences anywhere (empty `messages`, no optimistic message, no in-progress text): returns `null`.
- A `state.messages` entry AFTER the one with a fence but with no fence of its own, and no optimistic/in-progress content, correctly supersedes it (`isLatest: false`) — proves the positional rule counts every virtual message, not just fence-bearing ones.

Barrel export: add `export { findLatestWidgetFence, type LatestWidgetFence } from './lib/find-latest-widget-fence';` to `apps/client/src/layers/features/gen-ui/index.ts`.

### Task 2.2: Build LiveSessionWidget: the pinned, follow-the-latest board

- **Priority:** high · **Size:** large · **Dependencies:** 1.1, 1.2, 2.1 · **Parallel with:** none

Build the component the PIP panel will render for a popped-out widget: it pins the session's stream (task 1.1) and store retention (task 1.2) for its lifetime, subscribes to the projection, and renders whatever `find-latest-widget-fence` (task 2.1) says is the newest board through the UNCHANGED `WidgetFence` pipeline — so PIP interactivity is byte-for-byte the inline behavior, never a fork.

New file `apps/client/src/layers/features/gen-ui/ui/LiveSessionWidget.tsx`:

```tsx
export interface LiveSessionWidgetProps {
  /** The session whose newest widget-bearing message this view follows. */
  sessionId: string;
}

export function LiveSessionWidget({ sessionId }: LiveSessionWidgetProps): React.ReactNode;
```

**Lifecycle effect** (on mount and whenever `sessionId` changes, cleaning up on unmount/change):

```ts
useEffect(() => {
  const sessions = useSessionListStore.getState().sessions;
  const cwd =
    sessions[sessionId]?.cwd ?? useSessionListStore.getState().statusCwds[sessionId] ?? null;
  streamManager.pinSession(sessionId, cwd);
  useSessionStreamStore.getState().setPinnedSession(sessionId);
  return () => {
    streamManager.unpinSession();
    useSessionStreamStore.getState().setPinnedSession(null);
  };
}, [sessionId]);
```

`streamManager` is the shared singleton import (`@/layers/shared/lib`, or the deep transport path already used elsewhere — match the existing import style other `entities/session` binding code uses for it). The cwd lookup order (`sessions[id].cwd` first, `statusCwds[id]` fallback, `null` last) resolves the spec's open question about where the pinned session's cwd comes from: `SessionStreamState` itself carries no `cwd` field, but `useSessionListStore`'s `sessions: Record<string, Session>` (metadata from `session_upserted`) and `statusCwds: Record<string, string>` (from `session_status.cwd`, populated even for sessions whose metadata was never fetched) both do — try metadata first since it's the more complete source, fall back to the status-derived cwd, and pin with `null` (default cwd) only if neither is known yet. Both stores are importable from the `entities/session` barrel (legal same-layer dependency for a `features/` component).

**Subscribe:** `const state = useSessionStreamState(sessionId);` (feature → entity, legal per FSD).

**Find the fence:** `const fence = useMemo(() => findLatestWidgetFence(state), [state]);` using task 2.1's function — DO NOT re-implement `isLatestMessage` derivation separately; `fence.isLatest` already IS that re-derivation (ideation decision D4), computed once inside the pure scanner against the exact same positional rule `MessageList.tsx:153` uses.

**Render:**

- `fence === null`: a quiet empty state, matching `DemoPipContent`'s placeholder styling (`apps/client/src/layers/features/pip-panel/ui/DemoPipContent.tsx`): `<div className="text-muted-foreground flex h-full items-center justify-center p-4 text-center text-sm">No live widget in this session</div>`. This is reachable if the panel is open when a session's history is cleared or the operator pins a session with no widgets.
- `fence !== null`: `<WidgetFence code={fence.code} isIncomplete={fence.isIncomplete} sessionId={sessionId} isLatestMessage={fence.isLatest} isStreaming={fence.isStreaming} />`, imported via the existing relative sibling import `./WidgetFence` (same feature, same convention `WidgetRenderer.tsx` already uses for `./WidgetNodeView`). `WidgetFence` keeps owning its own forward-only document latching (ideation D8) — this component never parses widget JSON itself.

**Component identity:** `LiveSessionWidget` is declared at module scope (a normal named export, not created inside another component's render), so it is safe for `PipHost`'s renderer map (task 3.1) to reference directly without the `StreamingText.tsx:40-49` remount hazard — no inline closures inside this file wrap `WidgetFence` either.

Barrel export: add `export { LiveSessionWidget, type LiveSessionWidgetProps } from './ui/LiveSessionWidget';` to `apps/client/src/layers/features/gen-ui/index.ts`.

Component tests at `apps/client/src/layers/features/gen-ui/__tests__/LiveSessionWidget.test.tsx` (real `useSessionStreamStore`/`useSessionListStore` — reset both in `beforeEach` via `setState` to their empty defaults; wrap in `TransportProvider` with `createMockTransport()` per `.claude/rules/testing.md`):

- Renders the latest board: seed a session's `messages` with a completed assistant message containing a `dorkos-ui` board fence, render `<LiveSessionWidget sessionId="s1" />`, assert the board's cells render.
- Appending a NEWER widget message swaps the rendered document: after the above, call `applySnapshot`/`applyEvent` (or directly `setHistoryMessages`) to add a second, different board as the newest message; assert the rendered board reflects the new one (follow-the-live-game).
- Appending a non-widget message flips to superseded: after a widget message renders live (`isLatestMessage: true`), append a plain-text assistant (or optimistic user) message as the newest; assert the widget's `agent`-kind action controls become inert (parity with the inline supersede rule — check via `useAgentActionState`-driven disabled affordance the same way `WidgetFence.test.tsx`/`widget-context-latch.test.tsx` already assert it, e.g. a disabled/inert board cell).
- A `ui`-kind action still runs locally even off-route (dispatch does not require the transport).
- An `agent`-kind action dispatches via the mock transport with `sessionId` matching the prop, and posts the optimistic `<ui_action>` message into `useSessionStreamStore` for that same session id (assert via `useSessionStreamStore.getState().getSession('s1').optimisticUserMessage`).
- Pin/unpin lifecycle: `vi.spyOn(streamManager, 'pinSession')` and `vi.spyOn(streamManager, 'unpinSession')` before mount; assert `pinSession` fired once on mount with the right `sessionId`, and `unpinSession` fired once on unmount (RTL's `unmount()`). Also assert `useSessionStreamStore.getState().pinnedSessionId` is set on mount and cleared (`null`) after unmount.
- Empty state renders without crashing for a session with no seeded state at all (default/unknown session id).

## Phase 3 — Wiring + polish

### Task 3.1: Wire the widget PipContent kind into PipHost

- **Priority:** high · **Size:** medium · **Dependencies:** 2.2 · **Parallel with:** none

Add the third and final v1 `PipContent` kind and route it to `LiveSessionWidget` (task 2.2), completing the compile-time exhaustiveness contract `PipHost`'s `never` guard exists to enforce.

In `apps/client/src/layers/shared/model/app-store/app-store-pip.ts`:

- Extend the `PipContent` union (currently `{ kind: 'demo'; title: string } | { kind: 'mcp_app'; sessionId: string; serverName: string; uri: string; title: string }`) with a third member: `| { kind: 'widget'; sessionId: string; title: string }`.
- Update the module TSDoc comment above the union, which currently says "DOR-298 will add `{ kind: 'widget'; sessionId; ... }`" — replace that forward-reference sentence with a description of what the `widget` kind actually carries now that it exists (a session-bound live view, following `mcp_app`'s existing comment style for how it documents what its own fields are for).

In `apps/client/src/layers/features/pip-panel/ui/PipHost.tsx`:

- Import `{ LiveSessionWidget }` from `@/layers/features/gen-ui` (legal cross-feature UI composition per `.claude/rules/fsd-layers.md` — `pip-panel` rendering a sibling feature's component, the same relationship it already has with `McpAppFrame` from `@/layers/features/mcp-apps`).
- Add a `widget` entry to the module-scope `PIP_RENDERERS` map (lines 22-28) — keep it module-scope for the same remount-hazard reason the file's own comment already documents for `demo`/`mcp_app`:

  ```tsx
  const PIP_RENDERERS: {
    demo: React.ComponentType<{ content: Extract<PipContent, { kind: 'demo' }> }>;
    mcp_app: React.ComponentType<{ content: Extract<PipContent, { kind: 'mcp_app' }> }>;
    widget: React.ComponentType<{ content: Extract<PipContent, { kind: 'widget' }> }>;
  } = {
    demo: DemoPipContent,
    mcp_app: McpAppPipContent,
    widget: WidgetPipContent,
  };
  ```

- Add the adapter, module-scope like `McpAppPipContent` (lines 39-49) immediately above/below it:

  ```tsx
  function WidgetPipContent({ content }: { content: Extract<PipContent, { kind: 'widget' }> }) {
    return <LiveSessionWidget sessionId={content.sessionId} />;
  }
  ```

- Add the `case 'widget'` branch to `renderPipContent`'s switch (lines 67-85), following the existing `case 'mcp_app'` shape exactly (`const Renderer = PIP_RENDERERS.widget; return <Renderer content={content} />;`). Before this task, the switch's `default: { const _exhaustive: never = content; ... }` branch is a compile error waiting to happen the moment the union grows — adding this case is what makes the build green again; do not touch the `default` branch itself.
- No `onRestore` wiring for `widget` — the existing comment above `<FloatingPanel>` in `PipHost` (lines 153-157) already explains why every v1 kind omits it; no code change needed there, but read it so the omission isn't accidentally "fixed" by a well-meaning diff.

Tests: extend `apps/client/src/layers/features/pip-panel/__tests__/PipHost.test.tsx`. Add a mock for the gen-ui barrel alongside the existing `vi.mock('@/layers/features/mcp-apps', ...)` block (same shallow-stub pattern — this suite verifies ROUTING, not `LiveSessionWidget`'s own behavior, which has its own suite in task 2.2):

```tsx
vi.mock('@/layers/features/gen-ui', () => ({
  LiveSessionWidget: (props: { sessionId: string }) => (
    <div data-testid="live-session-widget" data-session={props.sessionId} />
  ),
}));
```

New test cases, following the existing `mcp_app` routing test's shape:

- `openPip({ kind: 'widget', sessionId: 's1', title: 'Tic-Tac-Toe' })` renders `LiveSessionWidget` with `data-session="s1"`, and the panel title shows `'Tic-Tac-Toe'`.
- The renderer-identity-stability test already covering `demo` (lines 248-281) gets a `widget`-kind counterpart (or is parameterized to cover all three kinds): force an unrelated parent re-render while a `widget` PIP is open and assert `LiveSessionWidget` does not remount (mount effect fires exactly once) — same technique, applied to the new kind.

### Task 3.2: Add the pop-out affordance to widget fences

- **Priority:** high · **Size:** medium · **Dependencies:** 3.1 · **Parallel with:** none

Add the entry point: a desktop-only pop-out button on a rendered widget fence in the transcript that calls `openPip({ kind: 'widget', ... })`, giving the operator the one gesture the whole feature exists for ("play tic-tac-toe in the floating panel"). Popping out never removes or alters the inline widget — it stays live in the transcript exactly as before (dual-live instances, ideation D5).

In `apps/client/src/layers/features/gen-ui/ui/WidgetFence.tsx`, the SUCCESS render branch only (the `return` at lines 76-86, where `lastDocRef.current` is a validated `WidgetDocument` — the skeleton and error-card branches get no pop-out control, since there is nothing valid to pop out yet):

- Import `PictureInPicture2` from `lucide-react` and `useAppStore`, `useIsMobile` from `@/layers/shared/model` (the same imports `apps/client/src/layers/features/mcp-apps/ui/McpAppBlock.tsx` already uses for its own pop-out button — mirror that file's button markup/sizing/aria pattern, since D6 explicitly calls for visual consistency with the DOR-297 affordance).
- `WidgetFence` currently has no persistent header chrome to place a button in (unlike `McpAppBlock`, which has one) — its success branch is a bare `<div className="my-2"><WidgetRenderer ... /></div>`. Change that wrapper to a hover-revealed overlay: give the wrapper `relative group` classes, and add a sibling `<button>` INSIDE that wrapper but OUTSIDE (a sibling of, not a descendant of) the `<WidgetRenderer>` tree it sits next to — positioned `absolute right-1 top-1` (or equivalent corner placement that does not overlap interactive widget content), `opacity-0 group-hover:opacity-100 transition-opacity`, so it never intercepts clicks meant for the widget itself and is not permanently visible clutter.
- Render the button only when `sessionId` is present AND `!isMobile` (the mobile guard mirrors `McpAppBlock`'s own `{!isMobile && (...)}` guard — below 768px the PIP host renders nothing, so the affordance would be a dead click).
- Button contents/attributes, matching `McpAppBlock.tsx` lines 91-100 exactly in spirit: `type="button"`, `aria-label="Pop out into a floating window"`, a `title="Pop out"` tooltip, `<PictureInPicture2 className="size-3.5" />`, `text-muted-foreground hover:bg-muted hover:text-foreground rounded-md p-1 transition-colors` (adapt to sit correctly on the floating overlay background — add a small `bg-background/80 backdrop-blur-sm` or similar so the icon stays legible over arbitrary widget content beneath it, since unlike `McpAppBlock`'s solid header bar this button floats directly over the widget).
- `onClick`: `useAppStore((s) => s.openPip)` then `openPip({ kind: 'widget', sessionId, title: lastDocRef.current?.title ?? 'Widget' })` — read the document's `title` field (same field `WidgetRenderer`'s `aria-label` already uses) with the same `?? 'Widget'` fallback pattern `McpAppBlock` uses for its own title fallback.

Component tests: extend `apps/client/src/layers/features/gen-ui/__tests__/WidgetFence.test.tsx`. Add a `vi.mock('@/layers/shared/model', ...)` override for `useIsMobile` following `PipHost.test.tsx`'s exact pattern (spread the real module, override just `useIsMobile`), and pass a real `sessionId` prop where needed:

- The pop-out button is present when the fence renders a parsed document AND a `sessionId` prop is given.
- The pop-out button is ABSENT when `sessionId` is omitted, even with a parsed document (no valid `openPip` target).
- The pop-out button is ABSENT when `useIsMobile()` returns `true`.
- Clicking it calls the real store's `openPip` (spy via `vi.spyOn(useAppStore.getState(), 'openPip')` before render) with `{ kind: 'widget', sessionId: <the prop>, title: <the document's title or 'Widget'> }`.
- Clicking the pop-out button on a widget that also has an interactive `agent`-kind control (e.g. render a `board` fence with a cell action) does NOT dispatch that widget action — assert `mockTransport.sendUiAction` (from `createMockTransport()`) was never called after the click, proving the button's placement outside the interactive subtree actually holds.

### Task 3.3: Write the changelog fragment and the docs sentence

- **Priority:** medium · **Size:** small · **Dependencies:** 3.1, 3.2 · **Parallel with:** none

Document the headline of the PIP trio (DOR-296 primitive, DOR-297 MCP apps, DOR-298 this feature) for end users, and clean up any auto-generated changelog noise this branch's commits produced along the way.

**Changelog fragment.** Mint a FRESH `YYMMDD-HHMMSS` id by running the id script (`.claude/scripts/id.ts`, e.g. `node --experimental-strip-types .claude/scripts/id.ts` or however this repo's other changelog-writing flows invoke it) at write time — do NOT reuse this spec's own id (`260711-175135`) or any id already present in `changelog/unreleased/`. Create `changelog/unreleased/<fresh-id>-live-widgets-in-pip.md` with no YAML frontmatter, following the exact shape of `changelog/unreleased/260711-105140-marketplace-symlink-containment.md`: a single `### Added` heading, then one bullet ending in `(DOR-298)`. Write the bullet per the `writing-for-humans` skill: plain language, no em dashes, describing the outcome for the operator (popping a live board like tic-tac-toe out of the transcript into the floating panel, where it keeps playing even while they switch sessions or navigate elsewhere) rather than any internal mechanism (never mention `StreamManager`, pinning, or SSE connections in the user-facing bullet).

**Auto-stub cleanup.** This repo's post-commit hook auto-generates a stub changelog fragment for every commit whose message starts with `feat(` (see `project_changelog_populator_gotcha` — PR #232 made this replay-safe but it still fires per matching commit). Working through this spec's several `feat(...)` commits will likely leave multiple auto-stub files under `changelog/unreleased/` for this branch. Before opening the PR: run `git diff --name-only origin/main...HEAD -- changelog/unreleased/` to list every changelog file this branch added, delete every auto-generated stub among them, and keep EXACTLY ONE real, hand-written fragment (the one this task authored) describing the whole feature — not one fragment per commit.

**Docs check.** `docs/guides/generative-ui.mdx` already exists and covers widget interactivity (its `## Widgets Talk Back` section, lines 46-50, currently ends right before `## Canvas` at line 52) — this IS a gen-UI/widgets doc page, so add the pop-out sentence there; do not skip. Add one short sentence after the existing two paragraphs in `## Widgets Talk Back` (before the `## Canvas` heading), in the same plain-language register as the surrounding prose (no em dashes, no jargon, benefit before mechanism — e.g. describing that an interactive board can be popped into a small floating window that stays visible while the operator works elsewhere, and that the transcript keeps its own copy too). Do not invent a new heading or `<Callout>` for this — one sentence in the existing section is enough. If, contrary to the check above, this page did not already cover widgets, the correct action would be to skip the docs edit silently — that branch does not apply here since the page exists.

### Task 3.4: Full verify, TSDoc/no-TODO sweep, and live proof

- **Priority:** high · **Size:** medium · **Dependencies:** 1.1, 1.2, 2.1, 2.2, 3.1, 3.2, 3.3 · **Parallel with:** none

Close out the PR: run the complete verification loop, sweep for lingering rough edges across every file this spec touched, and produce the live-proof evidence the spec's Testing Strategy calls for.

**Targeted test files** (run these directly before the full suite, per `.claude/rules/conventions.md`'s targeted-verification guidance):

```
pnpm vitest run \
  apps/client/src/layers/shared/lib/transport/__tests__/stream-manager.test.ts \
  apps/client/src/layers/entities/session/model/__tests__/session-stream-store.test.ts \
  apps/client/src/layers/features/gen-ui/__tests__/find-latest-widget-fence.test.ts \
  apps/client/src/layers/features/gen-ui/__tests__/LiveSessionWidget.test.tsx \
  apps/client/src/layers/features/gen-ui/__tests__/WidgetFence.test.tsx \
  apps/client/src/layers/features/pip-panel/__tests__/PipHost.test.tsx
```

Fix anything red before moving on.

**Package-scoped checks:**

```
pnpm --filter @dorkos/client typecheck
pnpm --filter @dorkos/client lint
```

**Full loop-closer:** `pnpm verify` (affected-only typecheck + lint + test). If a broader full-suite run is needed to be sure nothing outside the client package regressed, use `pnpm test -- --run` — never a bare `pnpm vitest run` for a full run, which falsely fails two unrelated tests in this dev environment (AGENTS.md Commands section).

**TSDoc/no-TODO sweep** across every file this spec touched (`stream-manager.ts`, `session-stream-store.ts`, `find-latest-widget-fence.ts`, `LiveSessionWidget.tsx`, `app-store-pip.ts`, `PipHost.tsx`, `WidgetFence.tsx`, the `gen-ui`/`pip-panel` barrels): confirm every new exported function/type/component carries TSDoc (`eslint-plugin-jsdoc` enforces this on exports, but re-check by eye for the `@param`/return-behavior quality bar the rest of these files hold, not just presence), and `grep -rn "TODO\|FIXME\|XXX" apps/client/src/layers/shared/lib/transport/stream-manager.ts apps/client/src/layers/entities/session/model/session-stream-store.ts apps/client/src/layers/features/gen-ui apps/client/src/layers/features/pip-panel apps/client/src/layers/shared/model/app-store/app-store-pip.ts` returns nothing.

**Live proof (the spec's own acceptance bar):** in the dogfood cockpit (`pnpm dev:dogfood`), start (or resume) a real Claude Code session, get the agent to render a tic-tac-toe `board` widget, pop it out via the new affordance, play at least one move from the floating panel (confirm the optimistic mark, pending state, and the agent's next re-emitted board landing live in the panel), THEN switch the main view to a different session while the panel stays open and confirm the popped-out game keeps receiving the agent's subsequent moves (the actual off-route liveness claim this whole spec exists to deliver — the primary acceptance criterion, not optional polish). Capture screenshots/a short recording as evidence. If a live agent game turns out to be impractical to drive in this run (e.g. sandboxing constraints), fall back to a test-mode/scripted session that exercises the same session-switch-while-pinned path, and say so plainly in the evidence write-up rather than silently substituting a narrower check — per AGENTS.md's demo-claim gate, never assert this works end-to-end without having actually driven it.
