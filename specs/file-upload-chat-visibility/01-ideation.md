---
slug: file-upload-chat-visibility
number: 109
created: 2026-03-10
status: ideation
---

# File Upload Chat History Visibility

**Slug:** file-upload-chat-visibility
**Author:** Claude Code
**Date:** 2026-03-10
**Branch:** preflight/file-upload-chat-visibility

---

## 1) Intent & Assumptions

- **Task brief:** After uploading a file and sending a message, the uploaded file doesn't show visually in the chat history. The file paths are prepended as plain text ("Please read the following uploaded files:\n- .dork/.temp/uploads/8a3b2c1d-screenshot.png"), which renders as raw text in the message bubble. We need styled file attachment indicators in the chat history — thumbnails for images, file chips for documents — matching the conventions of Claude.ai, ChatGPT, and Slack.

- **Assumptions:**
  - The existing file upload pipeline (spec #106) is implemented and working — files upload, paths inject into message text, agent reads them
  - The JSONL transcript format and `transformContent` path injection are stable and should not change
  - This is purely a client-side rendering concern — no server, transport, or data model changes
  - The "Please read the following uploaded file(s):" prefix is the stable marker for detecting file attachments in message text
  - Image files served from the upload directory are accessible via the existing Express static/API routes (or can be loaded by the client via relative path)

- **Out of scope:**
  - Server-side changes to JSONL format or message schema
  - File preview modal / lightbox for full-size images
  - Download buttons or file management actions
  - Extending `MessagePart` union with a `FilePart` type (future enhancement)
  - Assistant message file references (varied and unpredictable format)
  - File cleanup/pruning from upload directory

## 2) Pre-reading Log

- `specs/upload-files/02-specification.md`: Full implementation spec for file uploads. Lists "File preview/thumbnails in chat messages" as a non-goal. Defines the `transformContent` injection format and file storage at `{cwd}/.dork/.temp/uploads/`.
- `apps/client/src/layers/features/chat/ui/message/UserMessageContent.tsx`: Renders user message content. Currently displays `message.content` as plain text via `whitespace-pre-wrap`. This is the primary modification target.
- `apps/client/src/layers/features/chat/ui/message/MessageItem.tsx`: Orchestrator that delegates to `UserMessageContent` or `AssistantMessageContent` based on role.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: Contains `fileTransformContent` callback (lines 50-71) that prepends file paths to outgoing messages.
- `apps/client/src/layers/features/chat/ui/FileChipBar.tsx`: Pre-send file chip rendering — reference pattern for styling (motion animations, chip layout, icon + filename + status).
- `apps/client/src/layers/features/chat/model/chat-types.ts`: Defines `ChatMessage`, `MessagePart`, `TextPart`, `ToolCallPart`. `ChatMessage.content` is a plain `string`.
- `apps/client/src/layers/features/chat/model/use-file-upload.ts`: Hook managing pending files, upload state, and `uploadAndGetPaths()`.
- `contributing/design-system.md`: Calm Tech design system — rounded-md for chips, bg-muted for surfaces, text-xs for metadata, 150ms animations.
- `contributing/animations.md`: Motion library patterns — AnimatePresence for list transitions, scale/fade for chips.
- `research/20260310_file_attachment_chat_visibility.md`: Research on how major chat apps display file attachments.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/layers/features/chat/ui/message/UserMessageContent.tsx` — Main modification target. Renders user message content as plain text.
  - `apps/client/src/layers/features/chat/ui/FileChipBar.tsx` — Reference pattern for file chip styling.
  - `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Contains `fileTransformContent` that injects file paths into message text.
  - `apps/client/src/layers/features/chat/model/chat-types.ts` — Message type definitions.

- **Shared dependencies:**
  - `motion/react` — Animation library (AnimatePresence, motion.div)
  - `lucide-react` — Icons (File, FileImage, FileText, FileCode, etc.)
  - `@/layers/shared/lib` — `cn()` utility for class merging
  - Tailwind CSS v4 — Styling via utility classes

- **Data flow:**
  - User selects files → `useFileUpload.addFiles()` → file chips appear in `FileChipBar`
  - User sends message → `fileTransformContent()` uploads files, prepends paths to message text
  - Message stored in JSONL transcript with file paths as plain text prefix
  - `useChatSession` reads JSONL → produces `ChatMessage[]` with `content: string`
  - `MessageList` → `MessageItem` → `UserMessageContent` renders `message.content`
  - **Gap:** `UserMessageContent` renders the file prefix as raw text instead of styled attachments

- **Feature flags/config:** None specific to this feature.

- **Potential blast radius:**
  - Direct: 1 file modified (`UserMessageContent.tsx`), 1-3 new files created (parser utility, attachment components)
  - Indirect: None — rendering change is isolated to `UserMessageContent`
  - Tests: `UserMessageContent` test file needs updates or creation

## 4) Root Cause Analysis

N/A — this is a feature enhancement, not a bug fix.

## 5) Research

### How Major Chat Apps Handle File Attachments

Every major chat app renders file attachments as structured visual components — never as raw paths:

- **Claude.ai**: Images as inline thumbnails (~80-120px tall) inside user bubble; documents as horizontal file chips with icon + filename, positioned above message text
- **ChatGPT**: Constrained thumbnails (~200px wide) above message text; PDFs/code files as file cards with type icon + filename
- **Slack**: Full-width inline image previews below text; non-image files as cards with icon, filename, size, download link
- **Discord**: Constrained image previews below text (~400px max); non-image files as compact chips with icon, filename, size
- **iMessage**: Images fill bubble width; documents as compact chips inside bubble
- **Telegram**: Photos as full-width previews; documents as compact cards with icon, filename, size
- **Linear**: Inline image thumbnails in comments; non-image files as chips below text

### Universal Patterns

1. **Type bifurcation**: Images get inline previews; documents get chips — every app does this
2. **File chip anatomy**: Type icon + original filename + optional size/type label
3. **Original filename only**: Internal storage paths/UUIDs are never surfaced to users
4. **Meaningful image sizing**: Minimum ~80x80px thumbnails, never icon-sized

### Potential Solutions

**1. Client-Side Text Parser (Recommended)**

- Detect the existing "Please read the following uploaded file(s):" prefix in `UserMessageContent.tsx`, extract paths, render as chips/thumbnails above message text
- Pros: Zero server changes, retroactive for existing history, purely a display concern, low complexity
- Cons: Fragile to prefix format changes (but prefix is defined in one place)
- Complexity: Low
- Maintenance: Low

**2. Extend Message Metadata**

- Add `attachments` array to JSONL message format; store original filename, size, MIME type alongside the path
- Pros: Clean data model, stores original filename without derivation
- Cons: JSONL format change, server/transport/type changes, does not improve existing transcripts
- Complexity: High
- Maintenance: Medium

**3. Structured Sentinel Format**

- Replace the human-readable prefix with a machine-readable sentinel: `<dork:files paths="..."/>`
- Pros: Unambiguous parser, extensible
- Cons: Changes what the agent reads (needs verification), medium work
- Complexity: Medium
- Maintenance: Medium

### Recommendation

**Use Approach 1 (Client-Side Text Parser)** — implemented in `UserMessageContent.tsx` with a parser utility extracted to `features/chat/lib/parse-file-prefix.ts`. The prefix format is already stable and defined in one place (`ChatPanel.tsx`). A regex parser strips the prefix and recovers the user-facing filename by stripping the UUID prefix from the stored basename (e.g., `8a3b2c1d-screenshot.png` → `screenshot.png`).

Render attachments above the message text following the Claude.ai/ChatGPT convention. Use inline thumbnails for image extensions (png, jpg, jpeg, gif, webp) and file chips with Lucide icons for all other types.

## 6) Decisions

| #   | Decision                                      | Choice                       | Rationale                                                                                                                                                                                                  |
| --- | --------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Attachment placement relative to message text | Above message text           | Follows Claude.ai and ChatGPT convention — attachments are visually prominent and seen first. This is what users of AI chat tools expect.                                                                  |
| 2   | Image file treatment                          | Inline thumbnails for images | Universal convention across all major chat apps. Thumbnails (~120px tall) let users see what they attached at a glance. Non-image files get file chips.                                                    |
| 3   | Scope of file detection                       | User messages only           | Only user messages contain the "Please read the following uploaded file(s):" prefix. Assistant messages reference files differently (tool calls, code blocks). Keeps scope tight and implementation clean. |
