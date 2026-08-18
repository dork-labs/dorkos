# Keyboard Shortcuts & Focus State Machine

## Overview

Interactive tools (Tool Approval and AskUserQuestion) pause the Claude Agent SDK mid-execution to collect user input. While these tools are pending, global keyboard shortcuts allow the user to respond without reaching for the mouse. This guide documents the focus state machine, the shortcut hook, the visual active/inactive states, and the full component wiring.

## Focus State Machine

The chat UI has four focus states. At any given time, exactly one is active.

```
                          user sends message
  IDLE/TYPING  ──────────────────────────────────►  STREAMING
  (Composer.Input focused,                          (Composer.Input disabled,
   no global shortcuts)                              no shortcuts needed)
       ▲                                                   │
       │                                                   │
       │  tool resolved                  SSE: approval_required
       │  (next pending auto-promotes)         or question_prompt
       │                                                   │
       │                                                   ▼
  WAITING_FOR_APPROVAL  ◄───────────┐    WAITING_FOR_ANSWER
  (Enter=Approve, Esc=Deny)         │    (1-9, Arrows, Space,
       │                            │     Enter, [, ])
       │                            │         │
       └────────────────────────────┘─────────┘
                tool resolved, next pending auto-promotes
                or SDK resumes and stream completes → IDLE
```

### State Details

| State                    | Composer.Input         | Global Shortcuts                            | Trigger                                                               |
| ------------------------ | ---------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| **IDLE/TYPING**          | Enabled, focused       | None                                        | Default state; also entered when streaming ends with no pending tools |
| **STREAMING**            | Disabled (`isLoading`) | None                                        | User sends a message; `status === 'streaming'`                        |
| **WAITING_FOR_APPROVAL** | Disabled               | `Enter` = approve, `Esc` = deny             | SSE `approval_required` event received                                |
| **WAITING_FOR_ANSWER**   | Disabled               | `1`-`9`, arrows, `Space`, `Enter`, `[`, `]` | SSE `question_prompt` event received                                  |

### What `Enter` does in the composer

`Enter` has one meaning — send — and exactly one authorized exception, which exists only when
`ui.composer.richText` is on (DOR-948). Both fields run the same keyboard ladder through the
`EditingSurface` port, so everything not in this table is identical on either field.

| Where the caret is                | Rich text OFF (textarea) | Rich text ON (Lexical)                     |
| --------------------------------- | ------------------------ | ------------------------------------------ |
| Not in a list                     | Sends                    | Sends                                      |
| In a list item with text in it    | Sends                    | Starts the next bullet — **does not send** |
| In an EMPTY list item             | Sends                    | Leaves the list — **does not send**        |
| With a palette open that has rows | Palette takes it         | Palette takes it                           |
| With a palette open and NO rows   | Falls through and sends  | Falls through and sends                    |

The zero-result fall-through is DOR-946's rung and is not a rich-text behaviour; it is listed
because it is the one case where an open palette does not swallow `Enter`.

`Shift+Enter` is a newline on both fields, and a trailing `\` plus `Enter` is a newline on both.
Neither is affected by the setting.

### Steer and Add context chords (composer, `use-input-keyboard.ts`)

While a turn is streaming, the composer offers two more dispositions beside Queue, each on a
modifier + `Enter` chord (fine pointer only; on a touch-only device these live on the send menu
because `Enter` is a newline there):

| Chord                          | Disposition | Reaches                                       |
| ------------------------------ | ----------- | --------------------------------------------- |
| `⌘Enter` / `Ctrl+Enter`        | `steer`     | `onSteer` — deliver into the live turn now    |
| `⌘⇧Enter` / `Ctrl+Shift+Enter` | `stage`     | `onStage` — add context for the next dispatch |

Both are **capability-gated by presence, not by a disabled state.** The host wires `onSteer` /
`onStage` only when the session's runtime declares `supportsSteer` / `supportsContextStaging`
(`SessionComposer` reads them via `useCapabilitiesForRuntime`). When a callback is absent the
chord resolves to **Queue** (`onSteer ?? onQueue`, `onStage ?? onQueue`) — a shortcut never does
something the button cannot, and it is never swallowed. The chords sit downstream of the
backslash-continuation rule and only fire with `isStreaming`, `value.trim()`, no open queue-item
edit, and no pending command. The composer's split action (`InputActionButton` → `DispositionMenu`)
is the pointer equivalent: a caret beside Queue, shown under the same capability rule, absent on a
queue-only runtime.

### Why Global Shortcuts Work

The chat textarea is `disabled={isLoading}` during streaming. Interactive tools only appear while the SSE connection is open (i.e., during streaming). Because the textarea is disabled, it cannot receive focus or keystrokes, so `document.addEventListener('keydown', ...)` handlers fire without conflicting with text input.

**Exception:** When the user selects the "Other" option in `QuestionPrompt`, a textarea appears for free-text input. While this textarea is focused, most shortcuts are suppressed -- only `Enter` (submit) still works from inside a text input.

## Hook: `useInteractiveShortcuts`

**Location:** `apps/client/src/layers/shared/model/use-interactive-shortcuts.ts`

The hook attaches a global `keydown` listener only when `activeInteraction` is non-null (i.e., a tool is waiting for user input). It removes the listener when the interaction is resolved.

### Interface

```typescript
interface UseInteractiveShortcutsOptions {
  activeInteraction: { type: 'approval' | 'question'; toolCallId: string } | null;
  onApprove?: () => void;
  onDeny?: () => void;
  onToggleOption?: (index: number) => void;
  onNavigateOption?: (direction: 'up' | 'down') => void;
  onNavigateQuestion?: (direction: 'prev' | 'next') => void;
  onSubmit?: () => void;
  optionCount?: number;
  focusedIndex?: number;
}
```

### Key Behaviors

1. **Guard:** If `activeInteraction` is `null`, no listener is attached.
2. **Text input filter:** If the `keydown` target is an enabled `<textarea>` or `<input>`, only `Enter` (submit) is handled. All other keys pass through to the text input normally.
3. **Double-fire prevention:** A `respondingRef` prevents the approve/deny callbacks from firing twice on rapid key presses. The ref resets when `activeInteraction.toolCallId` changes (new tool becomes active).
4. **Approval mode:** `Enter` calls `onApprove`, `Escape` calls `onDeny`. No other keys are handled.
5. **Question mode:** Digit keys `1`-`9` toggle options (bounds-checked against `optionCount`), arrow keys navigate, `Space` toggles the focused option, `[`/`]` and `ArrowLeft`/`ArrowRight` navigate between question tabs, `Enter` submits.

## Keyboard Shortcut Reference

### Navigation

| Key                | Action                                                       |
| ------------------ | ------------------------------------------------------------ |
| `Cmd+K` / `Ctrl+K` | Open command palette                                         |
| `Cmd+B` / `Ctrl+B` | Toggle sidebar (Shadcn built-in `SIDEBAR_KEYBOARD_SHORTCUT`) |
| `Cmd+.` / `Ctrl+.` | Toggle the right panel                                       |
| `Cmd+Shift+.`      | Open the Session panel                                       |
| `Cmd+Shift+A`      | Toggle the docked profile (`use-profile-shortcut.ts`)        |
| `Cmd+Shift+Y`      | Answer the next thing waiting on you (`use-ask-shortcut.ts`) |
| `?`                | Open keyboard shortcuts panel (`use-shortcuts-panel.ts`)     |
| `Cmd+Shift+D`      | Dev playground — **`import.meta.env.DEV` only**              |

**`Cmd+Shift+Y` takes you to the next thing waiting on you.** `useAskShortcut` (`features/ask/model/use-ask-shortcut.ts`) registers a **capture-phase** listener — always, not only while something is pending — that moves focus to the next Ask card on screen, cycling round at the end, and asks the header tray to open when none is drawn. It is the only thing that moves focus onto a card; an Ask that arrives while you are typing sits there quietly.

It has its own chord rather than sharing `Cmd+Shift+A` with the Profile. Sharing was tried: "Answer while something is waiting, Profile otherwise" makes the `?` panel list one combo with two labels, and a reader discovers which meaning they got by watching the screen. `Y` is free in this registry and unbound in Chrome, Firefox and Safari.

**With the card focused, `A` allows it and `D` refuses it.** `AskCardRoot`'s own `onKeyDown` (`features/ask/ui/AskCard.tsx`) — a component-level listener, not a document one, and deliberately so: a plain letter as a global hotkey would fire while someone is typing "a" or "d" into the composer, which `typingInto(event.target)` also guards against directly. Neither key does anything unless the card already has focus, which only `Cmd+Shift+Y` (or a click) ever gives it.

`Cmd+Shift+A` toggles rather than opens: with the right panel already showing the `profile` tab it closes the panel; anything else switches to that tab and opens it. Same document-level listener pattern as `useRightPanelShortcut`, mounted from both `App.tsx` and `AppShell.tsx`.

**It does not land on the profile everywhere, and the handler is not what decides.** The store write always happens, but `profile`'s `visibleWhen` (`app/init-extensions.ts`) admits it only on `/session` or an explicit agent path, and never under `/marketplace`. When the requested tab is not visible, `RightPanelContainer`'s reconciler re-selects the first visible contextual contribution, falling back to the always-present global one — so on Tasks, Activity, Marketplace and Home the chord opens the right panel on **Pulse**. Fix that by changing `visibleWhen`, not the shortcut.

`Cmd+Shift+D` is gated at its listener (`SidebarFooterStrip.tsx`: `if (!import.meta.env.DEV) return;`) and, since DOR-567, at the registry too: `SHORTCUTS.DEV_PLAYGROUND` carries `devOnly: true`, which `getShortcutsGrouped` uses to drop it from the `?` panel outside a dev build — the same mechanism `desktopOnly` uses for the in-window tab shortcuts below. The handler keeps its own guard as defense in depth; the registry flag is what stops the panel promising a chord production can't honor.

> **Verify a shortcut by its handler, not by its registry constant.** `use-profile-shortcut.ts` matches the raw `KeyboardEvent` — `(e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'A'` — and never imports `SHORTCUTS.AGENT_PROFILE`; the registry entry only feeds the `?` panel's display string. Grepping for the constant therefore proves nothing about whether a chord works, **in either direction**. Search for a keydown handler on the actual key before concluding a shortcut is dead — an earlier revision of this guide called `Cmd+Shift+A` dead on exactly that bad evidence.

### In-window tabs (DOR-540)

Registered on `document` by `useAppTabShortcuts`
(`features/app-tabs/model/use-app-tab-shortcuts.ts`) for as long as the shell is mounted **in the
desktop app**. The hook is called unconditionally (Rules of Hooks) and returns early from its effect
when `isDesktopShell()` is false, so in a browser no listener exists at all.

| Key                        | Action                                                            |
| -------------------------- | ----------------------------------------------------------------- |
| `Cmd+T` / `Ctrl+T`         | New tab                                                           |
| `Cmd+1-8` / `Ctrl+1-8`     | Activate the tab at that index from the left                      |
| `Cmd+9` / `Ctrl+9`         | Activate the **last** tab, whatever the count                     |
| `Cmd+Shift+[` / `Ctrl+...` | Previous tab (matched on `event.code`, not `key` — Shift mangles) |
| `Cmd+Shift+]` / `Ctrl+...` | Next tab (same)                                                   |

**These are live in the desktop app only, and that is the design (DOR-568).** The tab strip they
drive is a desktop-app feature: a browser already has tabs, and a browser's tab keys are its own.
**Do not upgrade that into "the browser already binds these four".** Which chords a browser binds is
its business and varies by platform — `Cmd+Shift+[`/`]` is a macOS Chrome/Safari binding, while
Chrome and Firefox on Windows and Linux step tabs with `Ctrl+PageUp`/`Ctrl+PageDown` — so on those
two of the four do nothing at all, and that is fine. The claim we can make is the one about us: the
browser cockpit registers nothing and cancels nothing. Do not "fix" this by `preventDefault`ing
harder, and do not re-enable the strip in the browser to give the chords something to do — that is
the regression this gate exists to prevent.

Inside the desktop strip the roving `tablist` traversal (`Tab` to enter, arrows to move,
`Home`/`End`, `Delete` to close) and the `+` button are the mouse-free path for anyone who does not
reach for the chords. Both matter; neither is a fallback for the other.

`SHORTCUTS.NEW_TAB`, `SELECT_TAB`, `PREVIOUS_TAB` and `NEXT_TAB` carry `desktopOnly: true`, which is
what keeps them out of the `?` panel in a browser (`getShortcutsGrouped`). The panel is a promise;
`src/__tests__/shortcuts-registered.test.tsx` proves each one live on desktop **and** absent from the
list in a browser.

`Cmd/Ctrl+W` is deliberately **absent** from that hook. In the browser it belongs to the browser; on
desktop it belongs to the shell's Window menu, which sends it back over IPC — see
`app/use-electron-close-tab.ts` and `contributing/desktop-app-development.md` §5.

### Command Palette

The global command palette (`Cmd+K` / `Ctrl+K`) is the front door for **recall**: it finds
conversations, agents, rooms and actions by what they are CALLED. It never searches message
content — that is a separate surface (spec `sidebar-now-today-library` §15).

| Behavior              | Description                                                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zero-query state**  | A command center, in this order: **Continue** (conversations running right now, each with its live verb) → **Recent** (one mix of conversations, rooms and agents; unread rooms lead, then recency) → **New** (New Session, Create Agent) → the prefix legend. A group with nothing in it is absent, Continue included |
| **Typed state**       | Conversations, All Agents, Channels, Direct Messages, Features, Commands, Quick Actions                                                                                                                                                                                                                                |
| **Conversation rows** | The sidebar's row grammar: avatar + `Agent › title` + origin mark + time, sharing `row-grammar.ts`'s 42% / 6ch truncation budget                                                                                                                                                                                       |
| **`#` prefix mode**   | Typing `#` scopes search to channels; the `#` is stripped from the search term                                                                                                                                                                                                                                         |
| **`@` prefix mode**   | Typing `@` scopes search to agents and direct messages; the `@` is stripped from the search term                                                                                                                                                                                                                       |
| **`>` prefix mode**   | Typing `>` scopes search to commands only; the `>` is stripped from the search term                                                                                                                                                                                                                                    |
| **Dialog precedence** | Cmd+K toggles the palette open/closed; does not conflict with interactive tool shortcuts since the palette dialog captures focus                                                                                                                                                                                       |
| **Mobile**            | Opens as a bottom Drawer instead of a centered Dialog                                                                                                                                                                                                                                                                  |
| **Arrow wrapping**    | Arrow keys wrap around the list (uses cmdk `loop` prop)                                                                                                                                                                                                                                                                |

#### Command Palette Shortcuts

Rows carry their own shortcuts inline — a conversation row shows `↵` and `⌘↵` while it is the
highlighted one, so the pair is learned by using the palette rather than by reading this table.

| Key                        | Context                          | Action                                        |
| -------------------------- | -------------------------------- | --------------------------------------------- |
| `Enter`                    | Conversation selected            | Open that conversation, in its own directory  |
| `Cmd+Enter` / `Ctrl+Enter` | Conversation selected            | Start a NEW conversation with the same agent  |
| `Enter`                    | Agent item selected              | Open agent sub-menu (drill-down into actions) |
| `Cmd+Enter` / `Ctrl+Enter` | Agent selected, root or sub-menu | Open agent in a new tab (skips sub-menu)      |
| `Backspace`                | In sub-menu, input is empty      | Go back one level to the parent page          |
| `Escape`                   | In sub-menu                      | Go back one level (does not close the dialog) |
| `Escape`                   | At root level                    | Close the command palette                     |

The agent sub-menu offers **Open Here**, **Open in New Tab** (`openLink(href, { target: 'tab' })`)
and — in the desktop app only — **Open in New Window** (`openLink(href, { target: 'window' })`).
"Tab" and "window" are separate `LinkTarget`s on purpose: folding the second into the first deletes
the only way to ask for a second cockpit window. They resolve the same `?session=` up front
(`agentHref`), so they agree on which session an agent is on, and neither inherits the `?session=`
you were already reading.

**Who owns "a new tab" depends on the surface** (DOR-568), and `link-navigation.ts` is what decides.
`openLink` uses a registered `tabOpener` only when `isDesktopShell()` is true as well, so
`target: 'tab'` reaches the in-window strip on desktop and falls through to
`window.open(url, '_blank')` — a real browser tab — in a browser, whatever adapters happen to be in
scope. The label is honest on both. `main.tsx` gates its `registerTabOpener` call on the same
predicate, but that is a clarification, not the enforcement: deleting it changes nothing a person can
see. The Obsidian embed (`supportsNewTab() === false`) has neither strip nor browser tab, so a tab
request opens in place rather than being dropped.

**A `window` request the surface cannot honour degrades to a tab, never to `here`.** `openLink` takes
the real-second-window branch on `supportsSeparateWindow()` and otherwise lets `window` fall into the
same branch as `tab`. Both answers are wrong in the same direction; only one of them takes away the
view the person is already looking at. Latent while the palette is the only caller (it gates the
row), load-bearing the moment anything else asks.

**New Window is gated on `supportsSeparateWindow()`** (`supportsNewTab() && isDesktopShell()`) and
the row is omitted, not disabled and not remapped. In a browser a `window.open` already _is_ the tab
the row above offers; forcing a real window would need a features-string popup with no address bar,
no reload and no bookmark — worse than dragging the tab out. **Do not add one.**

#### Dynamic Keyboard Hints (PaletteFooter)

The command palette displays a `PaletteFooter` bar showing context-appropriate keyboard shortcuts. Hints adapt based on navigation depth and selection state:

| Context                    | Hints Shown                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| Root level, no selection   | `↑↓` Navigate, `esc` Close                                                                    |
| Root level, agent selected | `↑↓` Navigate, `Enter` Open, `⌘Enter` / `Ctrl+Enter` New Tab, `esc` Close                     |
| Sub-menu (`agent-actions`) | `↑↓` Navigate, `⌘Enter` / `Ctrl+Enter` New Tab, `Enter` Select, `Backspace` Back, `esc` Close |

### Streaming

| Key      | Action                                                                      |
| -------- | --------------------------------------------------------------------------- |
| `Escape` | Stop streaming — interrupts the active query server-side (highest priority) |

### Approval Mode (`WAITING_FOR_APPROVAL`)

| Key      | Action                |
| -------- | --------------------- |
| `Enter`  | Approve the tool call |
| `Escape` | Deny the tool call    |

### Question Mode (`WAITING_FOR_ANSWER`)

| Key                 | Action                                |
| ------------------- | ------------------------------------- |
| `1` - `9`           | Toggle option at that index (1-based) |
| `Arrow Up`          | Move focus to previous option (wraps) |
| `Arrow Down`        | Move focus to next option (wraps)     |
| `Space`             | Toggle the currently focused option   |
| `Enter`             | Submit answers                        |
| `Arrow Left` / `[`  | Navigate to previous question tab     |
| `Arrow Right` / `]` | Navigate to next question tab         |

**Inside "Other" textarea:** Only `Enter` (submit) is active. All other shortcuts are suppressed so the user can type freely.

## Active vs. Inactive Tool Visual State

When multiple interactive tools are pending simultaneously (e.g., the SDK calls `canUseTool` concurrently), only the **first pending** tool is the "active" shortcut target. The active tool is determined by `useChatSession`'s `activeInteraction` property, which returns the first tool call with `status === 'pending'` and a non-null `interactiveType`.

### Visual Differences

| Property             | Active (first pending)                  | Inactive (subsequent pending) |
| -------------------- | --------------------------------------- | ----------------------------- |
| Border ring          | `ring-2 ring-amber-500/30`              | No ring                       |
| `Kbd` shortcut hints | Visible (e.g., `Enter`, `Esc`, `1`-`9`) | Hidden                        |
| Keyboard shortcuts   | Functional                              | No effect (must click)        |

### Auto-Promotion

When the active tool is resolved (approved, denied, or answered), the next pending tool automatically becomes active. This is derived from the message state -- `activeInteraction` simply finds the first pending interactive tool call in the current message list.

## Component Integration

### Wiring Diagram

```
ChatPanel
  ├── useInteractiveShortcuts(activeInteraction, callbacks)
  ├── focusedOptionIndex state
  ├── activeToolHandleRef (InteractiveToolHandle)
  │
  └── Conversation.Timeline
        └── SessionMessage (receives activeToolCallId, onToolRef, focusedOptionIndex)
              └── MessageContext (the three props, put on context for the body)
                    └── AssistantMessageContent (reads them with useMessageContext)
                          ├── ApprovalPrompt (ref → ApprovalPromptHandle)
                          │     isActive={toolCallId === activeToolCallId}
                          │     ref={isActive ? approvalRefCallback : undefined}
                          │
                          └── QuestionPrompt (ref → QuestionPromptHandle)
                                isActive={toolCallId === activeToolCallId}
                                ref={isActive ? questionRefCallback : undefined}
                                focusedOptionIndex={isActive ? focusedOptionIndex : -1}
```

### `ChatPanel.tsx`

`ChatPanel` is the orchestrator. It:

1. Reads `activeInteraction` from `useChatSession`
2. Maintains `focusedOptionIndex` state (reset to `0` when `activeInteraction.toolCallId` changes)
3. Holds `activeToolHandleRef` -- an imperative handle to the active interactive component
4. Wires `useInteractiveShortcuts` with callbacks that delegate to the imperative handle:

```typescript
useInteractiveShortcuts({
  activeInteraction: activeInteractionForShortcuts,
  onApprove: useCallback(() => {
    const handle = activeToolHandleRef.current;
    if (handle && 'approve' in handle) handle.approve();
  }, []),
  onDeny: useCallback(() => {
    const handle = activeToolHandleRef.current;
    if (handle && 'deny' in handle) handle.deny();
  }, []),
  onToggleOption: useCallback((index: number) => {
    const handle = activeToolHandleRef.current;
    if (handle && 'toggleOption' in handle) {
      handle.toggleOption(index);
      setFocusedOptionIndex(index);
    }
  }, []),
  // ... onNavigateOption, onNavigateQuestion, onSubmit
});
```

### `SessionMessage.tsx`

Threads three props from `ChatPanel` through `SessionTranscript`:

- **`activeToolCallId`** -- The `toolCallId` of the currently active interactive tool
- **`onToolRef`** -- Callback to register the imperative handle of the active component
- **`focusedOptionIndex`** -- Which option is keyboard-focused in `QuestionPrompt`

It does not consume them. The row itself is the shared `Message.*` chrome, so it puts all three on `MessageContext` and lets the body renderer read them: `AssistantMessageContent` calls `useMessageContext()`, checks `part.toolCallId === activeToolCallId` for each tool call part, and conditionally passes the `ref` callback. Only the active tool's ref is captured -- inactive tools do not register handles.

### `ApprovalPrompt.tsx`

Exposes `ApprovalPromptHandle` via `forwardRef` + `useImperativeHandle`:

```typescript
export interface ApprovalPromptHandle {
  approve: () => void;
  deny: () => void;
}
```

When `isActive` is `true`, the component renders:

- Amber `ring-2 ring-amber-500/30` border
- `<Kbd>Enter</Kbd>` next to the Approve button
- `<Kbd>Esc</Kbd>` next to the Deny button

### `QuestionPrompt.tsx`

Exposes `QuestionPromptHandle` via `forwardRef` + `useImperativeHandle`:

```typescript
export interface QuestionPromptHandle {
  toggleOption: (index: number) => void;
  navigateOption: (direction: 'up' | 'down') => void;
  navigateQuestion: (direction: 'prev' | 'next') => void;
  submit: () => void;
  getOptionCount: () => number;
  getActiveTab: () => string;
}
```

When `isActive` is `true`, the component renders:

- Amber `ring-2 ring-amber-500/30` border
- `<Kbd>` hints on each option label (e.g., `1`, `2`, `3`)
- Arrow key navigation hint (`<Kbd>&larr;</Kbd><Kbd>&rarr;</Kbd> navigate questions`) when multiple question tabs exist
- `<Kbd>Enter</Kbd>` on the Submit button
- Focused option highlight via `ring-1 ring-amber-500/50` on the option at `focusedOptionIndex`

Option count includes the "Other" free-text option (i.e., `options.length + 1`).

### `InferenceIndicator.tsx`

Displays contextual status text below the message list. When `isWaitingForUser` is `true`:

- **Approval:** Shows `Shield` icon + "Waiting for your approval"
- **Question:** Shows `MessageSquare` icon + "Waiting for your answer"

Both use amber coloring (`text-amber-500` icon, `text-amber-600` text) to match the interactive tool cards.

## `Kbd` Component

**Location:** `apps/client/src/layers/shared/ui/kbd.tsx`

A presentational component that renders keyboard shortcut hints.

```typescript
function Kbd({ className, children, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'pointer-events-none hidden md:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
```

Key details:

- **Hidden on mobile:** `hidden md:inline-flex` ensures hints only show on screens >= 768px. Mobile users tap buttons directly.
- **Non-interactive:** `pointer-events-none select-none` prevents the hint from interfering with click targets.
- **Styled to match shadcn/ui:** Uses `bg-muted`, `text-muted-foreground`, `border`, `font-mono` for a consistent appearance with the design system.

## Shortcut Registry

All shortcuts are defined in `apps/client/src/layers/shared/lib/shortcuts.ts` as a centralized `SHORTCUTS` constant. Adding a new shortcut to the registry automatically makes it appear in:

- The `?` shortcuts reference panel
- The command palette (if a feature item references it)
- Inline button hints (if the button uses `formatShortcutKey`)

The registry is the single source of truth. Do not define shortcut display strings inline.

### Adding a New Shortcut to the Registry

1. Add a new entry to the `SHORTCUTS` object in `shortcuts.ts` with `id`, `key`, `label`, and `group`
2. The `key` uses a normalized format: `mod+` for Cmd/Ctrl, `shift+`, `alt+`, `ctrl+`
3. The shortcut automatically appears in the `?` reference panel (grouped by `group`)
4. Use `formatShortcutKey(SHORTCUTS.YOUR_SHORTCUT)` in UI to display the platform-appropriate key string
5. Use `import { isMac } from '@/layers/shared/lib'` instead of inline `navigator.platform` checks

## Adding Shortcuts for a New Interactive Tool

When adding a new interactive tool (see `contributing/interactive-tools.md`), extend the keyboard shortcut system in order:

1. **Add a new type** to `activeInteraction.type` (currently `'approval' | 'question'`) in the `UseInteractiveShortcutsOptions` interface in `apps/client/src/layers/shared/model/use-interactive-shortcuts.ts`.
2. **Add a new branch** in the `handler` function inside `useInteractiveShortcuts` for your type's key bindings.
3. **Define a handle interface** for your component (e.g., `MyToolHandle`) and add it to the `InteractiveToolHandle` union in `ui/message/types.ts`.
4. **Expose the handle** via `forwardRef` + `useImperativeHandle` in your component.
5. **Wire callbacks** in `ChatPanel.tsx` that delegate from the shortcut hook to the imperative handle.
6. **Render `Kbd` hints** in your component, conditioned on `isActive`.
