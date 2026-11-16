# Task Breakdown: File Uploads in Chat

Generated: 2026-03-09
Source: specs/upload-files/02-specification.md
Last Decompose: 2026-03-09

## Overview

This task breakdown implements file uploads in DorkOS chat across three phases: server foundation (shared types, upload service, Express route), transport layer (Transport interface, HttpTransport with XHR progress, DirectTransport with fs), and client UI (useFileUpload hook, FileChipBar component, ChatInput paperclip button, ChatInputContainer dropzone, ChatPanel wiring with path injection).

**Total tasks:** 9
**Phases:** 3

---

## Phase 1: Server Foundation

### Task 1.1: Add shared types, Zod schemas, and config schema for file uploads

- **ID:** 1.1
- **Size:** Small | **Priority:** High
- **Dependencies:** None

Add `UploadResult`, `UploadProgress` types and `UploadResultSchema`, `UploadResponseSchema`, `UploadProgressSchema` Zod schemas to `packages/shared/src/schemas.ts` and `types.ts`. Add `uploads` config section to `UserConfigSchema` in `config-schema.ts` with defaults: `maxFileSize` = 10MB, `maxFiles` = 10, `allowedTypes` = `['*/*']`.

### Task 1.2: Create upload-handler service with filename sanitization and multer factory

- **ID:** 1.2
- **Size:** Medium | **Priority:** High
- **Dependencies:** 1.1

Install `multer` + `@types/multer` in `apps/server`. Create `apps/server/src/services/core/upload-handler.ts` with `sanitizeFilename()` (strips path components, replaces unsafe chars, adds UUID prefix), `getUploadDir()`, `ensureUploadDir()`, and `createMulterMiddleware()` factory that accepts dynamic config per-request. Write unit tests.

### Task 1.3: Create POST /api/uploads route with boundary validation and register in app.ts

- **ID:** 1.3
- **Size:** Medium | **Priority:** High
- **Dependencies:** 1.1, 1.2

Create `apps/server/src/routes/uploads.ts` with `POST /` handler that extracts `cwd` from query params, validates via `validateBoundary()`, configures multer dynamically from config manager, and returns `UploadResult[]`. Register at `/api/uploads` in `app.ts`. Write route tests covering: missing cwd (400), no files (400), boundary violation (403), file too large (400), valid upload (200).

---

## Phase 2: Transport Layer

### Task 2.1: Add uploadFiles method to Transport interface and mock transport

- **ID:** 2.1
- **Size:** Small | **Priority:** High
- **Dependencies:** 1.1

Add `uploadFiles(files, cwd, onProgress?)` to `Transport` interface in `packages/shared/src/transport.ts`. Add `uploadFiles: vi.fn().mockResolvedValue([])` to `createMockTransport()` in `packages/test-utils/src/mock-factories.ts`.

### Task 2.2: Implement uploadFiles in HttpTransport with XHR progress tracking

- **ID:** 2.2
- **Size:** Small | **Priority:** High
- **Dependencies:** 2.1
- **Parallel with:** 2.3

Implement `uploadFiles()` in `HttpTransport` using `XMLHttpRequest` (not `fetch`) because the Fetch API lacks upload progress events. Sends `POST /api/uploads?cwd=<encoded>` with `FormData`. Fires `onProgress({ loaded, total, percentage })` via `xhr.upload.addEventListener('progress', ...)`.

### Task 2.3: Implement uploadFiles in DirectTransport with Node.js fs

- **ID:** 2.3
- **Size:** Small | **Priority:** High
- **Dependencies:** 2.1
- **Parallel with:** 2.2

Implement `uploadFiles()` in `DirectTransport` using Node.js `fs/promises.writeFile()`. Creates `{cwd}/.dork/.temp/uploads/` directory, sanitizes filenames (same logic as server), writes files from `File.arrayBuffer()`. Progress callback accepted but not invoked (local writes are instant).

---

## Phase 3: Client UI

### Task 3.1: Create useFileUpload hook for file upload state management

- **ID:** 3.1
- **Size:** Medium | **Priority:** High
- **Dependencies:** 2.1
- **Parallel with:** 3.2

Install `react-dropzone` in `apps/client`. Create `apps/client/src/layers/features/chat/model/use-file-upload.ts` with `PendingFile` interface and `useFileUpload()` hook. Returns `{ pendingFiles, addFiles, removeFile, clearFiles, uploadAndGetPaths, hasPendingFiles, isUploading }`. Uses `useMutation` from TanStack Query. `uploadAndGetPaths()` uploads pending files and returns `savedPath[]`. Write hook tests.

### Task 3.2: Create FileChipBar component for pending file display

- **ID:** 3.2
- **Size:** Small | **Priority:** High
- **Dependencies:** 3.1
- **Parallel with:** 3.1

Create `apps/client/src/layers/features/chat/ui/FileChipBar.tsx`. Renders horizontal bar of file chips with `AnimatePresence` animations. Shows `Loader2` spinner during upload, `AlertCircle` on error, `FileIcon` for pending. Displays filename (truncated), progress percentage, and remove button with `aria-label`. Write component tests.

### Task 3.3: Add paperclip button to ChatInput with hidden file input

- **ID:** 3.3
- **Size:** Small | **Priority:** High
- **Dependencies:** None
- **Parallel with:** 3.1, 3.2

Add `onAttach?: (files: File[]) => void` prop to `ChatInput`. Add hidden `<input type="file" multiple>` and `Paperclip` button (from lucide-react) positioned left of the textarea. Button triggers native file picker, selected files passed to `onAttach`. Input resets after selection.

### Task 3.4: Add drag-and-drop overlay and file chips to ChatInputContainer

- **ID:** 3.4
- **Size:** Medium | **Priority:** High
- **Dependencies:** 3.1, 3.2, 3.3

Update `ChatInputContainer` props to accept `pendingFiles`, `onFilesSelected`, `onFileRemove`, `isUploading`. Add `useDropzone({ onDrop, noClick, noKeyboard })` for drag-and-drop. Render animated drag overlay (dashed border, "Drop files here") via `AnimatePresence`. Render `FileChipBar` above textarea. Pass `onAttach={onFilesSelected}` to `ChatInput`. Add clipboard paste handler for image paste support.

### Task 3.5: Wire useFileUpload into ChatPanel with transformContent for path injection

- **ID:** 3.5
- **Size:** Medium | **Priority:** High
- **Dependencies:** 3.1, 3.2, 3.3, 3.4

Initialize `useFileUpload()` in `ChatPanel`. Create `fileTransformContent` callback that chains with existing `transformContent` prop, uploads pending files via `uploadAndGetPaths()`, converts absolute paths to relative, and prepends to message: "Please read the following uploaded file(s):\n- path". Pass file upload state to `ChatInputContainer`. Update feature barrel `index.ts` with new exports.

---

## Dependency Graph

```
1.1 (shared types/schemas/config)
 |
 +---> 1.2 (upload-handler service)
 |      |
 |      +---> 1.3 (upload route + app.ts)
 |
 +---> 2.1 (Transport interface + mock)
        |
        +---> 2.2 (HttpTransport) ---|
        |                            |--- parallel
        +---> 2.3 (DirectTransport) -|
        |
        +---> 3.1 (useFileUpload hook) ---|--- parallel with 3.2
        |                                 |
        |    3.2 (FileChipBar) -----------|
        |
        +---> 3.3 (ChatInput paperclip) --- independent, parallel with 3.1/3.2
        |
        +---> 3.4 (ChatInputContainer dropzone) --- depends on 3.1, 3.2, 3.3
              |
              +---> 3.5 (ChatPanel wiring + path injection) --- depends on all Phase 3
```
