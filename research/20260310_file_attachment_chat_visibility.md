---
title: 'File Attachment Display in Chat Message History — UX Patterns & Implementation Strategy'
date: 2026-03-10
type: external-best-practices
status: active
tags: [file-upload, chat-ui, attachment, chip, thumbnail, ux-patterns, message-history]
feature_slug: file-upload-chat-visibility
searches_performed: 12
sources_count: 18
---

# File Attachment Display in Chat Message History

## Research Summary

When users upload files in chat applications, every major app renders attachments as structured visual components — not raw text paths. The dominant pattern bifurcates by file type: **images render as inline thumbnails** (full-width or constrained preview), while **non-image documents render as file chips** (icon + filename + optional metadata). The consistent principle is that the raw file path is never exposed in the conversation UI.

For DorkOS specifically, the current implementation prepends `"Please read the following uploaded file(s):\n- .dork/.temp/uploads/..."` to message text, which is stored verbatim in JSONL. The cleanest solution is a **client-side text parser** that strips the file prefix from messages in `UserMessageContent.tsx` and renders the extracted paths as styled file chips — requiring zero changes to the server, the storage format, or the JSONL transcript structure.

---

## How Major Chat Apps Handle File Attachments

### Claude.ai

Claude.ai displays uploaded attachments in user messages with a distinct visual treatment above the message text:

- **Images**: Rendered as a thumbnail preview (constrained square/rectangle, ~80–120px tall) directly in the user message bubble. Clicking opens the image in a lightbox.
- **PDFs and documents**: Rendered as a horizontal file chip showing a document icon, the filename (truncated), and file type label. The chip sits above the text portion of the message.
- **Positioning**: Attachments appear above the message text, not inline with it.
- **No raw paths**: The underlying file path is never shown to the user. The chip shows the original filename the user selected.
- **Multiple files**: Multiple attachments stack or grid-wrap above the text.

### ChatGPT

ChatGPT's file attachment rendering in message history follows a similar pattern:

- **Images**: Displayed as a constrained thumbnail (approximately 200px wide) in the user message bubble, above or alongside the message text.
- **PDFs and other documents**: Shown as a file card with an icon, filename, and file type. The card is rendered inside the user message bubble area.
- **Code files and CSVs**: Shown with a code/spreadsheet icon and filename chip.
- **Positioning**: Files appear within the right-aligned user bubble, above the text content.
- **No raw paths**: Server-side storage paths are never surfaced; the UI always shows the original user-provided filename.

### Slack

Slack renders file attachments as distinct blocks separated from the message text:

- **Images**: Automatically shown as inline previews (full-width within the message column, up to ~400px tall). Images under 25,000px on the longest side get automatic preview. Clicking opens a lightbox.
- **Non-image files (PDF, Word, Excel, etc.)**: Rendered as a file card below the message text. The card includes: a file-type icon, the original filename, file size, and a download link. There is no thumbnail for documents.
- **Positioning**: File attachments appear below the text message, as separate blocks.
- **File type icons**: Distinct icons per file type (Word, Excel, PDF, generic file icon).
- **Download action**: An explicit "Download" or file action is surfaced on the card.

### Discord

Discord's file attachment handling:

- **Images**: Rendered inline as constrained previews (max ~400px wide) below the message text. Alt text is shown on hover.
- **Videos**: Shown as embedded players.
- **Non-image files**: Shown as a compact file chip containing an icon, filename, and file size. No preview.
- **Positioning**: All attachments appear below the message text.
- **"Spoiler" feature**: Files can be marked as spoilers, showing a blurred overlay until clicked.

### iMessage

iMessage has the most polished approach:

- **Images and videos**: Rendered as inline media bubbles, visually continuous with the chat thread. Images fill the full bubble width (up to ~255px). Multiple images grid-layout within the bubble.
- **Files (documents, PDFs)**: Shown as a compact file chip inside the bubble — file icon, filename, tap to open.
- **No text accompaniment required**: A message can consist entirely of an image bubble with no text.
- **Positioning**: Media fills the bubble; text messages with attachments show them stacked within the same bubble.

### Telegram

Telegram distinguishes sharply between "send as photo" and "send as file":

- **Photos sent as images**: Rendered as a full-width (bubble-width) image preview with rounded corners, inline in the chat.
- **Files sent as documents**: Rendered as a compact horizontal card showing file icon, filename, and file size. Always below text if text is present.
- **Key distinction**: The same image file looks completely different depending on how it was sent. This is a UX decision the sender makes at send time.

### Linear

Linear handles attachments in issue comments:

- **Images**: Rendered as inline thumbnails within the comment. Clicking opens a modal lightbox.
- **Non-image files**: Shown as file chips in a row below the comment text. Each chip has a file icon, original filename, and file size.
- **Positioning**: Attachments render below the comment prose.
- **No raw paths**: Only the original filename is shown, never the storage URL or internal path.

---

## Common UX Patterns

### Pattern 1: File Type Bifurcation (Universal)

Every app studied applies different visual treatment by file type:

- **Images** → inline visual preview (thumbnail, constrained dimension)
- **Documents/data files** → file chip (icon + name + optional metadata)

This is not optional — showing an image as a text chip is considered a UX failure. Showing a PDF as a thumbnail is also wrong (not meaningful without rendering). The distinction is load-bearing.

### Pattern 2: File Chip Anatomy

The standard file chip contains:

1. **File type icon** — disambiguates content type at a glance
2. **Filename** — original user-facing name (never internal storage paths)
3. **Optional metadata** — file size, type label (e.g., "PDF", "CSV")
4. **Optional action** — download button, open in viewer

The chip is compact (typically 40–48px tall), horizontally oriented, and uses a subtle background with a border or shadow to distinguish it from surrounding text.

### Pattern 3: Attachment Positioning

Consistent across apps: attachments appear either **above** the message text (Claude.ai, ChatGPT) or **below** it (Slack, Discord, Linear). Never inline with text. Never as raw paths within the text paragraph.

The "above text" pattern (Claude, ChatGPT) is preferable for AI chat apps because:

- The file provides context for the message that follows
- It visually signals "I sent this file, then asked about it"

### Pattern 4: Image Thumbnails Are Full-Bleed or Constrained, Never Icon-Sized

Image previews are always large enough to be meaningful:

- Minimum: ~80px × 80px (thumbnail)
- Maximum: bubble width (~200–400px, constrained proportionally)
- Never reduced to icon size (16–24px)

### Pattern 5: Original Filename, Never Storage Path

Without exception, every app shows the **user-facing original filename** (e.g., `design-mockup.png`) rather than the internal storage representation (e.g., `8a3b2c1d-design-mockup.png` or a cloud URL). This is an unambiguous best practice.

---

## The DorkOS Constraint Analysis

The current system in `ChatPanel.tsx` (line 62) produces messages like:

```
Please read the following uploaded file(s):
- .dork/.temp/uploads/8a3b2c1d-screenshot.png

[user's actual message text]
```

This text is stored verbatim in the JSONL transcript. The file path in the text is what the agent reads to locate the file. The user message rendering in `UserMessageContent.tsx` currently displays this raw text.

Three approaches exist for fixing the visual display:

---

## Potential Solutions

### 1. Client-Side Text Parser (Recommended)

**Description**: In `UserMessageContent.tsx`, detect the file prefix pattern in message content, extract the paths, strip the prefix from the displayed text, and render the paths as styled file chips above the message text. The JSONL transcript and server-side logic remain completely unchanged.

**Detection pattern** (the current prefix format from `ChatPanel.tsx` line 61–62):

```
Please read the following uploaded file(s):
- <path1>
- <path2>

<actual user message>
```

The parser regex:

```typescript
const FILE_PREFIX_RE = /^Please read the following uploaded file\(s\):\n((?:- .+\n)+)\n/;

function parseFilePrefix(content: string): { paths: string[]; text: string } | null {
  const match = content.match(FILE_PREFIX_RE);
  if (!match) return null;
  const paths = match[1]
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^- /, '').trim());
  const text = content.slice(match[0].length);
  return { paths, text };
}
```

**Visual rendering**: For each extracted path:

- If the path's extension is an image type (`png`, `jpg`, `jpeg`, `gif`, `webp`) → render as a thumbnail (the server can serve a `/api/sessions/:id/uploads/:filename` endpoint, or the Obsidian DirectTransport reads from disk directly)
- Otherwise → render as a file chip with a Lucide icon, filename (basename only), no path

**Pros**:

- Zero changes to server, JSONL, transport interface, or agent behavior
- Works retroactively — existing messages in chat history are immediately improved
- Purely a rendering concern — clean separation
- Low complexity: one new parsing function, one new small component

**Cons**:

- Fragile to prefix format changes: if `ChatPanel.tsx` ever changes the prefix string, the parser must be updated in sync
- The JSONL transcript still contains the raw path text (minor: this is what the agent reads, so it should stay)
- Cannot differentiate between "user typed this text themselves" and "system injected it" without a stricter prefix format (very unlikely to be an issue in practice)

**Complexity**: Low

---

### 2. Extend Message Metadata (Store Attachment Separately)

**Description**: Add an `attachments` field alongside the message in the JSONL or in a parallel data structure. When constructing the message to send to the agent, keep the path-injection logic; when storing/rendering the message, record the attachment metadata separately.

This would require changes to:

- The JSONL message format (add an `attachments` array field to the user turn)
- The transcript reader on the server to parse/return attachment metadata
- The `ChatMessage` type in `use-chat-session.ts`
- `UserMessageContent.tsx` to consume attachment metadata

**Pros**:

- Clean data model: attachment metadata is explicit, not embedded in prose
- Original filename and file size can be stored alongside the path
- The rendered filename doesn't need to be derived from the path
- More extensible (image dimensions, MIME type, etc.)

**Cons**:

- JSONL format change: any external tools or consumers of transcript files would need to handle the new field
- Higher implementation complexity: server changes, transport changes, type changes, test changes
- Still requires the path to be in the text content (the agent reads the text); the metadata is supplemental
- Does not retroactively improve existing transcripts

**Complexity**: High

---

### 3. Structured Message Format (Replace Text Injection)

**Description**: Instead of prepending human-readable text, inject a structured sentinel that the renderer can parse reliably:

```
<dork:files paths=".dork/.temp/uploads/abc-screenshot.png,.dork/.temp/uploads/def-report.pdf"/>

[user's actual message text]
```

The agent treats the first line as text it can parse (Claude Code understands XML-like tool-use syntax natively). The renderer detects the `<dork:files ...>` tag and renders chips.

**Pros**:

- More reliable parser (no ambiguity about whether the user typed this)
- Extensible (could add `names`, `sizes`, `mimetypes` attributes)
- Still zero server-side changes

**Cons**:

- Changes the text the agent reads — may affect how Claude Code processes the file instruction (needs verification)
- More work than the plain-text parser approach
- Slightly worse for humans reading raw JSONL transcripts

**Complexity**: Medium

---

## Recommendation

**Adopt Approach 1 (Client-Side Text Parser) with one enhancement.**

### Rationale

The current prefix format is already stable and defined in a single place (`ChatPanel.tsx` line 61–62). A parser in `UserMessageContent.tsx` that detects this known prefix, strips it, and renders chips is:

1. Zero-server-change — the JSONL stays identical, the agent behavior stays identical
2. Immediately retroactive — all existing chat history renders better
3. Aligned with the DorkOS constraint: this is purely a display layer concern
4. Low risk: the prefix format is controlled by the same codebase

### Enhancement: Show Basename Only, with Original Name Derivation

The stored path is `8a3b2c1d-screenshot.png`. The parser should:

1. Extract the basename via `path.basename(savedPath)` (or a simple `split('/').pop()`)
2. Strip the UUID prefix: `savedPath.replace(/^[0-9a-f-]+-/i, '')`
3. Show the resulting clean name: `screenshot.png`

This recovers the user-facing filename from the storage convention.

### Visual Treatment

Following the Claude.ai / ChatGPT pattern (most relevant for AI chat apps):

**File chip (for non-image files)**:

```tsx
<div className="bg-muted/50 flex items-center gap-2 rounded-lg px-3 py-2 text-xs">
  <FileIcon className="text-muted-foreground size-3.5 flex-shrink-0" />
  <span className="text-foreground truncate font-medium">{cleanFilename}</span>
</div>
```

**Image preview (for image files)**:

```tsx
<img
  src={`/api/sessions/${sessionId}/uploads/${encodedFilename}`}
  alt={cleanFilename}
  className="max-h-48 max-w-full rounded-lg object-contain"
/>
```

**Layout within the user message bubble**: Attachments render **above** the message text, separated by a small gap (`mb-2`). This matches the Claude.ai and ChatGPT convention.

**File type icons** (Lucide icons, already available in the codebase):

- Images → `Image`
- PDFs → `FileText`
- CSV/spreadsheets → `Sheet`
- Code files → `Code`
- Generic → `File`

### Where to Implement

- **Parser function**: `apps/client/src/layers/features/chat/lib/parse-file-prefix.ts`
- **Chip component**: `apps/client/src/layers/features/chat/ui/message/FileAttachmentChip.tsx`
- **Image preview component**: `apps/client/src/layers/features/chat/ui/message/FileAttachmentPreview.tsx`
- **Integration point**: `apps/client/src/layers/features/chat/ui/message/UserMessageContent.tsx` — detect prefix in the `default` render branch, call the parser, conditionally render chips above text

The `UserMessageContent.tsx` default return (line 42) currently does:

```tsx
return <div className="break-words whitespace-pre-wrap">{message.content}</div>;
```

It should become:

```tsx
const parsed = parseFilePrefix(message.content);
if (parsed) {
  return (
    <div className="flex flex-col gap-2">
      <FileAttachmentList paths={parsed.paths} sessionId={sessionId} />
      {parsed.text && <div className="break-words whitespace-pre-wrap">{parsed.text}</div>}
    </div>
  );
}
return <div className="break-words whitespace-pre-wrap">{message.content}</div>;
```

---

## Sources & Evidence

- Claude.ai file attachment behavior: documented via [Uploading files to Claude | Claude Help Center](https://support.claude.com/en/articles/8241126-uploading-files-to-claude); visual pattern inferred from product use
- ChatGPT file attachment UI: described in [ChatGPT File Upload and Reading Capabilities | DataStudios](https://www.datastudios.org/post/chatgpt-file-upload-and-reading-capabilities-full-report-on-file-types-supported-formats-processi)
- Slack file rendering details (image preview cutoff at 25,000px, doc card with icon/filename/size/download): [Add files to Slack | Slack Help](https://slack.com/help/articles/201330736-Add-files-to-Slack) and [Working with files | Slack Developer Docs](https://docs.slack.dev/messaging/working-with-files/)
- Discord attachment UI: from product knowledge; image constraints in [Discord API documentation](https://discord.com/developers/docs/reference)
- Azure Communication Services text-parsing approach to file attachments embedded in chat messages: [Azure Communication Service - Chat with File Sharing | Medium](https://manishsaluja.medium.com/azure-communication-service-chat-with-file-sharing-f2acbdf2acbe)
- Stream Chat SDK `Attachment` component and `FileAttachment.tsx` file card pattern: [Attachments - React Chat Messaging Docs | Stream](https://getstream.io/chat/docs/sdk/react/components/message-components/attachment/)
- assistant-ui `UserMessageAttachments` component and attachment adapter pattern: [assistant-ui GitHub](https://github.com/assistant-ui/assistant-ui); [January 2025 Changelog | assistant-ui](https://www.assistant-ui.com/blog/2025-01-31-changelog)
- Chip vs badge vs pill design semantics: [Chip UI Design: Best practices | Mobbin](https://mobbin.com/glossary/chip); [Badges vs. Pills vs. Chips vs. Tags | Smart Interface Design Patterns](https://smart-interface-design-patterns.com/articles/badges-chips-tags-pills/)
- Inline comment on file rendering: current DorkOS `ChatPanel.tsx` line 61–62 defines the exact prefix format; `UserMessageContent.tsx` line 42 is the integration point
- Prior internal research: [File Upload: React Drag-Drop + Express Multipart](./20260309_upload_files_react_express.md) — confirmed path-injection approach, `{cwd}/.dork/.temp/uploads/` storage location
- Prior internal research: [Chat Bubble UI CSS Patterns](./20260310_chat_bubble_ui_css_patterns.md) — user message bubble structure, `ml-auto`, max-width patterns applicable to attachment layout

## Research Gaps & Limitations

- Claude.ai and ChatGPT source code is not inspectable; file attachment UI descriptions are inferred from product observation and documentation.
- A server-side endpoint for serving uploaded files (`GET /api/sessions/:id/uploads/:filename`) would be needed for image thumbnail rendering in the web client. The DirectTransport (Obsidian plugin) can read files from disk directly. This server route was not part of existing research.
- Whether Claude Code agent correctly processes the file path when the prefix uses relative paths vs. absolute paths was not re-verified in this research (prior research noted this uncertainty).

## Search Methodology

- Searches performed: 12
- Most productive terms: "Claude.ai file upload attachment rendered in conversation", "Slack file attachment rendered message thread file icon", "chat UI file attachment display image inline preview document file card UX pattern"
- Primary sources: official help documentation, Stream Chat SDK docs, assistant-ui GitHub, product knowledge
