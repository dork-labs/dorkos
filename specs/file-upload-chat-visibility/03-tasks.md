# File Upload Chat History Visibility — Task Breakdown

**Spec:** [02-specification.md](02-specification.md)
**Generated:** 2026-03-10
**Mode:** Full

---

## Phase 1: Foundation

Tasks in this phase can run in parallel.

### Task 1.1: Create `parseFilePrefix` utility with unit tests

| Field             | Value |
| ----------------- | ----- |
| **Size**          | Small |
| **Priority**      | High  |
| **Dependencies**  | None  |
| **Parallel with** | 1.2   |

**Files:**

- **Create:** `apps/client/src/layers/features/chat/lib/parse-file-prefix.ts`
- **Create:** `apps/client/src/layers/features/chat/lib/__tests__/parse-file-prefix.test.ts`

**Summary:** Create a pure utility function that parses the file upload prefix from user message content. The prefix format is `"Please read the following uploaded file(s):\n- path\n\ntext"` as emitted by `ChatPanel.fileTransformContent`. The parser extracts an array of `ParsedFile` objects (path, displayName with UUID stripped, isImage flag) and the remaining text content. Returns passthrough `{ files: [], textContent: content }` for messages without the prefix.

**Tests (7):**

1. Returns empty files and original content for messages without prefix
2. Extracts single file from prefix
3. Extracts multiple files from prefix
4. Handles prefix with no message text after
5. Strips UUID prefix from filenames
6. Detects all image extensions (png, jpg, jpeg, gif, webp, svg)
7. Does not match partial prefix text

**Verify:** `pnpm vitest run apps/client/src/layers/features/chat/lib/__tests__/parse-file-prefix.test.ts`

---

### Task 1.2: Add GET endpoint to uploads route with tests

| Field             | Value  |
| ----------------- | ------ |
| **Size**          | Medium |
| **Priority**      | High   |
| **Dependencies**  | None   |
| **Parallel with** | 1.1    |

**Files:**

- **Modify:** `apps/server/src/routes/uploads.ts` (add `import path from 'path'` + GET route)
- **Modify:** `apps/server/src/routes/__tests__/uploads.test.ts` (add GET describe block)

**Summary:** Add `GET /api/uploads/:filename?cwd=...` to the existing uploads router. Serves uploaded files for image thumbnail rendering. Uses `path.basename()` to prevent directory traversal, `validateBoundary()` for cwd validation, and verifies the resolved path is within the upload directory. Returns the file via `res.sendFile()` with automatic Content-Type headers.

**Tests (4):**

1. Returns 400 when cwd is missing
2. Returns 404 when file does not exist
3. Returns 403 when cwd fails boundary validation
4. Prevents directory traversal via filename (encoded `../` in URL)

**Verify:** `pnpm vitest run apps/server/src/routes/__tests__/uploads.test.ts`

---

## Phase 2: Client UI

Tasks in this phase depend on Phase 1 completion.

### Task 2.1: Create `FileAttachmentList` component with tests

| Field             | Value  |
| ----------------- | ------ |
| **Size**          | Medium |
| **Priority**      | High   |
| **Dependencies**  | 1.1    |
| **Parallel with** | —      |

**Files:**

- **Create:** `apps/client/src/layers/features/chat/ui/message/FileAttachmentList.tsx`
- **Create:** `apps/client/src/layers/features/chat/ui/message/__tests__/FileAttachmentList.test.tsx`

**Summary:** Create a component that renders uploaded file attachments. Images get inline thumbnails (`max-h-[120px] max-w-[200px]`, `rounded-lg border border-border/50`, `loading="lazy"`). Non-image files get styled chips (`bg-muted rounded-md px-2 py-1 text-xs`) matching `FileChipBar` styling. Uses `useAppStore` for `selectedCwd` to construct image URLs (`/api/uploads/{filename}?cwd=...`). Includes a `getFileIcon` helper mapping extensions to lucide icons (FileText, FileCode, FileSpreadsheet, FileImage, FileIcon).

**Tests (5):**

1. Renders nothing when files array is empty
2. Renders image thumbnail for image files
3. Renders file chip with icon for non-image files
4. Renders mixed image and document attachments
5. Truncates long filenames (verifies `truncate` CSS class)

**Verify:** `pnpm vitest run apps/client/src/layers/features/chat/ui/message/__tests__/FileAttachmentList.test.tsx`

---

### Task 2.2: Update `UserMessageContent` to parse and render file attachments

| Field             | Value    |
| ----------------- | -------- |
| **Size**          | Small    |
| **Priority**      | High     |
| **Dependencies**  | 1.1, 2.1 |
| **Parallel with** | —        |

**Files:**

- **Modify:** `apps/client/src/layers/features/chat/ui/message/UserMessageContent.tsx`

**Summary:** Update the default branch (plain text messages) to call `parseFilePrefix(message.content)` and conditionally render `FileAttachmentList` above the text. Command and compaction branches are unchanged. Messages without file prefixes render identically to before (parser returns passthrough). File-only messages (no text after prefix) render only the attachment list without a text div.

**Changes:**

1. Add imports: `parseFilePrefix` from `../../lib/parse-file-prefix`, `FileAttachmentList` from `./FileAttachmentList`
2. Update TSDoc to mention file attachment detection
3. Replace final `return <div>...{message.content}</div>` with parsed version

**Verify:** `pnpm typecheck && pnpm lint`

---

## Phase 3: Documentation

### Task 3.1: Update API reference with GET uploads endpoint

| Field             | Value  |
| ----------------- | ------ |
| **Size**          | Small  |
| **Priority**      | Medium |
| **Dependencies**  | 1.2    |
| **Parallel with** | —      |

**Files:**

- **Modify:** `contributing/api-reference.md`

**Summary:** Add `### GET /api/uploads/:filename` subsection under the existing File Uploads section. Documents path parameters (filename), query parameters (cwd), success response (file content with auto Content-Type), error responses (400/403/404/500), and security measures (path.basename traversal prevention, boundary validation, upload directory containment check).

**Verify:** Visual review of markdown formatting consistency with existing endpoint docs.

---

## Dependency Graph

```
1.1 (parseFilePrefix) ──┬──> 2.1 (FileAttachmentList) ──> 2.2 (UserMessageContent)
                        │
1.2 (GET endpoint) ─────┼──> 3.1 (API docs)
                        │
   [1.1 and 1.2 run in parallel]
```

## Verification

After all tasks complete:

```bash
pnpm test -- --run    # All tests pass
pnpm typecheck        # No type errors
pnpm lint             # No lint errors
```
