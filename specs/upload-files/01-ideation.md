---
slug: upload-files
number: 106
created: 2026-03-09
status: ideation
---

# Upload Files

**Slug:** upload-files
**Author:** Claude Code
**Date:** 2026-03-09
**Branch:** preflight/upload-files

---

## 1) Intent & Assumptions

- **Task brief:** Enable file uploads in the chat interface via two mechanisms: (1) drag-and-drop files onto ChatInputContainer with a visual "Drop Files Here" overlay, and (2) a dedicated upload button in the chat input area. Uploaded files are stored in the session's working directory under `.dork/.temp/uploads/`. File paths are injected into the message text so the Claude Code agent can read them with filesystem tools.
- **Assumptions:**
  - Files are uploaded to the DorkOS Express server, which saves them to the session's working directory
  - The Claude Code agent reads uploaded files via its existing filesystem tools — no base64 encoding or Anthropic Files API needed
  - File paths are injected into the message on submit (not as separate content blocks)
  - The existing Transport interface pattern (hexagonal architecture) is extended with an `uploadFiles()` method
  - Upload configuration (allowed types, max size) is managed through the existing DorkOS config system (`~/.dork/config.json` + local overrides)
- **Out of scope:**
  - File preview/thumbnails in chat messages
  - File content parsing or extraction before sending
  - Multi-session file sharing
  - Anthropic Files API integration (beta, unnecessary for local agent sessions)
  - Image resizing or compression before upload
  - Rich content blocks in Transport.sendMessage (files are referenced as text paths)

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx`: Container orchestrating ChatInput + autocomplete palettes. This is where drag-drop handlers and the upload button will be added.
- `apps/client/src/layers/features/chat/ui/ChatInput.tsx`: Textarea component with focus management, keyboard event handling, and imperativeHandle. Upload button goes adjacent to this.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: Main chat orchestrator — manages session state, messages, input, file listing. Will wire up file state to ChatInputContainer.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Handles message submission via Transport. `handleSubmit` sends content via `transport.sendMessage()` — file paths will be prepended to message content here.
- `apps/client/src/layers/features/files/model/use-files.ts`: React Query hook for listing files in a directory. Pattern reference for the new upload mutation.
- `packages/shared/src/transport.ts`: Transport interface defining all API methods. Will add `uploadFiles()` method.
- `apps/client/src/layers/shared/lib/transport/index.ts`: HttpTransport implementation — will implement FormData POST for uploads.
- `apps/server/src/routes/files.ts`: Existing file listing route — pattern reference for the new upload route.
- `apps/server/src/services/core/file-lister.ts`: File listing service. Upload handler will follow the same service extraction pattern.
- `apps/server/src/lib/dork-home.ts`: Resolves DorkOS data directory. Understanding `.dork/` directory conventions.
- `apps/server/src/lib/route-utils.ts`: `assertBoundary()` for path validation. Upload route will use this for cwd validation.
- `contributing/design-system.md`: Design system reference for button styling, spacing, colors.
- `contributing/animations.md`: Motion library patterns for the drag-drop overlay animation.
- `contributing/data-fetching.md`: TanStack Query mutation patterns for the upload mutation.
- `specs/file-autocomplete/`: Comprehensive spec for `@filename` autocomplete — documents patterns for Transport methods, server routes, React Query hooks.
- `.gitignore`: `.temp` is gitignored at any directory depth — `.dork/.temp/uploads/` is automatically excluded from git.

## 3) Codebase Map

### Primary Components/Modules

**Client-side:**
- `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx` (258 lines) — Container for ChatInput + palettes. Drag-drop zone + upload button live here.
- `apps/client/src/layers/features/chat/ui/ChatInput.tsx` (259 lines) — Textarea with focus/cursor management. Upload button placed adjacent.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` (230 lines) — Chat orchestrator. Wires uploaded file state to ChatInputContainer.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Message submission. File path injection happens before `transport.sendMessage()`.
- `apps/client/src/layers/features/chat/model/use-input-autocomplete.ts` — Coordinates palette state. Reference for keyboard interaction patterns.
- `apps/client/src/layers/features/files/ui/FilePalette.tsx` — File autocomplete dropdown. Pattern reference for file chip UI.
- `apps/client/src/layers/features/files/model/use-files.ts` — React Query hook for file listing. Pattern reference for upload mutation.

**Server-side:**
- `apps/server/src/routes/files.ts` — File listing endpoint. Pattern for new upload route.
- `apps/server/src/routes/sessions.ts` — Session endpoints. Pattern for route structure, validation, error handling.
- `apps/server/src/services/core/file-lister.ts` — File listing service. Upload handler follows same service extraction pattern.
- `apps/server/src/lib/dork-home.ts` — DorkOS data directory resolution.
- `apps/server/src/lib/route-utils.ts` — `assertBoundary()`, `sendError()` utilities.

**Shared/Cross-cutting:**
- `packages/shared/src/transport.ts` — Transport interface. Add `uploadFiles()`.
- `packages/shared/src/schemas.ts` — Zod schemas. Add upload request/response schemas.
- `apps/client/src/layers/shared/lib/transport/index.ts` — HttpTransport implementation.
- `apps/client/src/layers/shared/lib/direct-transport.ts` — DirectTransport for Obsidian plugin.

### Shared Dependencies

- **Transport interface** (hexagonal port): `sendMessage()`, `listFiles()` — add `uploadFiles()`
- **React Query** (TanStack Query): `useMutation` for upload, `useQueryClient` for cache invalidation
- **Express**: Route + multer middleware for multipart handling
- **Zod schemas**: Input validation for upload config
- **Boundary validation**: `validateBoundary()` for cwd security
- **Motion**: Animated drag-drop overlay
- **Lucide icons**: `Paperclip` for upload button, `X` for file chip removal
- **DorkOS config system**: `conf` package, `~/.dork/config.json` — upload limits configuration

### Data Flow

```
User drags file onto ChatInputContainer OR clicks paperclip button
  ↓
[Drag] Show animated "Drop Files Here" overlay via onDragEnter/onDragOver
[Button] Open native file picker via hidden <input type="file">
  ↓
On file selection: add to local state (pending files array)
  ↓
Show file chips above textarea (filename + X to remove)
  ↓
On submit: POST /api/files/upload with FormData (files + cwd)
  ↓
Express route: multer parses multipart, validates boundary, saves to {cwd}/.dork/.temp/uploads/
  ↓
Return uploaded file paths array
  ↓
Prepend file references to message text: "Please read the following uploaded files:\n- .dork/.temp/uploads/report.pdf\n- .dork/.temp/uploads/screenshot.png\n\n{user message}"
  ↓
Send enriched message via transport.sendMessage() (existing flow)
  ↓
Claude Code agent reads files via filesystem tools
```

### Feature Flags/Config

- **Upload config in `~/.dork/config.json`** (new):
  - `uploads.maxFileSize` — max bytes per file (default: 10MB)
  - `uploads.maxFiles` — max files per upload (default: 10)
  - `uploads.allowedTypes` — MIME type allowlist (default: `["*/*"]` — all types)
- **Local override**: `{cwd}/.dork/config.json` can restrict/override global upload settings
- **Existing**: `cwd` parameter for all file operations, `validateBoundary()` enforcement

### Potential Blast Radius

- **Direct changes**: ~12 files
  - `ChatInputContainer.tsx` — drag handlers, overlay UI, upload button, file chips
  - `ChatInput.tsx` — minor: accept ref for file input trigger, adjust layout
  - `ChatPanel.tsx` — wire upload state
  - `use-chat-session.ts` — file path injection before submit
  - `transport.ts` — add `uploadFiles()` to interface
  - `HttpTransport` — implement FormData POST
  - `DirectTransport` — implement upload for Obsidian
  - New: `apps/server/src/routes/uploads.ts` — upload route
  - New: `apps/server/src/services/core/upload-handler.ts` — file save service
  - `packages/shared/src/schemas.ts` — upload schemas
  - Config schema updates for upload settings
  - New: `apps/client/src/layers/features/chat/model/use-file-upload.ts` — upload mutation hook
- **Indirect**: 2-3 files (components importing ChatInputContainer, server route registration)
- **Tests**: 4-5 new test files (upload handler service, upload route, upload hook, ChatInputContainer drag behavior)

## 5) Research

### Potential Solutions

**1. react-dropzone + multer + path injection (Recommended)**
- Description: `useDropzone` on ChatInputContainer for drag-drop + a paperclip button for file selection. Files uploaded via `POST /api/files/upload` (multer, disk storage to `{cwd}/.dork/.temp/uploads/`). File paths injected as text into the message before submit.
- Pros:
  - No change to `sendMessage` signature — files are just text references
  - Files stay local in the project directory — agent reads them naturally
  - react-dropzone handles all cross-browser DnD complexity (~10KB)
  - multer is battle-tested for Express file uploads
  - Works for all file types Claude Code can read
- Cons:
  - New client dependency (react-dropzone)
  - Files persist in `.dork/.temp/uploads/` unless pruned
- Complexity: Low
- Maintenance: Low

**2. Native HTML5 DnD + multer + path injection**
- Description: Same server approach but raw `onDragEnter`/`onDragOver`/`onDragLeave`/`onDrop` events instead of react-dropzone.
- Pros: Zero additional client dependency
- Cons: ~60 lines of DnD boilerplate, `dragCounter` ref needed for child enter/leave, cross-browser quirks
- Complexity: Medium
- Maintenance: Medium

**3. react-dropzone + multer + Anthropic Files API**
- Description: Upload files to Anthropic's Files API, reference by `file_id` in multimodal content blocks.
- Pros: Rich content block support for PDFs/images
- Cons: Changes `Transport.sendMessage` signature, extra network round-trip, API still in beta, files on Anthropic servers (not local-first)
- Complexity: High
- Maintenance: High

**4. react-dropzone + busboy (streaming)**
- Description: Bypass multer, use busboy directly for streaming writes.
- Pros: Fine-grained stream control
- Cons: More server code for no practical benefit (loopback uploads are fast); multer uses busboy internally
- Complexity: Medium
- Maintenance: Medium

### Security Considerations
- Sanitize filenames: `path.basename()` + strip unsafe characters + UUID prefix for uniqueness
- `cwd` parameter must pass through `validateBoundary()` before constructing upload directory path
- Set multer limits: `fileSize: 10MB`, `files: 10` (configurable via DorkOS config)
- Apply `express-rate-limit` to uploads endpoint
- Never trust client-provided `Content-Type` — server-side validation as defense-in-depth

### Performance Considerations
- Loopback uploads have negligible latency — progress bars are a UX nicety, not a requirement
- Upload multiple files in parallel with `Promise.all()`
- For V1, skip client-side image compression — can add later if needed

### Recommendation
**react-dropzone + multer + path injection** — simplest approach, aligned with DorkOS's local-first philosophy. Claude Code agents already have filesystem tools. No changes needed to the core `Transport.sendMessage` interface. Only new surface: one Transport method (`uploadFiles`) and one Express route (`POST /api/files/upload`).

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | File storage location | `{cwd}/.dork/.temp/uploads/` | `.temp` is already in `.gitignore` and matches at any directory depth, so uploads are auto-excluded from git. Lives inside `.dork/` following DorkOS conventions. Signals ephemeral nature. |
| 2 | Upload button placement | Left of textarea, inline (paperclip icon) | Standard pattern used by ChatGPT, Claude.ai, Slack, iMessage. Discoverable without cluttering the send area. |
| 3 | File display before sending | File chips above textarea | Filename badges with X to remove. File paths injected into message on submit, invisible to user. Clean UX pattern from Claude.ai and ChatGPT. |
| 4 | File type restrictions | Configurable via DorkOS config, default all types | `uploads.allowedTypes`, `uploads.maxFileSize`, `uploads.maxFiles` in `~/.dork/config.json` (global), overridable by `{cwd}/.dork/config.json` (local). Defaults: all types, 10MB, 10 files. Follows existing config precedence system. |
